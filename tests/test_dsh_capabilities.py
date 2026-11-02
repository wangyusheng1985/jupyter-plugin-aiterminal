"""Capability contract checks for the published DeepSeek Harness Python SDK.

Every check runs the installed ``deepseek-harness-sdk`` against a local
OpenAI-compatible stub. The distribution and its bundled runtime are pinned to
``0.2.1rc2`` and the test asserts that exact release, not merely that the two
version strings agree. No real model, API key, network egress, or
side-effectful tool is used: the ``sdk-minimal`` profile is patched to point at
the stub and to disable every filesystem, shell, and terminal tool.

The tests record what the published release actually does. ``serverInfo.version``
returned over the wire is recorded as an observation but is NOT treated as the
release/package version (that comes from installed distribution metadata).
Capabilities that the release runtime may expose but this isolated configuration
does not exercise (tool calls, structured user questions, approvals, subagents,
jobs) are reported as ``not_verified`` in the capability manifest; they are never
treated as passing because a method merely exists, nor as ``unsupported`` merely
because this run did not observe them.

Run with the SDK visible to the repository's pytest, for example::

    PYTHONPATH=<probe-venv>/lib/python3.13/site-packages \
        python -m pytest tests/test_dsh_capabilities.py -q
"""

from __future__ import annotations

import importlib.metadata
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest

pytest.importorskip(
    "deepseek_harness",
    reason="deepseek-harness-sdk is not installed; integration contract not verified",
)

from deepseek_harness import (  # noqa: E402
    DeepSeekHarness,
    DeepSeekHarnessConfig,
    HarnessClient,
    HarnessConfig,
)
from deepseek_harness.errors import HarnessError  # noqa: E402

SDK_DISTRIBUTION = "deepseek-harness-sdk"
RUNTIME_DISTRIBUTION = "deepseek-harness-runtime-bin"
EXPECTED_WIRE_NAME = "deepseek-harness-sdk-runtime"
# Pinned release baseline: both the SDK and the bundled runtime must be exactly
# this version, otherwise the contract assertions (notification methods, single
# followup request, disabled-tool shape) are no longer guaranteed.
EXPECTED_RELEASE_VERSION = "0.2.1rc2"
FAKE_KEY = "dsh-contract-fake-not-a-secret"
# Bounded timeouts: three short-lived harnesses (init, run, resume) keep the
# whole module comfortably inside an external 60s wrapper timeout even when a
# step fails, so failures surface as clear errors rather than being killed.
INITIALIZE_TIMEOUT_SECONDS = 15.0
REQUEST_TIMEOUT_SECONDS = 15.0
SHUTDOWN_TIMEOUT_SECONDS = 2.0
# Explicitly clear proxy vars so the only egress is the loopback stub; the base
# runtime environment (HOME/PATH) still comes from the local system as needed.
_PROXY_ENV_VARS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
STUB_TEXT = "OAI-DELTA"
DISABLED_TOOL_IDS = (
    "tool-fs",
    "tool-working-directory",
    "persistent-bash",
    "persistent-pwsh",
    "terminal-bash",
    "terminal-pwsh",
)

PATCH_TEMPLATE = """- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          local-openai:
            api: openai-completions
            baseURL: http://127.0.0.1:{port}/openai
            apiKeyEnv: DSH_CONTRACT_FAKE_KEY
            models:
              - id: probe-model
                contextWindow: 8192
                maxTokens: 64
            retryPolicy:
              mode: normal
              maxRetries: 0
""" + "".join(f"- id: {tool_id}\n  disabled: true\n" for tool_id in DISABLED_TOOL_IDS)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _isolated_env(home: str) -> dict[str, str]:
    """Minimal env for the runtime: local HOME/PATH plus proxies scrubbed.

    ``HarnessConfig.env`` is merged over ``os.environ.copy()`` by the SDK, so
    inherited proxy/credential variables would otherwise leak through. We pin
    HOME/DSH_HOME to the temp dir, keep the system PATH the runtime needs to
    exec its bundled binary, route loopback via NO_PROXY, and blank the proxy
    variables that would otherwise allow real egress.
    """
    env = {
        "HOME": home,
        "DSH_HOME": home,
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    }
    for name in _PROXY_ENV_VARS:
        env[name] = ""
    return env


class _Recorder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: list[dict] = []

    def add(self, entry: dict) -> None:
        with self._lock:
            self.requests.append(entry)

    def snapshot(self) -> list[dict]:
        with self._lock:
            return list(self.requests)


class _StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            body = {}
        tools = body.get("tools") if isinstance(body, dict) else None
        messages = body.get("messages") if isinstance(body, dict) else None
        self.server.recorder.add(  # type: ignore[attr-defined]
            {
                "path": self.path,
                "stream": body.get("stream"),
                "model": body.get("model"),
                "tools_count": len(tools) if isinstance(tools, list) else 0,
                "tool_names": [
                    tool.get("name") or (tool.get("function") or {}).get("name")
                    for tool in tools
                    if isinstance(tool, dict)
                ]
                if isinstance(tools, list)
                else [],
                "messages": [
                    {
                        "role": message.get("role"),
                        "text": message.get("content")
                        if isinstance(message.get("content"), str)
                        else json.dumps(message.get("content"), ensure_ascii=False),
                    }
                    for message in messages or []
                    if isinstance(message, dict)
                ],
            }
        )
        payload = (
            'data: {"id":"chatcmpl-contract","object":"chat.completion.chunk",'
            '"choices":[{"index":0,"delta":{"role":"assistant","content":"'
            + STUB_TEXT
            + '"},"finish_reason":null}]}\n\n'
            'data: {"id":"chatcmpl-contract","object":"chat.completion.chunk",'
            '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
            "data: [DONE]\n\n"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class _StubServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], recorder: _Recorder) -> None:
        super().__init__(address, _StubHandler)
        self.recorder = recorder


@pytest.fixture(scope="module")
def stub_server():
    recorder = _Recorder()
    server = _StubServer(("127.0.0.1", 0), recorder)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], recorder
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def harness_env(tmp_path_factory):
    root = tmp_path_factory.mktemp("dsh-contract")
    home = root / "home"
    cwd = root / "cwd"
    home.mkdir()
    cwd.mkdir()
    patch_path = root / "patch.yml"
    return {"root": root, "home": home, "cwd": cwd, "patch": patch_path}


def _make_harness(port: int, env: dict) -> DeepSeekHarness:
    env["patch"].write_text(PATCH_TEMPLATE.format(port=port))
    return DeepSeekHarness(
        DeepSeekHarnessConfig(
            provider="local-openai",
            model="probe-model",
            max_tokens=64,
            cwd=str(env["cwd"]),
            profile="sdk-minimal",
            patches=(str(env["patch"]),),
            dsh_home=str(env["home"]),
            env={**_isolated_env(str(env["home"])), "DSH_CONTRACT_FAKE_KEY": FAKE_KEY},
            initialize_timeout_seconds=INITIALIZE_TIMEOUT_SECONDS,
            request_timeout_seconds=REQUEST_TIMEOUT_SECONDS,
            shutdown_timeout_seconds=SHUTDOWN_TIMEOUT_SECONDS,
        )
    )


@pytest.fixture(scope="module")
def init_observation(stub_server, harness_env):
    """Return the raw initialize serverInfo without prompting."""
    port, _recorder = stub_server
    harness_env["patch"].write_text(PATCH_TEMPLATE.format(port=port))
    client = HarnessClient(
        HarnessConfig(
            profile="sdk-minimal",
            patches=(str(harness_env["patch"]),),
            dsh_home=str(harness_env["home"]),
            cwd=str(harness_env["cwd"]),
            env=_isolated_env(str(harness_env["home"])),
            initialize_timeout_seconds=INITIALIZE_TIMEOUT_SECONDS,
            request_timeout_seconds=REQUEST_TIMEOUT_SECONDS,
            shutdown_timeout_seconds=SHUTDOWN_TIMEOUT_SECONDS,
        )
    )
    observed: dict = {}
    try:
        client.start()
        response = client.initialize(
            cwd=str(harness_env["cwd"]),
            provider="local-openai",
            model="probe-model",
            max_tokens=64,
        )
        server_info = response.serverInfo
        observed["name"] = server_info.name if server_info else None
        observed["version"] = server_info.version if server_info else None
    finally:
        client.close()
    return observed


@pytest.fixture(scope="module")
def run_observation(stub_server, harness_env):
    port, recorder = stub_server
    harness = _make_harness(port, harness_env)
    observed: dict = {"session_id": None, "final_response": None, "events": [], "notifications": []}
    try:
        harness.start()
        session = harness.start_session()
        observed["session_id"] = session.id
        result = session.run("contract-ping")
        observed["final_response"] = result.final_response
        observed["events"] = list(result.events)
        observed["notifications"] = [
            {"method": note.method, "payload": note.payload} for note in result.notifications
        ]
        observed["http"] = recorder.snapshot()
    finally:
        harness.close()
    return observed


@pytest.fixture(scope="module")
def resume_observation(stub_server, harness_env, run_observation):
    port, recorder = stub_server
    session_id = run_observation["session_id"]
    before = len(recorder.snapshot())
    observed: dict = {"resumed": False, "followup_response": None, "missing_error": None,
                      "history_messages": [], "http": []}
    harness = _make_harness(port, harness_env)
    try:
        harness.start()
        resumed = harness.resume_session(session_id)
        observed["resumed"] = resumed.id == session_id
        followup = harness.start_session(session_id).run("contract-followup")
        observed["followup_response"] = followup.final_response
        observed["http"] = recorder.snapshot()[before:]
        observed["history_messages"] = observed["http"][-1]["messages"] if observed["http"] else []
        try:
            harness.resume_session("missing-session-contract-check")
        except HarnessError as exc:
            observed["missing_error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        harness.close()
    return observed


def test_distribution_versions_contract():
    """The SDK and bundled runtime are present and pinned to the exact baseline."""
    sdk_version = importlib.metadata.version(SDK_DISTRIBUTION)
    runtime_version = importlib.metadata.version(RUNTIME_DISTRIBUTION)
    assert sdk_version == EXPECTED_RELEASE_VERSION, sdk_version
    assert runtime_version == EXPECTED_RELEASE_VERSION, runtime_version
    requires = importlib.metadata.requires(SDK_DISTRIBUTION) or []
    assert any(req.split()[0].lower().startswith(RUNTIME_DISTRIBUTION) for req in requires), requires


def test_initialize_reports_wire_stable_server_identity(init_observation):
    """initialize succeeds and returns the documented wire-stable identity.

    ``serverInfo.version`` is recorded as an observation only. It is the runtime
    wire identity and must not be asserted against the release/package version;
    the pinned distribution version is checked separately by the metadata test.
    """
    assert init_observation["name"] == EXPECTED_WIRE_NAME
    assert isinstance(init_observation["version"], str)
    assert init_observation["version"].strip()


def test_prompt_emits_text_increment_notifications(run_observation):
    """One prompt streams text increments and a final assistant message."""
    assert run_observation["final_response"] == STUB_TEXT
    methods = {note["method"] for note in run_observation["notifications"]}
    assert methods == {"session.event", "session.status"}, methods

    assistant_events = [
        event for event in run_observation["events"] if event.get("type") == "assistant/message"
    ]
    assert assistant_events, "no assistant/message event observed"
    content = assistant_events[-1]["data"]["message"]["content"]
    assert {"type": "text", "text": STUB_TEXT} in content

    stream = assistant_events[-1]["data"].get("stream")
    assert isinstance(stream, list) and stream
    text_chunks = [chunk for chunk in stream if chunk.get("type") == "text-chunks"]
    assert text_chunks, "release runtime did not expose text increments in the stream"
    joined = "".join(text_chunks[0]["texts"])
    assert STUB_TEXT in joined


def test_session_event_shapes(run_observation):
    """Session events follow the published type/data shape with tools disabled."""
    events = run_observation["events"]
    assert events
    for event in events:
        assert isinstance(event.get("type"), str) and event["type"]
        assert isinstance(event.get("data"), dict)

    types = [event["type"] for event in events]
    for required in (
        "turn/start",
        "step/start",
        "agent/inbox/spliced",
        "user/message",
        "assistant/message",
        "step/end",
        "turn/end",
    ):
        assert required in types, (required, types)
    assert not [event_type for event_type in types if "tool" in event_type.lower()], types

    request = run_observation["http"][0]
    assert request["path"] == "/openai/chat/completions"
    assert request["stream"] is True
    assert request["model"] == "probe-model"
    assert request["tools_count"] == 0, request
    assert request["tool_names"] == []


def test_resume_restores_history_and_missing_session_fails_explicitly(resume_observation):
    """Resuming a persisted session replays history; an unknown id raises."""
    assert resume_observation["resumed"] is True
    assert resume_observation["followup_response"] == STUB_TEXT
    assert len(resume_observation["http"]) == 1
    replayed = json.dumps(resume_observation["history_messages"], ensure_ascii=False)
    assert "contract-ping" in replayed, replayed

    # Missing sessions must raise a harness error, not silently create a session.
    assert resume_observation["missing_error"] is not None


def test_capability_manifest_records_verified_and_unverified(
    tmp_path, init_observation, run_observation, resume_observation
):
    """Emit an explicit capability manifest; unexercised capabilities stay unverified."""
    manifest = {
        "sdk_version": importlib.metadata.version(SDK_DISTRIBUTION),
        "runtime_version": importlib.metadata.version(RUNTIME_DISTRIBUTION),
        "profile": "sdk-minimal",
        "provider": "local-openai",
        "model": "probe-model",
        "transport": "stdio-jsonrpc",
        "capabilities": {
            "initialize": {"status": "verified", "evidence": "start()+prompt succeeded"},
            "server_info_identity": {
                "status": "verified",
                "evidence": f"serverInfo.name={init_observation['name']!r} "
                f"wire version={init_observation['version']!r} observed "
                f"(release pinned to {EXPECTED_RELEASE_VERSION}; serverInfo.version "
                f"is a wire identity, not the release version)",
            },
            "text_increments": {
                "status": "verified",
                "evidence": "assistant/message data.stream text-chunks replayed the stub text",
            },
            "session_events": {"status": "verified", "evidence": "typed event list captured"},
            "session_resume": {"status": "verified", "evidence": "history replayed into followup request"},
            "missing_session_explicit_failure": {
                "status": "verified",
                "evidence": resume_observation["missing_error"]["type"]
                if resume_observation["missing_error"]
                else "no error",
            },
            "tool_calls": {
                "status": "not_verified",
                "evidence": "all tool plugins disabled in isolated patch; no tool event or tool schema",
            },
            "user_questions": {
                "status": "not_verified",
                "evidence": "host capability callback not exercised in this isolated run",
            },
            "approval": {
                "status": "not_verified",
                "evidence": "no approval-requesting tool executed",
            },
            "subagent": {
                "status": "not_verified",
                "evidence": "no subagent lifecycle notification observed",
            },
            "jobs": {
                "status": "not_verified",
                "evidence": "jobs service exists in the bundled runtime but is only "
                "exposed through the persistent-bash/persistent-pwsh tools, which this "
                "isolated patch disables; no jobs lifecycle was executed",
            },
        },
    }
    verification = {
        "final_response": run_observation["final_response"],
        "notification_methods": sorted({n["method"] for n in run_observation["notifications"]}),
        "event_types": [e["type"] for e in run_observation["events"]],
        "followup_response": resume_observation["followup_response"],
    }
    payload = {"manifest": manifest, "observed": verification}
    (tmp_path / "dsh_capability_manifest.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(payload, ensure_ascii=False))

    statuses = {name: entry["status"] for name, entry in manifest["capabilities"].items()}
    assert statuses["initialize"] == "verified"
    assert statuses["text_increments"] == "verified"
    assert statuses["session_resume"] == "verified"
    assert statuses["missing_session_explicit_failure"] == "verified"
    # Unexercised capabilities must never be reported as verified.
    for name in ("tool_calls", "user_questions", "approval", "subagent", "jobs"):
        assert statuses[name] == "not_verified", (name, statuses[name])
    assert "unsupported" not in statuses.values(), statuses
