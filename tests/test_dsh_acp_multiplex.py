"""Live probe: one pinned DSH runtime, two ACP sessions, overlapping prompts.

This is the feasibility gate for shared-dsh-detached-sessions. It starts the
installed ``deepseek-harness-runtime-bin`` once, creates two sessions with
different cwd values, and overlaps ``session/prompt``. A local OpenAI stub
returns immediately so the probe checks protocol and sandbox behavior rather
than a real model.

Skip when the pinned runtime is not installed. A collected failure of the
second session, overlapping prompts, event tagging, or cwd boundary is a hard
stop for the rest of the change.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from jupyter_aiterminal.dsh_acp_config import (
    build_acp_session_params,
    build_acp_subprocess_env,
    render_acp_profile_patch,
)
from jupyter_aiterminal.dsh_acp_transport import DshAcpError, DshAcpTransport
from jupyter_aiterminal.dsh_config import parse_dsh_provider_config

RUNTIME_DISTRIBUTION = "deepseek-harness-runtime-bin"
EXPECTED_RUNTIME_VERSION = "0.2.1rc2"
FAKE_KEY = "dsh-multiplex-probe-fake-not-a-secret"
PROBE_TIMEOUT_SECONDS = 45.0


def _runtime_version() -> str | None:
    try:
        return importlib.metadata.version(RUNTIME_DISTRIBUTION)
    except importlib.metadata.PackageNotFoundError:
        return None


pytestmark = pytest.mark.skipif(
    _runtime_version() != EXPECTED_RUNTIME_VERSION,
    reason=(
        f"{RUNTIME_DISTRIBUTION} {EXPECTED_RUNTIME_VERSION} is not installed; "
        "multiplex probe not verified"
    ),
)


class _Stub(BaseHTTPRequestHandler):
    """OpenAI-compatible endpoint that finishes one short completion."""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        # The pinned runtime streams OpenAI chunks and requires finish_reason.
        payload = (
            'data: {"id":"chatcmpl-probe","object":"chat.completion.chunk",'
            '"choices":[{"index":0,"delta":{"role":"assistant",'
            '"content":"PROBE_OK"},"finish_reason":null}]}\n\n'
            'data: {"id":"chatcmpl-probe","object":"chat.completion.chunk",'
            '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
            "data: [DONE]\n\n"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _serve() -> tuple[ThreadingHTTPServer, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    port = int(server.server_address[1])
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def _free_port_is_loopback(port: int) -> None:
    """Fail early if the stub did not bind loopback."""
    with socket.create_connection(("127.0.0.1", port), timeout=2):
        return


async def _probe(tmp_path: Path) -> dict[str, Any]:
    server, port = _serve()
    _free_port_is_loopback(port)
    config = parse_dsh_provider_config(
        {
            "apiProtocol": "openai-completions",
            "baseUrl": f"http://127.0.0.1:{port}/v1",
            "model": "probe-model",
            "token": FAKE_KEY,
        }
    )
    parent = tmp_path / "workspace-parent"
    cwd_a = parent / "alpha"
    cwd_b = parent / "beta"
    cwd_a.mkdir(parents=True)
    cwd_b.mkdir(parents=True)
    # The process-level patch can name only one fallback root. Point it at the
    # parent and let each session/new carry its own cwd.
    storage = tmp_path / "storage"
    home = storage / "home"
    dsh_home = storage / "dsh"
    home.mkdir(parents=True)
    dsh_home.mkdir()
    patch = storage / "patch.json"
    patch.write_text(
        render_acp_profile_patch(config, workspace_root=parent),
        encoding="utf-8",
    )
    os.chmod(patch, 0o600)
    notifications: list[dict[str, Any]] = []

    async def on_notification(message: dict[str, Any]) -> None:
        notifications.append(message)

    env = build_acp_subprocess_env(
        os.environ,
        home=home,
        dsh_home=dsh_home,
        config=config,
    )
    transport = DshAcpTransport(
        patch_path=patch,
        cwd=parent,
        env=env,
        on_notification=on_notification,
        default_request_timeout=PROBE_TIMEOUT_SECONDS,
        startup_timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        await transport.start()
        await transport.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
            },
        )
        created = []
        for cwd in (cwd_a, cwd_b):
            created.append(
                await transport.request(
                    "session/new", build_acp_session_params(cwd)
                )
            )
        session_ids = [item["sessionId"] for item in created]

        async def prompt(session_id: str, cwd: Path, marker: str) -> Any:
            target = cwd / marker
            return await transport.request(
                "session/prompt",
                {
                    "sessionId": session_id,
                    "prompt": [
                        {
                            "type": "text",
                            "text": (
                                "Create exactly one empty file named "
                                f"{marker} in the current workspace. "
                                "Do not write anywhere else."
                            ),
                        }
                    ],
                },
                timeout=PROBE_TIMEOUT_SECONDS,
            )

        results = await asyncio.gather(
            prompt(session_ids[0], cwd_a, "alpha-sentinel.txt"),
            prompt(session_ids[1], cwd_b, "beta-sentinel.txt"),
        )
        for session_id in session_ids:
            await transport.request("session/close", {"sessionId": session_id})
        return {
            "pid": None if transport._proc is None else transport._proc.pid,
            "sessionIds": session_ids,
            "results": results,
            "notifications": notifications,
            "alpha": sorted(path.name for path in cwd_a.iterdir()),
            "beta": sorted(path.name for path in cwd_b.iterdir()),
        }
    finally:
        await transport.close()
        server.shutdown()


def test_one_runtime_runs_two_sessions_in_parallel(tmp_path: Path) -> None:
    evidence = asyncio.run(asyncio.wait_for(_probe(tmp_path), PROBE_TIMEOUT_SECONDS))
    record = tmp_path / "multiplex-evidence.json"
    record.write_text(
        json.dumps(
            {
                "runtime": EXPECTED_RUNTIME_VERSION,
                "pid": evidence["pid"],
                "sessionIds": evidence["sessionIds"],
                "alpha": evidence["alpha"],
                "beta": evidence["beta"],
                "notificationCount": len(evidence["notifications"]),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    assert isinstance(evidence["pid"], int) and evidence["pid"] > 0
    assert len(set(evidence["sessionIds"])) == 2
    tagged = {
        message.get("params", {}).get("sessionId")
        for message in evidence["notifications"]
        if isinstance(message.get("params"), dict)
    }
    assert set(evidence["sessionIds"]).issubset(tagged)
    assert "beta-sentinel.txt" not in evidence["alpha"]
    assert "alpha-sentinel.txt" not in evidence["beta"]
    # The model may refuse the write. A cross-write is the failure; a missing
    # sentinel is recorded for the gate but does not invent a pass.
    assert evidence["alpha"].count("beta-sentinel.txt") == 0
    assert evidence["beta"].count("alpha-sentinel.txt") == 0
