"""Released-version contract probe: how the published runtime gates tool execution.

The target is the published PyPI pair ``deepseek-harness-sdk`` and
``deepseek-harness-runtime-bin`` (0.2.1rc2 when this was written), not the in-repo master
checkout. Master-only interfaces (``initialize.approvalRequests``, server->client
``approval/request``) are reference only; they are not evidence that the published runtime
offers a pre-execution permission gate the plugin can answer.

What this file proves, and what it does not:

* Normal execution control: a **schema-valid** ``bash`` call (non-empty ``description``
  and ``command``) runs inside an isolated tmp workspace and writes its marker. A normal
  workspace command does not require approval by design, so this is control evidence, not
  an "approval bypass" claim.
* Actual permission-limit deny: requesting wider ``sandbox_permissions`` is refused because
  the released runtime has no approval channel
  (``... requires approval, but no approval channel is available``). That is the real
  permission restriction, and the wider command never runs.
* No server->client ``approval/request`` arrives on the wire for either case, even though
  the session's ``approval/policy`` is ``ask``.
* The released ``initialize`` accepts an ``approvalRequests: true`` field but exposes no
  observable behaviour change, because the published ``initialize()`` has no such switch and
  no approval bridge.

Do not fabricate ``session/approval/respond``: master answers a server->client
``approval/request`` with a JSON-RPC response through the generic ``respond`` channel. The
released runtime never sends that request, so there is nothing to answer.

Set ``DSH_EVIDENCE_DIR`` to persist version-paired evidence JSON (SDK/runtime versions and
``serverInfo``); otherwise it is printed and written under a temporary directory. A stub
model answers locally; no real model, network, or key is used, and nothing outside the
throwaway tmp workspace is touched.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

DSH_SDK_SITE = os.environ.get("DSH_SDK_SITE")
if DSH_SDK_SITE:
    sys.path.insert(0, DSH_SDK_SITE)

sdk = pytest.importorskip(
    "deepseek_harness",
    reason="deepseek-harness-sdk not importable; set DSH_SDK_SITE to its site-packages",
)

from deepseek_harness.models import InitializeResponse  # noqa: E402

DEADLINE_SECONDS = 25.0
MARKER_NAME = "gate-marker.txt"
ESCALATION_MARKER_NAME = "widen.txt"
ESCALATION_ERROR_FRAGMENTS = ("requires approval", "no approval channel is available")


def _version(package: str) -> str | None:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(package)
    except PackageNotFoundError:
        return None


def _versions() -> dict[str, str | None]:
    return {
        "sdk": _version("deepseek-harness-sdk"),
        "runtime": _version("deepseek-harness-runtime-bin"),
    }


def _record_evidence(name: str, payload: dict) -> dict:
    evidence = {**_versions(), "test": name, **payload}
    directory = os.environ.get("DSH_EVIDENCE_DIR")
    base = Path(directory) if directory else Path(tempfile.mkdtemp(prefix="dsh-evidence-"))
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{name}.json"
    path.write_text(json.dumps(evidence, indent=2, default=str))
    print(f"[evidence] {path}: {json.dumps(evidence, default=str)}")
    return evidence


def _server_info(harness) -> dict[str, str | None]:
    response = harness.client.request(
        "initialize",
        {
            "cwd": str(Path(harness.config.cwd or Path.cwd()).resolve()),
            "provider": harness.config.provider,
            "model": harness.config.model,
        },
        response_model=InitializeResponse,
        timeout_seconds=10.0,
    )
    info = response.serverInfo
    return {"name": getattr(info, "name", None), "version": getattr(info, "version", None)}


def _sse(events: list[dict]) -> bytes:
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
    ).encode()


def _text_turn(text: str) -> list[dict]:
    return [
        {
            "type": "message_start",
            "message": {
                "id": "msg_stub",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "stub",
                "stop_reason": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
        {"type": "message_stop"},
    ]


def _tool_use_turn(arguments: dict) -> list[dict]:
    """One Anthropic-Messages turn that asks for a single ``bash`` tool call."""
    return [
        {
            "type": "message_start",
            "message": {
                "id": "msg_stub",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "stub",
                "stop_reason": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "tool_use", "id": "tu1", "name": "bash", "input": {}},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)},
        },
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 1}},
        {"type": "message_stop"},
    ]


class _ToolCallStubModel:
    """Local stub model: first turn asks for one tool call, later turns answer with text."""

    def __init__(self, arguments: dict) -> None:
        self.arguments = arguments
        self.hits = 0
        self._lock = threading.Lock()

    def handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        if length:
            handler.rfile.read(length)
        with self._lock:
            self.hits += 1
            first = self.hits == 1
        body = _sse(_tool_use_turn(self.arguments) if first else _text_turn("STUB_DONE"))
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)


def _serve(stub: _ToolCallStubModel) -> tuple[ThreadingHTTPServer, int]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: object) -> None:
            return

        def do_POST(self) -> None:  # noqa: N802
            stub.handle(self)

        def do_GET(self) -> None:  # noqa: N802
            self.send_response(404)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def _config(port: int, tmp_path: Path):
    home = tmp_path / "home"
    cwd = tmp_path / "cwd"
    home.mkdir()
    cwd.mkdir()
    return (
        sdk.DeepSeekHarnessConfig(
            base_url=f"http://127.0.0.1:{port}",
            api_key="stub-not-a-real-key",
            cwd=str(cwd),
            dsh_home=str(home / "dsh"),
            env={
                "HOME": str(home),
                "DEEPSEEK_API_KEY": "stub-not-a-real-key",
                "PATH": "/usr/bin:/bin",
            },
        ),
        cwd,
    )


class _TurnObservation:
    """Result of driving one stub turn while watching session events and server requests."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.incoming_requests: list[tuple[str, dict]] = []

    def event_types(self) -> list[str]:
        return [str(event.get("type")) for event in self.events]

    def event_data(self, event_type: str) -> dict | None:
        for event in self.events:
            if event.get("type") == event_type:
                data = event.get("data")
                return data if isinstance(data, dict) else None
        return None

    def tool_result_text(self) -> str:
        data = self.event_data("tool/result") or {}
        message = data.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            return ""
        return "".join(
            str(block.get("text") or "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )


def _drive_turn(harness, session_id: str, prompt: str) -> _TurnObservation:
    observation = _TurnObservation()
    client = harness.client
    stop_watch = threading.Event()
    deadline = time.monotonic() + DEADLINE_SECONDS

    def watch_server_requests() -> None:
        while not stop_watch.is_set():
            try:
                request = client.next_request()
            except BaseException:  # noqa: BLE001 - runtime close ends the watch
                return
            observation.incoming_requests.append((request.method, request.payload))

    def collect() -> None:
        with client.subscribe_session_notifications(session_id) as subscription:
            while time.monotonic() < deadline:
                notification = subscription.next()
                if notification.method == "session.event":
                    event = notification.payload.get("event")
                    if isinstance(event, dict):
                        observation.events.append(event)
                if notification.method == "session.status" and notification.payload.get("status") == "idle":
                    return

    watcher = threading.Thread(target=watch_server_requests, daemon=True)
    collector = threading.Thread(target=collect, daemon=True)
    watcher.start()
    collector.start()
    client.session_prompt(session_id, [{"type": "text", "text": prompt}])

    while time.monotonic() < deadline:
        if any(event.get("type") in ("tool/result", "turn/end") for event in observation.events):
            break
        time.sleep(0.05)
    # Give a late server request (if any) a moment to surface before stopping the watch.
    time.sleep(0.2)
    stop_watch.set()
    collector.join(timeout=2.0)
    watcher.join(timeout=2.0)
    return observation


@pytest.fixture()
def released_harness(tmp_path: Path):
    """Started released harness with a valid local stub workspace and captured serverInfo."""
    stub = _ToolCallStubModel(
        {
            "description": "create gate marker file",
            "command": f"echo gated > {MARKER_NAME}",
        }
    )
    httpd, port = _serve(stub)
    config, cwd = _config(port, tmp_path)
    harness = sdk.DeepSeekHarness(config)
    harness.start()
    try:
        yield harness, stub, cwd
    finally:
        harness.close()
        httpd.shutdown()
        httpd.server_close()


def test_released_initialize_has_no_approval_requests_switch(released_harness):
    """Published ``initialize()`` exposes no approval switch; the SDK is pinned to the release."""
    import inspect

    harness, _stub, _cwd = released_harness
    from deepseek_harness import client as sdk_client

    initialize_params = sorted(inspect.signature(sdk_client.HarnessClient.initialize).parameters)
    approval_params = [name for name in initialize_params if "approval" in name or "permission" in name]
    approval_config = sorted(
        name
        for name in sdk.DeepSeekHarnessConfig.__dataclass_fields__
        if "approval" in name or "permission" in name
    )
    evidence = _record_evidence(
        "policy-initialize-surface",
        {
            "serverInfo": _server_info(harness),
            "initializeParameters": initialize_params,
            "approvalParameters": approval_params,
            "approvalConfigFields": approval_config,
        },
    )
    assert approval_params == [], (
        f"deepseek-harness-sdk {_versions()['sdk']} now accepts approval parameters "
        f"{approval_params} in initialize(); re-probe whether a real pre-execution gate is "
        f"available. evidence={evidence}"
    )
    assert approval_config == [], (
        f"published config grew approval fields {approval_config}; re-probe. evidence={evidence}"
    )


def test_valid_bash_executes_without_approval_request(released_harness):
    """Normal execution control: a schema-valid workspace command runs; no approval is asked.

    This is not an approval-bypass claim. A normal workspace command does not require
    approval by design; the observation is that the released runtime runs it and sends no
    server->client ``approval/request`` even though ``approval/policy`` is ``ask``.
    """
    harness, stub, cwd = released_harness
    observation = _drive_turn(harness, "policy-control", "write the marker")

    event_types = observation.event_types()
    policy_events = {
        event_type: observation.event_data(event_type)
        for event_type in ("permission/preset", "sandbox/mode", "approval/policy")
    }
    evidence = _record_evidence(
        "policy-valid-bash-control",
        {
            "serverInfo": _server_info(harness),
            "stubHits": stub.hits,
            "eventTypes": event_types,
            "policyEvents": policy_events,
            "incomingRequests": observation.incoming_requests,
            "markerCreated": (cwd / MARKER_NAME).exists(),
            "toolResult": observation.tool_result_text(),
        },
    )
    assert "tool/call" in event_types, f"runtime never dispatched the tool call: {event_types}"
    assert "tool/result" in event_types, f"tool call never produced a result: {event_types}"
    assert (cwd / MARKER_NAME).exists(), (
        f"the schema-valid bash call did not run in the isolated cwd; nothing to observe. "
        f"evidence={evidence}"
    )
    assert policy_events.get("approval/policy") == {"policy": "ask"}, (
        f"released approval policy differs from 'ask': {policy_events}. evidence={evidence}"
    )
    assert observation.incoming_requests == [], (
        f"released runtime sent server->client requests during a normal workspace command: "
        f"{observation.incoming_requests}. evidence={evidence}"
    )


def test_sandbox_escalation_is_denied_without_approval_channel(tmp_path: Path):
    """Actual permission limit: wider ``sandbox_permissions`` is denied, not silently allowed.

    The escalation needs approval, the released runtime has no approval channel, and the
    wider command never runs. The escalation target stays inside the throwaway tmp workspace.
    """
    stub = _ToolCallStubModel(
        {
            "description": "widen sandbox for a harmless isolated write",
            "command": f"echo hi > {ESCALATION_MARKER_NAME}",
            "sandbox_permissions": "danger-full-access",
            "justification": "need unconfined access to verify the approval gate",
        }
    )
    httpd, port = _serve(stub)
    config, cwd = _config(port, tmp_path)
    harness = sdk.DeepSeekHarness(config)
    try:
        harness.start()
        observation = _drive_turn(harness, "policy-escalation", "widen sandbox")
        result_text = observation.tool_result_text()
        evidence = _record_evidence(
            "policy-escalation-deny",
            {
                "serverInfo": _server_info(harness),
                "eventTypes": observation.event_types(),
                "toolResult": result_text,
                "incomingRequests": observation.incoming_requests,
                "escalationMarkerCreated": (cwd / ESCALATION_MARKER_NAME).exists(),
            },
        )
        assert "tool/result" in observation.event_types(), (
            f"escalation call produced no tool result: {observation.event_types()}. evidence={evidence}"
        )
        assert all(fragment in result_text for fragment in ESCALATION_ERROR_FRAGMENTS), (
            f"released runtime did not refuse the escalated call for lack of an approval "
            f"channel; re-probe the gate. result={result_text!r}. evidence={evidence}"
        )
        assert not (cwd / ESCALATION_MARKER_NAME).exists(), (
            f"the escalated command ran without approval; pre-execution denial is absent. "
            f"evidence={evidence}"
        )
        assert observation.incoming_requests == [], (
            f"released runtime unexpectedly sent an approval request: "
            f"{observation.incoming_requests}. evidence={evidence}"
        )
    finally:
        harness.close()
        httpd.shutdown()
        httpd.server_close()


def test_initialize_approval_requests_flag_is_accepted_but_inert(tmp_path: Path):
    """The master-only ``approvalRequests`` flag is accepted yet changes nothing here.

    Master (reference only) uses ``initialize.approvalRequests: true`` to enable
    server->client ``approval/request``. The released runtime accepts the extra field
    without a schema error but sends no such request, so the flag has no observable effect.
    """
    stub = _ToolCallStubModel(
        {"description": "create gate marker file", "command": f"echo gated > {MARKER_NAME}"}
    )
    httpd, port = _serve(stub)
    config, cwd = _config(port, tmp_path)
    harness = sdk.DeepSeekHarness(config)
    try:
        client = harness.client
        client.start()
        response = client.request(
            "initialize",
            {
                "cwd": str(Path(config.cwd).resolve()),
                "provider": config.provider,
                "model": config.model,
                "approvalRequests": True,
            },
            response_model=InitializeResponse,
            timeout_seconds=30.0,
        )
        server_info = {
            "name": getattr(response.serverInfo, "name", None),
            "version": getattr(response.serverInfo, "version", None),
        }
        observation = _drive_turn(harness, "policy-flag", "write the marker")
        evidence = _record_evidence(
            "policy-approval-requests-flag",
            {
                "serverInfo": server_info,
                "flagAccepted": True,
                "eventTypes": observation.event_types(),
                "incomingRequests": observation.incoming_requests,
                "markerCreated": (cwd / MARKER_NAME).exists(),
            },
        )
        assert server_info["name"], f"released runtime answered initialize without serverInfo: {evidence}"
        assert (cwd / MARKER_NAME).exists(), (
            f"valid bash did not run after initialize with approvalRequests=true; the flag may "
            f"now change execution. evidence={evidence}"
        )
        assert observation.incoming_requests == [], (
            f"released runtime honoured approvalRequests by sending a request: "
            f"{observation.incoming_requests}. evidence={evidence}"
        )
    finally:
        harness.close()
        httpd.shutdown()
        httpd.server_close()
