"""Real-SDK smoke test for :class:`jupyter_aiterminal.dsh_client.DshClient`.

Unlike ``tests/test_dsh_client.py`` (which injects an in-process fake SDK) this
module drives the *installed* ``deepseek_harness`` SDK end to end through the
production ``DshClient``: ``start`` -> two independent runs -> ``close`` ->
a new client resuming the same durable session -> history replay -> an explicit
missing-session failure. The only model endpoint is a loopback OpenAI-compatible
SSE stub; the key is a fake value and no real gateway or credential is used.

The controlled home/workspace live under a fresh ``mkdtemp`` root that is
resolved before use (on macOS ``/var`` is a symlink), so the client's
symlink/allowlist checks are exercised exactly as in production. Observed
metadata, home top-level entries, product events and the Python -> TypeScript
contract audit are written to a temporary evidence directory (path recorded in
the test report); the SDK/runtime metadata and event payloads contain no
secrets.

Run with the pinned SDK visible to pytest, for example::

    PYTHONPATH=<probe-venv>/lib/python3.13/site-packages \
        python -m pytest tests/test_dsh_client_integration.py -q

The whole module is additionally bounded from the outside by a 90s process
timeout; each SDK start/run is bounded at 15s here so a stuck runtime fails
loudly instead of hanging the wrapper.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import shutil
import socket
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip(
    "deepseek_harness",
    reason="deepseek-harness-sdk is not installed; real-client smoke not verified",
)

from jupyter_aiterminal.dsh_client import DshClient, DshClientError  # noqa: E402
from jupyter_aiterminal.dsh_config import parse_dsh_provider_config  # noqa: E402

SDK_DISTRIBUTION = "deepseek-harness-sdk"
RUNTIME_DISTRIBUTION = "deepseek-harness-runtime-bin"
EXPECTED_RELEASE_VERSION = "0.2.1rc2"
FAKE_KEY = "dsh-client-smoke-fake-not-a-secret"
STUB_TEXT = "DSH-SMOKE-OK"
INITIALIZE_TIMEOUT_SECONDS = 15.0
RUN_TIMEOUT_SECONDS = 15.0
# The TS contract names/statuses copied from src/agent/protocol.ts. Only the
# fields required for the event kinds this smoke actually observes are checked.
TS_CONNECTION_PHASES = {"connected", "disconnected", "reconnecting", "replaced"}
TS_SESSION_PHASES = {"attached", "resumed", "detached"}
TS_RUN_STATUSES = {"completed", "failed", "cancelled"}
TS_CAPABILITY_STATUSES = {"available", "unavailable", "unverified"}
TS_RUN_SCOPED_REQUIRED = {
    "dsh/v1/run.started": ("sessionId", "runtimeId", "runId"),
    "dsh/v1/run.finished": ("sessionId", "runtimeId", "runId", "status"),
    "dsh/v1/text.snapshot": ("sessionId", "runtimeId", "messageId", "text"),
    "dsh/v1/text.delta": (
        "sessionId",
        "runtimeId",
        "runId",
        "messageId",
        "delta",
    ),
}


class _Recorder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []

    def add(self, entry: dict[str, Any]) -> None:
        with self._lock:
            self.requests.append(entry)

    def snapshot(self) -> list[dict[str, Any]]:
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
        messages = body.get("messages") if isinstance(body, dict) else None
        self.server.recorder.add(  # type: ignore[attr-defined]
            {
                "path": self.path,
                "stream": body.get("stream"),
                "model": body.get("model"),
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
            'data: {"id":"chatcmpl-smoke","object":"chat.completion.chunk",'
            '"choices":[{"index":0,"delta":{"role":"assistant","content":"'
            + STUB_TEXT
            + '"},"finish_reason":null}]}\n\n'
            'data: {"id":"chatcmpl-smoke","object":"chat.completion.chunk",'
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


def _provider_config(port: int) -> Any:
    return parse_dsh_provider_config(
        {
            "apiProtocol": "openai-completions",
            "baseUrl": f"http://127.0.0.1:{port}/openai",
            "model": "probe-model",
            "token": FAKE_KEY,
        },
        context_window=8192,
        max_output_tokens=64,
    )


def _home_entries(home: Path) -> list[str]:
    return sorted(entry.name for entry in home.iterdir())


def _run_summary(result: Any) -> dict[str, Any]:
    return {
        "session_id": result.session_id,
        "run_id": result.run_id,
        "final_response": result.final_response,
        "finish_reason": result.finish_reason,
    }


async def _safe_close(client: DshClient | None) -> None:
    if client is None:
        return
    try:
        await asyncio.wait_for(client.close(), INITIALIZE_TIMEOUT_SECONDS)
    except Exception:
        # Cleanup is best effort; the original failure is what the report needs.
        return


async def _scenario(
    obs: dict[str, Any],
    config: Any,
    root: Path,
    home: Path,
    workspace: Path,
    recorder: _Recorder,
) -> None:
    first_events: list[dict[str, Any]] = []
    resume_events: list[dict[str, Any]] = []
    missing_events: list[dict[str, Any]] = []
    first: DshClient | None = None
    resumed: DshClient | None = None
    missing: DshClient | None = None
    try:
        first = DshClient(
            config=config,
            cwd=workspace,
            home=home,
            emit=first_events.append,
        )
        obs["session_id"] = first.session_id
        await asyncio.wait_for(first.start(), INITIALIZE_TIMEOUT_SECONDS)
        obs["runtime_id_first"] = first.runtime_id
        obs["start_event_types"] = [event["type"] for event in first_events]

        obs["run1"] = _run_summary(
            await asyncio.wait_for(
                first.run("smoke-first-prompt"), RUN_TIMEOUT_SECONDS
            )
        )
        obs["run2"] = _run_summary(
            await asyncio.wait_for(
                first.run("smoke-second-prompt"), RUN_TIMEOUT_SECONDS
            )
        )
        obs["first_product_events"] = list(first_events)
        await _safe_close(first)
        first = None
        obs["home_entries_after_first_close"] = _home_entries(home)
        obs["session_store_entries_after_first_close"] = (
            _home_entries(home / "sessions") if (home / "sessions").is_dir() else []
        )
        profiles = home / "profiles"
        obs["home_profiles_entries_after_first_close"] = (
            _home_entries(profiles) if profiles.is_dir() else []
        )

        # The production home allowlist may reject a directory the runtime
        # itself created. Record that exact path/error; never widen the
        # allowlist here to force the smoke green.
        obs.update(
            {
                "resume_error": None,
                "runtime_id_resumed": None,
                "resume_start_event_types": [],
                "run3": None,
                "requests_during_resume_run": 0,
                "resume_history": {
                    "has_first_prompt": False,
                    "has_second_prompt": False,
                    "has_resume_prompt": False,
                },
                "resume_run_event_count": 0,
            }
        )
        try:
            resumed = DshClient(
                config=config,
                cwd=workspace,
                home=home,
                emit=resume_events.append,
                resume_session_id=obs["session_id"],
            )
            await asyncio.wait_for(resumed.start(), INITIALIZE_TIMEOUT_SECONDS)
            obs["runtime_id_resumed"] = resumed.runtime_id
            obs["resume_start_event_types"] = [
                event["type"] for event in resume_events
            ]
            before = len(recorder.snapshot())
            obs["run3"] = _run_summary(
                await asyncio.wait_for(
                    resumed.run("smoke-resume-prompt"), RUN_TIMEOUT_SECONDS
                )
            )
            after = recorder.snapshot()
            obs["requests_during_resume_run"] = len(after) - before
            resume_request = after[-1] if after else {"messages": []}
            history = json.dumps(
                resume_request.get("messages"), ensure_ascii=False
            )
            obs["resume_history"] = {
                "has_first_prompt": "smoke-first-prompt" in history,
                "has_second_prompt": "smoke-second-prompt" in history,
                "has_resume_prompt": "smoke-resume-prompt" in history,
            }
            obs["resume_run_event_count"] = len(resume_events)
        except (DshClientError, asyncio.TimeoutError) as exc:
            obs["resume_error"] = {
                "type": type(exc).__name__,
                "message": str(exc),
            }
        finally:
            await _safe_close(resumed)
            resumed = None
            obs["home_entries_after_final_close"] = _home_entries(home)

        missing_id = f"missing-session-smoke-{uuid.uuid4().hex}"
        requests_before_missing = len(recorder.snapshot())
        missing = DshClient(
            config=config,
            cwd=workspace,
            home=home,
            emit=missing_events.append,
            resume_session_id=missing_id,
        )
        try:
            await asyncio.wait_for(missing.start(), INITIALIZE_TIMEOUT_SECONDS)
        except DshClientError as exc:
            obs["missing_session_error"] = {
                "type": type(exc).__name__,
                "message": str(exc),
                "mentions_session_id": missing_id in str(exc),
                "model_requests": len(recorder.snapshot()) - requests_before_missing,
            }
        else:
            obs["missing_session_error"] = {
                "type": None,
                "message": "start() unexpectedly succeeded",
                "mentions_session_id": False,
                "model_requests": len(recorder.snapshot()) - requests_before_missing,
            }
        obs["missing_session_event_count"] = len(missing_events)
        await _safe_close(missing)
        missing = None

        obs["requests"] = [
            {
                "path": request.get("path"),
                "model": request.get("model"),
                "stream": request.get("stream"),
                "message_count": len(request.get("messages") or []),
            }
            for request in recorder.snapshot()
        ]
        obs["all_product_events"] = first_events + resume_events + missing_events
        obs["root"] = str(root)
    finally:
        await _safe_close(first)
        await _safe_close(resumed)
        await _safe_close(missing)


def _contract_mismatches(events: list[dict[str, Any]]) -> list[str]:
    """Audit the observed Python events against the TS-required fields.

    This mirrors ``parseDshPayload`` in ``src/agent/protocol.ts`` for the kinds
    this smoke can observe. A mismatch is a real Python -> TS contract failure,
    not something to paper over with defaults.
    """
    problems: list[str] = []
    for index, event in enumerate(events):
        event_type = event.get("type")
        label = f"event[{index}] {event_type}"
        if event_type in TS_RUN_SCOPED_REQUIRED:
            for field in TS_RUN_SCOPED_REQUIRED[event_type]:
                if not isinstance(event.get(field), str) or not event.get(field):
                    problems.append(f"{label}: missing required field {field!r}")
            if event_type == "dsh/v1/run.finished":
                status = event.get("status")
                if status not in TS_RUN_STATUSES:
                    problems.append(
                        f"{label}: status {status!r} not in {sorted(TS_RUN_STATUSES)}"
                    )
        elif event_type == "dsh/v1/connection":
            if not isinstance(event.get("runtimeId"), str) or not event.get("runtimeId"):
                problems.append(f"{label}: missing required field 'runtimeId'")
            if event.get("phase") not in TS_CONNECTION_PHASES:
                problems.append(
                    f"{label}: phase {event.get('phase')!r} not in "
                    f"{sorted(TS_CONNECTION_PHASES)}"
                )
        elif event_type == "dsh/v1/session":
            if not isinstance(event.get("sessionId"), str) or not event.get("sessionId"):
                problems.append(f"{label}: missing required field 'sessionId'")
            if not isinstance(event.get("runtimeId"), str) or not event.get("runtimeId"):
                problems.append(f"{label}: missing required field 'runtimeId'")
            if event.get("phase") not in TS_SESSION_PHASES:
                problems.append(
                    f"{label}: phase {event.get('phase')!r} not in "
                    f"{sorted(TS_SESSION_PHASES)}"
                )
        elif event_type == "dsh/v1/capabilities":
            if not isinstance(event.get("runtimeId"), str) or not event.get("runtimeId"):
                problems.append(f"{label}: missing required field 'runtimeId'")
            capabilities = event.get("capabilities")
            if not isinstance(capabilities, dict):
                problems.append(f"{label}: 'capabilities' is not an object")
                continue
            for name, entry in capabilities.items():
                if not isinstance(entry, dict):
                    problems.append(
                        f"{label}: capability {name!r} must be an object with "
                        f"'status', got {type(entry).__name__}"
                    )
                    continue
                if entry.get("status") not in TS_CAPABILITY_STATUSES:
                    problems.append(
                        f"{label}: capability {name!r} status "
                        f"{entry.get('status')!r} not in "
                        f"{sorted(TS_CAPABILITY_STATUSES)}"
                    )
    return problems


@pytest.fixture(scope="module")
def smoke_observation(stub_server) -> dict[str, Any]:
    port, recorder = stub_server
    sdk_version = importlib.metadata.version(SDK_DISTRIBUTION)
    runtime_version = importlib.metadata.version(RUNTIME_DISTRIBUTION)
    assert sdk_version == EXPECTED_RELEASE_VERSION, sdk_version
    assert runtime_version == EXPECTED_RELEASE_VERSION, runtime_version

    root = Path(tempfile.mkdtemp(prefix="jupyter-aiterminal-dsh-smoke-")).resolve()
    home = root / "home"
    workspace = root / "workspace"
    workspace.mkdir()
    evidence_dir = Path(
        tempfile.mkdtemp(prefix="dsh-client-smoke-evidence-")
    ).resolve()
    evidence_path = evidence_dir / "smoke-evidence.json"
    obs: dict[str, Any] = {
        "sdk": {
            "distribution": SDK_DISTRIBUTION,
            "version": sdk_version,
            "runtime_distribution": RUNTIME_DISTRIBUTION,
            "runtime_version": runtime_version,
        },
        "paths": {
            "root": str(root),
            "home": str(home),
            "workspace": str(workspace),
            "evidence": str(evidence_path),
        },
        "stub": "loopback OpenAI-compatible SSE (fake key, no gateway egress)",
    }
    try:
        asyncio.run(
            _scenario(obs, _provider_config(port), root, home, workspace, recorder)
        )
        obs["contract_mismatches"] = _contract_mismatches(
            obs.get("all_product_events", [])
        )
        return obs
    finally:
        evidence_path.write_text(
            json.dumps(obs, indent=2, sort_keys=True, default=str),
            encoding="utf-8",
        )
        shutil.rmtree(root, ignore_errors=True)


def test_start_and_two_runs_have_distinct_run_ids_and_scoped_text(
    smoke_observation: dict[str, Any],
) -> None:
    """One real runtime, two runs: distinct identities and correctly scoped text."""
    obs = smoke_observation
    session_id = obs["session_id"]
    assert obs["start_event_types"] == [
        "dsh/v1/connection",
        "dsh/v1/session",
        "dsh/v1/capabilities",
    ]

    run1, run2 = obs["run1"], obs["run2"]
    run_ids = {run1["run_id"], run2["run_id"]}
    assert len(run_ids) == 2, run_ids
    assert {run1["session_id"], run2["session_id"]} == {session_id}
    assert run1["final_response"] == STUB_TEXT
    assert run2["final_response"] == STUB_TEXT
    assert run1["finish_reason"] == "completed"
    assert run2["finish_reason"] == "completed"

    events = obs["first_product_events"]
    for run_id in run_ids:
        scoped = [event for event in events if event.get("runId") == run_id]
        assert [event["type"] for event in scoped].count("dsh/v1/run.started") == 1
        finished = [
            event for event in scoped if event["type"] == "dsh/v1/run.finished"
        ]
        assert len(finished) == 1, scoped
        assert finished[0]["status"] == "completed"
        texts = [
            event["text"]
            for event in scoped
            if event["type"] == "dsh/v1/text.snapshot"
        ]
        assert texts and "".join(texts) == STUB_TEXT, texts

    # No event may carry a run identity from a different execution.
    for event in events:
        if "runId" in event:
            assert event["runId"] in run_ids, event
            assert event["sessionId"] == session_id, event


def test_resume_replays_history_and_missing_session_fails_explicitly(
    smoke_observation: dict[str, Any],
) -> None:
    obs = smoke_observation
    if obs["resume_error"] is not None:
        pytest.fail(
            "resume start was blocked by the production controlled-home checks: "
            f"{obs['resume_error']!r}; observed home entries after first close: "
            f"{obs['home_entries_after_first_close']!r}; observed profiles "
            f"entries: {obs['home_profiles_entries_after_first_close']!r}"
        )
    assert obs["resume_start_event_types"] == [
        "dsh/v1/connection",
        "dsh/v1/session",
        "dsh/v1/capabilities",
    ]
    run3 = obs["run3"]
    assert run3 is not None
    assert run3["run_id"] not in {
        obs["run1"]["run_id"],
        obs["run2"]["run_id"],
    }
    assert run3["session_id"] == obs["session_id"]
    assert run3["final_response"] == STUB_TEXT
    assert run3["finish_reason"] == "completed"
    assert obs["runtime_id_first"] != obs["runtime_id_resumed"]
    assert obs["requests_during_resume_run"] == 1, obs["requests"]
    assert obs["resume_history"] == {
        "has_first_prompt": True,
        "has_second_prompt": True,
        "has_resume_prompt": True,
    }, obs["resume_history"]

    missing = obs["missing_session_error"]
    assert missing["type"] == "DshClientError", missing
    assert missing["mentions_session_id"] is True, missing
    assert missing["model_requests"] == 0, missing
    assert obs["missing_session_event_count"] == 0, obs["missing_session_event_count"]

    assert obs["home_entries_after_first_close"], obs


def test_product_events_match_typescript_required_fields(
    smoke_observation: dict[str, Any],
) -> None:
    """Every emitted product event must carry the fields the TS parser requires."""
    mismatches = smoke_observation["contract_mismatches"]
    assert not mismatches, "\n".join(mismatches)
