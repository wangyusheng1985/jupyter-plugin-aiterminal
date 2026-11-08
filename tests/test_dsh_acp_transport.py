"""Tests for the stdlib-only ACP v1 JSON-RPC transport.

A controlled Python subprocess stands in for the packaged DSH runtime: it
speaks the same LF-framed JSON-RPC over stdin/stdout, emits split-chunk Unicode,
server permission requests, protocol errors, and exits on demand. No model, SDK,
or network is involved.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from jupyter_aiterminal.dsh_acp_transport import (
    ACP_PROFILE,
    DshAcpError,
    DshAcpTransport,
    resolve_runtime_path,
)

TEST_TIMEOUT_SECONDS = 10.0
SECRET = "dsh-transport-unit-secret-never-logged"

_BODY = r'''
import json
import os
import sys
import time


def write(obj):
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def write_raw(data):
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def recv():
    line = sys.stdin.buffer.readline()
    if not line:
        return None
    return json.loads(line)


def main():
    for line in sys.stdin.buffer:
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        mid = msg.get("id")
        params = msg.get("params") or {}

        if method == "echo":
            write({"jsonrpc": "2.0", "id": mid, "result": {"value": params.get("value")}})
        elif method == "unicode":
            write({"jsonrpc": "2.0", "id": mid, "result": {"text": "pi-你好-🙂"}})
        elif method == "chunked":
            payload = (
                json.dumps(
                    {"jsonrpc": "2.0", "id": mid, "result": {"text": "分块-Δ-🙂"}},
                    ensure_ascii=False,
                )
                + "\n"
            ).encode("utf-8")
            for index in range(0, len(payload), 5):
                write_raw(payload[index:index + 5])
                time.sleep(0.004)
        elif method == "error":
            write({
                "jsonrpc": "2.0",
                "id": mid,
                "error": {"code": -32000, "message": "boom", "data": {"detail": 1}},
            })
        elif method == "slow":
            time.sleep(float(params.get("delay", 5)))
            write({"jsonrpc": "2.0", "id": mid, "result": {"done": True}})
        elif method == "exit":
            os._exit(3)
        elif method == "bad_json":
            write_raw(b"{this-is-not-json}\n")
        elif method == "unknown_response":
            write({"jsonrpc": "2.0", "id": "bogus", "result": {"ignored": True}})
            write({"jsonrpc": "2.0", "id": mid, "result": {"ok": True}})
        elif method == "notify_then_reply":
            for text in ("note-1", "note-2"):
                write({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionUpdate": "agent_message_chunk", "content": text},
                })
            write({"jsonrpc": "2.0", "id": mid, "result": {"ok": True}})
        elif method == "permission":
            write({
                "jsonrpc": "2.0",
                "id": "srv-1",
                "method": "session/request_permission",
                "params": {"options": [{"optionId": "reject", "kind": "reject_once"}]},
            })
            write({
                "jsonrpc": "2.0",
                "method": "dsh/approval_waiting",
                "params": {"requestId": "srv-1"},
            })
            reply = recv()
            write({
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "answered": None if reply is None else reply.get("result"),
                    "error": None if reply is None else reply.get("error"),
                },
            })
        elif method == "env":
            write({
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "inherited": "SHOULD_NOT_LEAK" in os.environ,
                    "has_token": "DSH_TEST_TOKEN" in os.environ,
                },
            })
        elif method == "stderr_leak":
            secret = os.environ.get("DSH_TEST_TOKEN", "")
            for index in range(300):
                sys.stderr.write("stderr line %d %s\n" % (index, secret))
            sys.stderr.flush()
            write({"jsonrpc": "2.0", "id": mid, "result": {"ok": True}})
        elif method == "oversized":
            write_raw(
                b'{"jsonrpc":"2.0","id":'
                + str(mid).encode("utf-8")
                + b',"result":"'
                + b"x" * (9 * 1024 * 1024)
                + b'"}\n'
            )
        else:
            write({
                "jsonrpc": "2.0",
                "id": mid,
                "error": {"code": -32601, "message": "unknown method"},
            })


main()
'''


async def _bounded(coro: Any) -> Any:
    return await asyncio.wait_for(coro, TEST_TIMEOUT_SECONDS)


def _make_runtime(tmp_path: Path) -> Path:
    script = tmp_path / "fake_dsh_runtime"
    script.write_text("#!" + sys.executable + "\n" + _BODY, encoding="utf-8")
    script.chmod(0o755)
    return script


def _env(tmp_path: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(tmp_path),
        "DSH_TEST_TOKEN": SECRET,
    }


async def _build_transport(tmp_path: Path, **kwargs: Any) -> DshAcpTransport:
    patch = tmp_path / "patch.yml"
    patch.write_text("# controlled test patch\n", encoding="utf-8")
    return DshAcpTransport(
        runtime_path=_make_runtime(tmp_path),
        patch_path=patch,
        cwd=tmp_path,
        env=_env(tmp_path),
        default_request_timeout=5.0,
        startup_timeout=5.0,
        close_timeout=2.0,
        **kwargs,
    )


async def _start(tmp_path: Path, **kwargs: Any) -> DshAcpTransport:
    transport = await _build_transport(tmp_path, **kwargs)
    await transport.start()
    return transport


def _patch_delayed_spawn(monkeypatch: Any, delay: float) -> list[Any]:
    """Delay the real spawn and record every process that actually ran."""
    real_spawn = asyncio.create_subprocess_exec
    spawned: list[Any] = []

    async def fake_spawn(*args: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(delay)
        proc = await real_spawn(*args, **kwargs)
        spawned.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
    return spawned


async def _wait_for(predicate: Any, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not met before the test deadline")


def test_argv_profile_and_config_validation(tmp_path: Path) -> None:
    script = _make_runtime(tmp_path)
    patch = (tmp_path / "patch.yml").resolve()
    patch.write_text("# patch\n", encoding="utf-8")
    transport = DshAcpTransport(
        runtime_path=script,
        patch_path=patch,
        cwd=tmp_path,
        env=_env(tmp_path),
    )
    expected = (str(script), "--profile", "acp", "--patch", str(patch))
    assert transport.argv == expected
    assert SECRET not in " ".join(transport.argv)
    assert ACP_PROFILE == "acp"

    with pytest.raises(DshAcpError, match="only 'acp'"):
        DshAcpTransport(
            runtime_path=script,
            patch_path=patch,
            cwd=tmp_path,
            env=_env(tmp_path),
            profile="sdk",
        )
    with pytest.raises(DshAcpError, match="absolute"):
        DshAcpTransport(
            runtime_path=script,
            patch_path="relative.yml",
            cwd=tmp_path,
            env=_env(tmp_path),
        )
    with pytest.raises(DshAcpError, match="strings"):
        DshAcpTransport(
            runtime_path=script,
            patch_path=patch,
            cwd=tmp_path,
            env={"PATH": 1},  # type: ignore[dict-item]
        )


def test_resolve_runtime_path_reports_missing_package(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "deepseek_harness_runtime", None)
    with pytest.raises(DshAcpError, match="deepseek_harness_runtime"):
        resolve_runtime_path()


def test_request_id_correlation_unicode_and_chunked_lf(tmp_path: Path) -> None:
    async def scenario() -> None:
        transport = await _start(tmp_path)
        try:
            values = await asyncio.gather(
                *(transport.request("echo", {"value": index}) for index in range(20))
            )
            assert [value["value"] for value in values] == list(range(20))

            unicode_result = await transport.request("unicode")
            assert unicode_result["text"] == "pi-你好-🙂"

            chunked = await transport.request("chunked")
            assert chunked["text"] == "分块-Δ-🙂"
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_notification_callbacks_keep_runtime_order(tmp_path: Path) -> None:
    async def scenario() -> None:
        seen: list[str] = []

        def on_notification(message: dict[str, Any]) -> None:
            seen.append(message["params"]["content"])

        transport = await _start(tmp_path, on_notification=on_notification)
        try:
            await transport.request("notify_then_reply")
            await _wait_for(lambda: len(seen) == 2)
            assert seen == ["note-1", "note-2"]
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_permission_server_request_does_not_deadlock_reader(tmp_path: Path) -> None:
    async def scenario() -> None:
        approval_seen = asyncio.Event()
        release_approval = asyncio.Event()
        handled: list[str] = []

        async def on_server_request(message: dict[str, Any]) -> dict[str, Any]:
            handled.append(message["method"])
            approval_seen.set()
            # Simulates waiting for the user while stdout must stay readable.
            await release_approval.wait()
            return {"outcome": "selected", "optionId": "reject"}

        def on_notification(message: dict[str, Any]) -> None:
            if message.get("method") == "dsh/approval_waiting":
                release_approval.set()

        transport = await _start(
            tmp_path,
            on_server_request=on_server_request,
            on_notification=on_notification,
        )
        try:
            result = await transport.request("permission", timeout=3.0)
            assert handled == ["session/request_permission"]
            assert result["answered"] == {"outcome": "selected", "optionId": "reject"}
            assert result["error"] is None
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_explicit_response_from_server_request_handler(tmp_path: Path) -> None:
    async def scenario() -> None:
        holder: dict[str, DshAcpTransport] = {}
        answered: list[str] = []

        async def on_server_request(message: dict[str, Any]) -> None:
            await holder["transport"].response(
                message["id"], result={"outcome": "cancelled"}
            )
            answered.append(message["method"])
            return None

        transport = await _start(tmp_path, on_server_request=on_server_request)
        holder["transport"] = transport
        try:
            result = await transport.request("permission", timeout=3.0)
            assert answered == ["session/request_permission"]
            assert result["answered"] == {"outcome": "cancelled"}
            assert result["error"] is None
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_unhandled_server_request_gets_error_instead_of_hanging(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        transport = await _start(tmp_path)
        try:
            result = await transport.request("permission", timeout=3.0)
            assert result["answered"] is None
            assert result["error"]["code"] == -32601
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_error_response_invalid_json_unknown_id_and_process_exit(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        transport = await _start(tmp_path)
        try:
            with pytest.raises(DshAcpError) as error_info:
                await transport.request("error")
            assert error_info.value.code == -32000
            assert error_info.value.data == {"detail": 1}
            assert "boom" in str(error_info.value)

            with pytest.raises(DshAcpError, match="invalid JSON"):
                await transport.request("bad_json")
            # The malformed frame failed pending work but did not wedge the pipe.
            assert (await transport.request("echo", {"value": "after"}))["value"] == "after"

            assert (await transport.request("unknown_response"))["ok"] is True
            assert transport.unmatched_responses == 1

            with pytest.raises(DshAcpError, match="stdout closed"):
                await transport.request("exit")
            with pytest.raises(DshAcpError, match="has exited"):
                await transport.request("echo", {"value": "never"})
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_request_timeout_wakes_pending(tmp_path: Path) -> None:
    async def scenario() -> None:
        transport = await _start(tmp_path)
        try:
            with pytest.raises(DshAcpError, match="timed out"):
                await transport.request("slow", {"delay": 2.0}, timeout=0.2)
            # A timed-out response arriving later is ignored, not cross-wired.
            assert (await transport.request("echo", {"value": "ok"}))["value"] == "ok"
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_close_under_active_prompt_and_repeated_close(tmp_path: Path) -> None:
    async def scenario() -> None:
        transport = await _start(tmp_path)
        task = asyncio.create_task(
            transport.request("slow", {"delay": 30.0}, timeout=30.0)
        )
        await asyncio.sleep(0.1)
        started = time.monotonic()
        await transport.close()
        elapsed = time.monotonic() - started
        with pytest.raises(DshAcpError, match="closed"):
            await task
        assert elapsed < 3.0
        await transport.close()  # repeated close is a no-op
        with pytest.raises(DshAcpError, match="closed"):
            await transport.request("echo", {"value": "after-close"})

    asyncio.run(_bounded(scenario()))


def test_env_is_replaced_and_stderr_is_bounded_and_redacted(tmp_path: Path) -> None:
    async def scenario() -> None:
        os.environ["SHOULD_NOT_LEAK"] = "1"
        transport = await _start(tmp_path)
        try:
            result = await transport.request("env")
            assert result["inherited"] is False
            assert result["has_token"] is True

            await transport.request("stderr_leak")
            await _wait_for(lambda: len(transport.stderr_tail(1000)) >= 200)
            tail = transport.stderr_tail(1000)
            assert len(tail) == 200
            assert not any(SECRET in line for line in tail)
            assert any("[redacted]" in line for line in tail)
        finally:
            os.environ.pop("SHOULD_NOT_LEAK", None)
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_concurrent_start_spawns_one_runtime(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        spawned = _patch_delayed_spawn(monkeypatch, delay=0.2)
        transport = await _build_transport(tmp_path)
        try:
            outcomes = await asyncio.gather(
                transport.start(), transport.start(), return_exceptions=True
            )
            failures = [item for item in outcomes if isinstance(item, Exception)]
            assert outcomes.count(None) == 1
            assert len(failures) == 1
            assert "already started" in str(failures[0])
            assert len(spawned) == 1
            assert (await transport.request("echo", {"value": 7}))["value"] == 7
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_close_during_start_terminates_late_spawn(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        spawned = _patch_delayed_spawn(monkeypatch, delay=0.3)
        transport = await _build_transport(tmp_path)
        start_task = asyncio.create_task(transport.start())
        await asyncio.sleep(0.05)
        await transport.close()
        with pytest.raises(DshAcpError, match="closed"):
            await start_task
        assert len(spawned) == 1
        assert spawned[0].returncode is not None

    asyncio.run(_bounded(scenario()))


def test_cancelled_start_reaps_late_spawn(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        spawned = _patch_delayed_spawn(monkeypatch, delay=0.2)
        transport = await _build_transport(tmp_path)
        start_task = asyncio.create_task(transport.start())
        await asyncio.sleep(0.05)
        start_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await start_task
        await _wait_for(
            lambda: bool(spawned) and spawned[0].returncode is not None, timeout=5.0
        )
        await transport.close()

    asyncio.run(_bounded(scenario()))


def test_oversized_stdout_frame_fails_safely(tmp_path: Path) -> None:
    async def scenario() -> None:
        transport = await _start(tmp_path)
        try:
            with pytest.raises(DshAcpError, match="invalid stdout"):
                await transport.request("oversized", timeout=5.0)
            assert any("too large" in error for error in transport.protocol_errors)
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_server_request_explicit_response_is_not_duplicated(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        holder: dict[str, DshAcpTransport] = {}
        frames: list[dict[str, Any]] = []

        async def on_server_request(message: dict[str, Any]) -> dict[str, Any]:
            await holder["transport"].response(
                message["id"], result={"outcome": "cancelled"}
            )
            # Misuse: returning a payload after an explicit response must not
            # produce a second response frame for the same id.
            return {"outcome": "ignored"}

        transport = await _start(tmp_path, on_server_request=on_server_request)
        holder["transport"] = transport
        original_send = transport._send

        async def recording_send(frame: dict[str, Any]) -> None:
            frames.append(frame)
            await original_send(frame)

        transport._send = recording_send  # type: ignore[method-assign]
        try:
            result = await transport.request("permission", timeout=3.0)
            assert result["answered"] == {"outcome": "cancelled"}
            replies = [frame for frame in frames if frame.get("id") == "srv-1"]
            assert len(replies) == 1
            assert any("answered twice" in error for error in transport.protocol_errors)
        finally:
            await transport.close()

    asyncio.run(_bounded(scenario()))


def test_start_errors_are_clear(tmp_path: Path) -> None:
    async def scenario() -> None:
        patch = tmp_path / "patch.yml"
        patch.write_text("# patch\n", encoding="utf-8")
        transport = DshAcpTransport(
            runtime_path=tmp_path / "missing-runtime",
            patch_path=patch,
            cwd=tmp_path,
            env=_env(tmp_path),
        )
        with pytest.raises(DshAcpError, match="not found"):
            await transport.start()
        await transport.close()

        not_started = DshAcpTransport(
            runtime_path=_make_runtime(tmp_path),
            patch_path=patch,
            cwd=tmp_path,
            env=_env(tmp_path),
        )
        with pytest.raises(DshAcpError, match="not started"):
            await not_started.request("echo")
        await not_started.close()

    asyncio.run(_bounded(scenario()))
