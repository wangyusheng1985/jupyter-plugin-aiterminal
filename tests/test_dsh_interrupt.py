"""Released-version contract probe: single-session interrupt of an in-flight turn.

Primary evidence is the **published** Python SDK surface, pinned to the exact release
under test (``deepseek-harness-sdk`` and ``deepseek-harness-runtime-bin`` 0.2.1rc2 when
this was written). The released protocol's Known Limitations (deepseek-harness master,
**reference only**, not the release under test) state: *"No cancel or session-close
methods — a client abandons a turn by closing the runtime process."* The published SDK
README and public API agree: there is no interrupt/abort/cancel entry point.

Consequence for the plugin: the only documented way to stop a running turn is to cancel
the session run by closing the runtime process and rebuild it. That is a pending product
decision (cancel-and-rebuild semantics), **not** an implemented single-session interrupt.
These tests therefore record a contract gap; they do not prove the plugin can interrupt.

Wire probes against guessed method names are **secondary**. Only an ``unknown method``
JSON-RPC error corroborates absence. ``invalid params``, timeouts, or transport errors are
classified as inconclusive and are never treated as proof that interrupt is missing.

The probe needs the published SDK. Point ``DSH_SDK_SITE`` at its ``site-packages``
directory, or install the SDK in the interpreter running pytest. Set
``DSH_EVIDENCE_DIR`` to persist the version-paired evidence JSON; otherwise it is printed
and written under a temporary directory.

A turn is started against a local stub model that answers Anthropic Messages SSE slowly,
so the turn is genuinely in flight while method candidates are sent on the wire. Closing
the runtime is never used as an interrupt substitute.
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

from deepseek_harness.errors import JsonRpcError  # noqa: E402
from deepseek_harness.models import InitializeResponse  # noqa: E402

INTERRUPT_METHOD_CANDIDATES = (
    "session/interrupt",
    "session/cancel",
    "session/prompt/interrupt",
    "session/stop",
    "session/abort",
)
# Codes the released runtime uses for an unknown JSON-RPC method. -32601 is the JSON-RPC
# spec value; the released runtime currently answers -32603 with an "unknown ... method"
# message, so both are accepted as unknown-method evidence.
UNKNOWN_METHOD_CODES = {-32601, -32603}
FIRST_TURN_DELAY_SECONDS = 3.0
DEADLINE_SECONDS = 25.0


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


def _assistant_text(text: str) -> list[dict]:
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


class _SlowStubModel:
    """Local Anthropic-Messages stub: the first turn is delayed, later turns answer at once."""

    def __init__(self) -> None:
        self.hits = 0
        self._lock = threading.Lock()

    def handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        if length:
            handler.rfile.read(length)
        with self._lock:
            self.hits += 1
            first = self.hits == 1
        if first:
            time.sleep(FIRST_TURN_DELAY_SECONDS)
            body = _sse(_assistant_text("STUB_INFLIGHT_TURN"))
        else:
            body = _sse(_assistant_text("STUB_FOLLOWUP_TURN"))
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)


def _serve(stub: _SlowStubModel) -> tuple[ThreadingHTTPServer, int]:
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


def _empty_response_model():
    from pydantic import BaseModel

    class EmptyResult(BaseModel):
        pass

    return EmptyResult


@pytest.fixture()
def released_harness(tmp_path: Path):
    """DeepSeekHarness bound to a local stub model and a throwaway HOME/cwd/dsh_home."""
    stub = _SlowStubModel()
    httpd, port = _serve(stub)
    home = tmp_path / "home"
    cwd = tmp_path / "cwd"
    home.mkdir()
    cwd.mkdir()
    config = sdk.DeepSeekHarnessConfig(
        base_url=f"http://127.0.0.1:{port}",
        api_key="stub-not-a-real-key",
        cwd=str(cwd),
        dsh_home=str(home / "dsh"),
        env={
            "HOME": str(home),
            "DEEPSEEK_API_KEY": "stub-not-a-real-key",
            "PATH": "/usr/bin:/bin",
        },
    )
    harness = sdk.DeepSeekHarness(config)
    harness.start()
    try:
        yield harness, stub
    finally:
        harness.close()
        httpd.shutdown()
        httpd.server_close()


def _public_names(cls: type) -> list[str]:
    return sorted(name for name in dir(cls) if not name.startswith("_"))


def test_released_sdk_public_surface_has_no_interrupt_api(released_harness):
    """Published-SDK evidence: the 0.2.1rc2 public surface has no interrupt/abort/cancel."""
    from deepseek_harness import api, client

    harness, _stub = released_harness
    surfaces = {
        "DeepSeekHarness": _public_names(api.DeepSeekHarness),
        "Session": _public_names(api.Session),
        "HarnessClient": _public_names(client.HarnessClient),
    }
    forbidden = sorted(
        f"{owner}.{name}"
        for owner, names in surfaces.items()
        for name in names
        if any(token in name.lower() for token in ("interrupt", "abort", "cancel"))
    )
    evidence = _record_evidence(
        "interrupt-public-surface",
        {"serverInfo": _server_info(harness), "publicSurface": surfaces, "forbidden": forbidden},
    )
    assert forbidden == [], (
        f"deepseek-harness-sdk {_versions()['sdk']} now exposes {forbidden}; a real "
        f"single-session interrupt may exist and this gap test must be replaced. "
        f"evidence={evidence}"
    )
    # Pin the documented public API so a future release fails loudly instead of silently
    # growing an interrupt method under a different name.
    assert {"start", "close", "start_session", "resume_session", "run"} <= set(
        surfaces["DeepSeekHarness"]
    )
    assert {"get_working_directory", "set_working_directory", "run"} <= set(surfaces["Session"])
    assert {"session_prompt", "initialize", "respond", "next_request"} <= set(
        surfaces["HarnessClient"]
    )


def test_in_flight_turn_has_only_unknown_method_wire_candidates(released_harness):
    """Wire probe while a turn runs: candidates are unknown methods, not a usable interrupt.

    Only ``unknown method`` errors corroborate absence. Any ``invalid params``/timeout is
    recorded as inconclusive and is not used as evidence. The session is allowed to finish
    the in-flight turn naturally; this never substitutes closing the runtime for interrupt.
    """
    harness, stub = released_harness
    client = harness.client
    server_info = _server_info(harness)
    session_id = "interrupt-probe"
    harness.start_session(session_id)
    empty = _empty_response_model()

    first_result: list[str] = []
    first_error: list[BaseException] = []

    def first_prompt() -> None:
        try:
            first_result.append(
                client.session_prompt(session_id, [{"type": "text", "text": "first turn"}])
            )
        except BaseException as error:  # noqa: BLE001 - re-raised through the assertion
            first_error.append(error)

    worker = threading.Thread(target=first_prompt, daemon=True)
    worker.start()
    deadline = time.monotonic() + DEADLINE_SECONDS
    while stub.hits == 0 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert stub.hits == 1, "stub model never received the first turn"

    classifications: dict[str, str] = {}
    evidence_details: dict[str, str] = {}
    for method in INTERRUPT_METHOD_CANDIDATES:
        try:
            client.request(method, {"sessionId": session_id}, response_model=empty, timeout_seconds=5.0)
            classifications[method] = "accepted"
            evidence_details[method] = "accepted"
        except JsonRpcError as error:
            is_unknown = error.code in UNKNOWN_METHOD_CODES and "unknown" in str(error.message).lower()
            classifications[method] = "unknown_method" if is_unknown else "inconclusive"
            evidence_details[method] = f"JsonRpcError {error.code}: {error.message}"
        except TimeoutError as error:
            classifications[method] = "inconclusive"
            evidence_details[method] = f"TimeoutError: {error}"
        except Exception as error:  # noqa: BLE001 - transport rejection is inconclusive too
            classifications[method] = "inconclusive"
            evidence_details[method] = f"{type(error).__name__}: {error}"

    evidence = _record_evidence(
        "interrupt-wire-probe",
        {
            "serverInfo": server_info,
            "candidates": evidence_details,
            "classifications": classifications,
            "unknownMethodEvidence": all(
                value == "unknown_method" for value in classifications.values()
            ),
        },
    )
    assert "accepted" not in classifications.values(), (
        f"deepseek-harness-sdk {_versions()['sdk']} accepted an interrupt method on the wire "
        f"({classifications}); the plugin can call it instead of documenting a gap. "
        f"evidence={evidence}"
    )

    worker.join(timeout=max(1.0, deadline - time.monotonic()))
    assert not worker.is_alive(), "first prompt never returned"
    assert not first_error, f"first prompt failed: {first_error}"
    assert first_result, "first prompt produced no message id"

    followup_id = client.session_prompt(session_id, [{"type": "text", "text": "second turn"}])
    assert followup_id, "same session refused a follow-up prompt after the in-flight turn"
    assert client.get_working_directory(session_id)
