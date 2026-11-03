"""Tests for the ACP session host using an in-process fake transport.

No runtime, SDK, model, or network is used. The fake records exactly which ACP
requests/notifications the host emits and can drive a server-initiated
``session/request_permission`` back through the same handler the real transport
would call.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import pytest

import jupyter_aiterminal.dsh_acp_session as session_module
from jupyter_aiterminal.dsh_acp_session import DshAcpSession, DshAcpSessionError
from jupyter_aiterminal.dsh_acp_transport import DshAcpError
from jupyter_aiterminal.dsh_config import DshProviderConfig

SECRET = "dsh-acp-session-unit-secret-never-render"
TIMEOUT = 10.0


def _config() -> DshProviderConfig:
    return DshProviderConfig(
        api_protocol="openai-completions",
        base_url="https://api.example.test/v1",
        model="example-acp-model",
        context_window=8192,
        max_output_tokens=4096,
        token=SECRET,
    )


class FakeTransport:
    """Minimal transport double with configurable responses."""

    instances: list["FakeTransport"] = []
    new_session_id = "acp-session-new"
    resume_error: Exception | None = None
    start_error: Exception | None = None
    stop_reason = "end_turn"
    close_gate: asyncio.Event | None = None

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.argv = (
            "fake-dsh-runtime",
            "--profile",
            "acp",
            "--patch",
            str(kwargs.get("patch_path")),
        )
        self.requests: list[tuple[str, Any]] = []
        self.notifications: list[tuple[str, Any]] = []
        self.closed = False
        self.started = False
        self.prompt_started = asyncio.Event()
        self.prompt_release = asyncio.Event()
        FakeTransport.instances.append(self)

    async def start(self) -> None:
        if self.start_error is not None:
            raise self.start_error
        self.started = True

    async def request(self, method: str, params: Any = None, timeout: float | None = None) -> Any:
        self.requests.append((method, params))
        if method == "initialize":
            return {"protocolVersion": 1, "agentCapabilities": {}}
        if method == "session/new":
            return {"sessionId": FakeTransport.new_session_id}
        if method == "session/resume":
            if FakeTransport.resume_error is not None:
                raise FakeTransport.resume_error
            return {}
        if method == "session/prompt":
            self.prompt_started.set()
            await self.prompt_release.wait()
            return {"stopReason": FakeTransport.stop_reason}
        if method == "session/close":
            if FakeTransport.close_gate is not None:
                await FakeTransport.close_gate.wait()
            return {}
        raise AssertionError(f"unexpected request {method}")

    async def notify(self, method: str, params: Any = None) -> None:
        self.notifications.append((method, params))
        if method == "session/cancel":
            self.prompt_release.set()

    async def close(self) -> None:
        self.closed = True

    async def call_server_request(self, message: dict[str, Any]) -> Any:
        return await self.kwargs["on_server_request"](message)

    def stderr_tail(self, limit: int = 50) -> list[str]:
        return []

    def request_methods(self) -> list[str]:
        return [method for method, _ in self.requests]


_PINNED_RUNTIME_VERSION = "0.2.1rc2"


async def _fake_preflight(
    argv: tuple[str, ...], cwd: Path, env: Any, timeout: float
) -> tuple[int, str, str]:
    _fake_preflight.calls.append((argv, cwd, dict(env), timeout))
    if _fake_preflight.result is not None:
        return _fake_preflight.result
    return 0, _preflight_dump(cwd), ""


def _preflight_dump(cwd: Path) -> str:
    # Real 0.2.1rc2 dump shape: top-level `- id:` rows with nested config.
    # workspaceRoot is quoted to exercise quoted scalar handling.
    return (
        '- id: approval\n'
        '  config:\n'
        '    policy: ask\n'
        '- id: sandbox-policy\n'
        '  config:\n'
        '    mode: "workspace-write"\n'
        f'    workspaceRoot: "{cwd}"\n'
    )


def _folded_preflight_dump(cwd: Path, root: str | None = None) -> str:
    # Real 0.2.1rc2 emits a folded block scalar (`>-` plus an indented
    # continuation line) once workspaceRoot grows past the dumper's line
    # width, e.g. a macOS temp root under /private/var/folders.
    value = f"{cwd}" if root is None else root
    return (
        '- id: approval\n'
        '  config:\n'
        '    policy: ask\n'
        '- id: sandbox-policy\n'
        '  config:\n'
        '    mode: "workspace-write"\n'
        '    workspaceRoot: >-\n'
        f'      {value}\n'
    )


_fake_preflight.calls = []
_fake_preflight.result = None


async def _wait_for(predicate: Any, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not met before the test deadline")


def _run(scenario: Any) -> Any:
    return asyncio.run(asyncio.wait_for(scenario(), TIMEOUT))


def _make_session(
    tmp_path: Path,
    monkeypatch: Any,
    **kwargs: Any,
) -> tuple[DshAcpSession, list[dict[str, Any]]]:
    FakeTransport.instances = []
    _fake_preflight.calls = []
    _fake_preflight.result = None
    FakeTransport.new_session_id = "acp-session-new"
    FakeTransport.resume_error = None
    FakeTransport.start_error = None
    FakeTransport.stop_reason = "end_turn"
    FakeTransport.close_gate = None
    monkeypatch.setattr(session_module, "DshAcpTransport", FakeTransport)
    cwd = tmp_path / "workspace"
    cwd.mkdir(exist_ok=True)
    emitted: list[dict[str, Any]] = []
    emit = kwargs.pop("emit", emitted.append)
    kwargs.setdefault("runtime_version", lambda: _PINNED_RUNTIME_VERSION)
    kwargs.setdefault("policy_preflight", _fake_preflight)
    session = DshAcpSession(
        config=_config(),
        cwd=cwd,
        storage_root=tmp_path / "storage",
        emit=emit,
        **kwargs,
    )
    return session, emitted


def _permission_message(
    session_id: str,
    *,
    tool_call_id: str | None = "call-1",
    options: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    tool_call: dict[str, Any] = {
        "title": "Run a command",
        "kind": "bash",
    }
    if tool_call_id is not None:
        tool_call["toolCallId"] = tool_call_id
    if options is None:
        options = [
            {"optionId": "allow-1", "kind": "allow_once", "name": "Allow once"},
            {"optionId": "reject-1", "kind": "reject_once", "name": "Reject"},
        ]
    return {
        "jsonrpc": "2.0",
        "id": "srv-1",
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": tool_call,
            "options": options,
        },
    }


def test_start_new_session_contract_storage_and_capabilities(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        try:
            assert fake.request_methods()[:2] == ["initialize", "session/new"]
            initialize = fake.requests[0][1]
            assert initialize["protocolVersion"] == 1
            new_params = fake.requests[1][1]
            assert new_params == {
                "cwd": os.fspath(session.cwd.resolve()),
                "mcpServers": [],
            }
            assert session.session_id == "acp-session-new"
            assert session.runtime_id is not None
            assert session.runtime_id.startswith("runtime-")

            assert session.home is not None and session.dsh_home is not None
            assert session.home != session.dsh_home
            assert stat.S_IMODE(session.home.stat().st_mode) == 0o700
            assert stat.S_IMODE(session.dsh_home.stat().st_mode) == 0o700
            patch_path = session.home.parent / "patch.json"
            assert stat.S_IMODE(patch_path.stat().st_mode) == 0o600
            patch_text = patch_path.read_text(encoding="utf-8")
            assert SECRET not in patch_text
            assert json.loads(patch_text)

            child_env = fake.kwargs["env"]
            assert child_env["HOME"] == os.fspath(session.home)
            assert child_env["DSH_HOME"] == os.fspath(session.dsh_home)
            assert child_env["JUPYTER_AITERMINAL_DSH_API_KEY"] == SECRET

            # The policy overlay was proven on a standalone dump-config run
            # with the same argv/env/cwd before the ACP process was spawned.
            assert _fake_preflight.calls
            preflight_argv, preflight_cwd, preflight_env, preflight_timeout = (
                _fake_preflight.calls[0]
            )
            assert "--patch" in preflight_argv
            assert os.fspath(session.home.parent / "patch.json") in preflight_argv
            assert preflight_cwd == session.cwd
            assert preflight_env["JUPYTER_AITERMINAL_DSH_API_KEY"] == SECRET
            # Independent from startup_timeout and >= the recorded 20s cap.
            assert preflight_timeout == 30.0

            session_events = [
                event for event in emitted if event["type"] == "dsh/v1/session"
            ]
            assert session_events == [
                {
                    "type": "dsh/v1/session",
                    "sessionId": "acp-session-new",
                    "runtimeId": session.runtime_id,
                    "phase": "attached",
                }
            ]
            capabilities = [
                event for event in emitted if event["type"] == "dsh/v1/capabilities"
            ]
            assert capabilities
            assert capabilities[0]["capabilities"] == {
                "cancel": {"status": "available"},
                "approval": {
                    "status": "unavailable",
                    "reason": "approval is handled automatically by the runtime host",
                },
            }
        finally:
            await session.close()
        assert ("session/close", {"sessionId": "acp-session-new"}) in fake.requests
        assert fake.closed is True

    _run(scenario)


def test_start_rejects_unpinned_runtime_version(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(
            tmp_path, monkeypatch, runtime_version=lambda: "0.2.1"
        )
        with pytest.raises(DshAcpSessionError, match="DSH runtime version must be"):
            await session.start()
        # Nothing was spawned and no storage was created for a mismatched pin.
        assert FakeTransport.instances == []
        assert emitted == []
        assert not (tmp_path / "storage").exists()

    _run(scenario)


def test_start_rejects_missing_runtime_distribution(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        def missing() -> str:
            raise DshAcpSessionError("the pinned DSH runtime package is not installed")

        session, emitted = _make_session(
            tmp_path, monkeypatch, runtime_version=missing
        )
        with pytest.raises(DshAcpSessionError, match="not installed"):
            await session.start()
        assert FakeTransport.instances == []
        assert emitted == []

    _run(scenario)


def test_start_fails_closed_when_policy_patch_is_unmatched(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (
            0,
            "- id: approval\n  config:\n    policy: ask\n",
            "dsh: [generated_acp_patch.json] patch: entry (id: approval) not found\n",
        )
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()
        fake = FakeTransport.instances[-1]
        assert fake.started is False
        assert fake.request_methods() == []
        assert fake.closed is True
        assert emitted == []
        assert not list((tmp_path / "storage").rglob("patch.json"))

    _run(scenario)


def test_start_fails_closed_when_dumped_policy_is_absent(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (0, "- id: approval\n  config: {}\n", "")
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()
        assert FakeTransport.instances[-1].started is False
        assert emitted == []

    _run(scenario)


def test_start_fails_closed_when_ask_and_root_are_in_unrelated_rows(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        dump = (
            "- id: approval\n"
            "  config:\n"
            "    policy: never\n"
            "- id: sandbox-policy\n"
            "  config:\n"
            "    workspaceRoot: /somewhere/else\n"
            "- id: unrelated\n"
            "  config:\n"
            "    policy: ask\n"
            f"    workspaceRoot: {session.cwd}\n"
        )
        _fake_preflight.result = (0, dump, "")
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()
        assert FakeTransport.instances[-1].started is False

    _run(scenario)


def test_start_fails_closed_when_target_row_is_duplicated(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        dump = _preflight_dump(session.cwd) + _preflight_dump(session.cwd)
        _fake_preflight.result = (0, dump, "")
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_start_accepts_folded_block_scalar_workspace_root(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        # Path length is irrelevant here: the dumped form is a folded scalar,
        # which is exactly what a long real workspace root produces.
        _fake_preflight.result = (0, _folded_preflight_dump(session.cwd), "")
        await session.start()
        try:
            assert session.session_id == "acp-session-new"
        finally:
            await session.close()

    _run(scenario)


def test_start_fails_closed_when_folded_root_is_in_another_row(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        dump = (
            "- id: approval\n"
            "  config:\n"
            "    policy: ask\n"
            "- id: sandbox-policy\n"
            "  config:\n"
            "    workspaceRoot: /somewhere/else\n"
            "- id: unrelated\n"
            "  config:\n"
            "    workspaceRoot: >-\n"
            f"      {session.cwd}\n"
        )
        _fake_preflight.result = (0, dump, "")
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_start_fails_closed_when_folded_root_is_wrong(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (
            0,
            _folded_preflight_dump(session.cwd, root="/tmp/not-the-workspace"),
            "",
        )
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_start_fails_closed_when_folded_root_carries_a_second_line(
    tmp_path: Path, monkeypatch: Any
) -> None:
    # A continuation line inside the block scalar folds into the value, so an
    # injected second path cannot match the checked cwd.
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        dump = (
            "- id: approval\n"
            "  config:\n"
            "    policy: ask\n"
            "- id: sandbox-policy\n"
            "  config:\n"
            "    workspaceRoot: >-\n"
            f"      {session.cwd}\n"
            f"      {session.cwd}\n"
        )
        _fake_preflight.result = (0, dump, "")
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_start_fails_closed_when_folded_root_key_is_duplicated(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        dump = (
            "- id: approval\n"
            "  config:\n"
            "    policy: ask\n"
            "- id: sandbox-policy\n"
            "  config:\n"
            "    workspaceRoot: >-\n"
            f"      {session.cwd}\n"
            "    workspaceRoot: /tmp/not-the-workspace\n"
        )
        _fake_preflight.result = (0, dump, "")
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_yaml_block_scalars_restore_exact_values() -> None:
    def value_of(header: str, body: list[str]) -> str | None:
        block = "\n".join([f"    workspaceRoot: {header}"] + body)
        values = session_module._yaml_key_values(block, "workspaceRoot")
        return None if values is None else values[0]

    assert value_of(">-", ["      /a/b/c"]) == "/a/b/c"
    assert value_of(">", ["      /a/b/c"]) == "/a/b/c"
    assert value_of("|-", ["      /a/b/c"]) == "/a/b/c"
    assert value_of("|", ["      /a/b/c"]) == "/a/b/c"
    # Folded style joins adjacent lines with a space; literal style keeps the
    # line break. Neither can equal a single filesystem path.
    assert value_of(">-", ["      /a", "      /b"]) == "/a /b"
    assert value_of("|-", ["      /a", "      /b"]) == "/a\n/b"
    # A repeated key is ambiguous, so the row cannot prove the overlay.
    assert (
        session_module._yaml_key_values(
            "    workspaceRoot: /a\n    workspaceRoot: /b", "workspaceRoot"
        )
        is None
    )


def test_block_has_scalar_expands_paths_only_for_path_keys() -> None:
    # A path spelling must be normalized only where a path is expected. A
    # non-path scalar such as ``policy`` stays literal, so an unrelated value
    # cannot match because it resolves to the same filesystem location.
    block = "    policy: ./ask"
    assert session_module._block_has_scalar(block, "policy", {"ask"}) is False
    assert session_module._block_has_scalar(block, "policy", {"./ask"}) is True

    path_block = "    workspaceRoot: ./docs"
    expected = {os.path.abspath("docs")}
    assert (
        session_module._block_has_scalar(
            path_block, "workspaceRoot", expected, is_path=True
        )
        is True
    )
    assert (
        session_module._block_has_scalar(path_block, "workspaceRoot", expected)
        is False
    )


def test_start_accepts_quoted_short_workspace_root(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (0, _preflight_dump(session.cwd), "")
        await session.start()
        try:
            assert session.session_id == "acp-session-new"
        finally:
            await session.close()

    _run(scenario)


def test_start_accepts_unicode_escaped_workspace_root(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        cwd = os.fspath(session.cwd)
        # A non-ASCII path is dumped as \uXXXX escapes when the runtime's YAML
        # emitter is ascii-only; every character must decode back to the cwd.
        escaped = "".join(f"\\u{ord(ch):04x}" for ch in cwd)
        dump = (
            "- id: approval\n"
            "  config:\n"
            "    policy: ask\n"
            "- id: sandbox-policy\n"
            "  config:\n"
            f'    workspaceRoot: "{escaped}"\n'
        )
        _fake_preflight.result = (0, dump, "")
        await session.start()
        try:
            assert session.session_id == "acp-session-new"
        finally:
            await session.close()

    _run(scenario)


def test_start_accepts_realpath_workspace_root(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        real = session.cwd
        link = tmp_path / "linked-workspace"
        link.symlink_to(real, target_is_directory=True)
        # The runtime may canonicalize through a symlink; the pinned root still
        # refers to the same directory and must validate.
        dump = (
            "- id: approval\n"
            "  config:\n"
            "    policy: ask\n"
            "- id: sandbox-policy\n"
            "  config:\n"
            f"    workspaceRoot: {link}\n"
        )
        _fake_preflight.result = (0, dump, "")
        await session.start()
        try:
            assert session.session_id == "acp-session-new"
        finally:
            await session.close()

    _run(scenario)


def test_start_fails_closed_on_name_mismatch_warning(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (
            0,
            _preflight_dump(session.cwd),
            "dsh: [patch] patch: entry \"approval\" name mismatch\n",
        )
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_start_fails_closed_on_patch_warning_in_stdout(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (
            0,
            _preflight_dump(session.cwd)
            + 'dsh: patch: entry "tool-fs" not found\n',
            "",
        )
        with pytest.raises(
            DshAcpSessionError, match="did not apply the ACP policy overlay"
        ):
            await session.start()

    _run(scenario)


def test_start_ignores_unrelated_not_found_text(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        _fake_preflight.result = (
            0,
            _preflight_dump(session.cwd)
            + "- id: notes\n  config:\n    message: value not found in cache\n",
            "warning: settings key not found (non-fatal)\n",
        )
        await session.start()
        try:
            assert session.session_id == "acp-session-new"
        finally:
            await session.close()

    _run(scenario)


def test_start_cancel_during_preflight_closes_transport(
    tmp_path: Path, monkeypatch: Any
) -> None:
    started = asyncio.Event()

    async def hanging_preflight(
        argv: tuple[str, ...], cwd: Path, env: Any, timeout: float
    ) -> tuple[int, str, str]:
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def scenario() -> None:
        session, emitted = _make_session(
            tmp_path, monkeypatch, policy_preflight=hanging_preflight
        )
        task = asyncio.create_task(session.start())
        await asyncio.wait_for(started.wait(), timeout=2.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert FakeTransport.instances[-1].started is False
        assert FakeTransport.instances[-1].closed is True
        assert emitted == []

    _run(scenario)


def _python_preflight_argv(script: str) -> tuple[str, ...]:
    # -S keeps local site-packages .pth noise out of the child's stderr.
    return (sys.executable, "-S", "-c", script)


def test_run_policy_preflight_streams_and_caps_real_output(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        script = (
            "import os, sys\n"
            "print('- id: approval')\n"
            "print('  config:')\n"
            "print('    policy: ask')\n"
            "print('- id: sandbox-policy')\n"
            "print('  config:')\n"
            "print('    workspaceRoot: %s' % os.getcwd())\n"
        )
        code, stdout, stderr = await session_module._run_policy_preflight(
            _python_preflight_argv(script), tmp_path, {}, 10.0
        )
        assert code == 0
        assert stderr == ""
        assert session_module._row_block(stdout, "sandbox-policy") is not None
        assert session_module._is_patch_warning(
            "dsh: patch: entry \"x\" not found"
        )

    _run(scenario)


def test_run_policy_preflight_times_out_and_kills_child(tmp_path: Path) -> None:
    async def scenario() -> None:
        script = "import time; time.sleep(30)"
        with pytest.raises(DshAcpSessionError, match="preflight timed out"):
            await session_module._run_policy_preflight(
                _python_preflight_argv(script), tmp_path, {}, 0.2
            )

    _run(scenario)


def test_run_policy_preflight_rejects_oversized_output(tmp_path: Path) -> None:
    async def scenario() -> None:
        script = "import sys; sys.stdout.write('x' * (5 * 1024 * 1024))"
        with pytest.raises(DshAcpSessionError, match="size limit"):
            await session_module._run_policy_preflight(
                _python_preflight_argv(script), tmp_path, {}, 20.0
            )

    _run(scenario)


def test_run_policy_preflight_cancel_kills_child(tmp_path: Path) -> None:
    async def scenario() -> None:
        pid_file = tmp_path / "pid"
        script = (
            "import os, sys, time\n"
            f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
            "time.sleep(30)\n"
        )
        task = asyncio.create_task(
            session_module._run_policy_preflight(
                _python_preflight_argv(script), tmp_path, {}, 30.0
            )
        )
        for _ in range(200):
            if pid_file.exists() and pid_file.read_text():
                break
            await asyncio.sleep(0.01)
        pid = int(pid_file.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        deadline = asyncio.get_running_loop().time() + 2.0
        while asyncio.get_running_loop().time() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            await asyncio.sleep(0.01)
        raise AssertionError("preflight child survived cancellation")

    _run(scenario)


def test_resume_missing_fails_without_new_session_fallback(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(
            tmp_path, monkeypatch, resume_session_id="acp-session-old"
        )
        FakeTransport.resume_error = DshAcpError("session not found")
        with pytest.raises(DshAcpSessionError, match="failed to resume ACP session"):
            await session.start()
        fake = FakeTransport.instances[-1]
        assert "session/resume" in fake.request_methods()
        assert "session/new" not in fake.request_methods()
        assert fake.closed is True
        assert session.session_id == "acp-session-old"

    _run(scenario)


def test_resume_uses_fixed_params_and_existing_storage(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        first, _ = _make_session(tmp_path, monkeypatch)
        await first.start()
        storage_home = first.home
        await first.close()

        second, _ = _make_session(
            tmp_path, monkeypatch, resume_session_id="acp-session-new"
        )
        await second.start()
        fake = FakeTransport.instances[-1]
        try:
            resume_params = next(
                params for method, params in fake.requests if method == "session/resume"
            )
            assert resume_params == {
                "cwd": os.fspath(second.cwd.resolve()),
                "mcpServers": [],
                "sessionId": "acp-session-new",
            }
            assert second.home == storage_home
            assert "session/new" not in fake.request_methods()
        finally:
            await second.close()

    _run(scenario)


def test_prompt_concurrency_cancel_settles_without_closing_session(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        FakeTransport.stop_reason = "cancelled"
        try:
            prompt_task = asyncio.create_task(session.prompt("do work", "run-1"))
            await fake.prompt_started.wait()
            with pytest.raises(DshAcpSessionError, match="concurrent prompts"):
                await session.prompt("another", "run-2")

            assert await session.cancel() is True
            assert fake.notifications == [
                ("session/cancel", {"sessionId": "acp-session-new"})
            ]
            assert await prompt_task == {"stopReason": "cancelled"}
            # Cancellation never closes the session; the next prompt is legal.
            assert "session/close" not in fake.request_methods()
            assert fake.closed is False
            FakeTransport.stop_reason = "end_turn"
            assert await session.prompt("again", "run-3") == {
                "stopReason": "end_turn"
            }
        finally:
            await session.close()

    _run(scenario)


def test_permission_allow_once_is_auto_selected_without_interaction_event(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        try:
            prompt_task = asyncio.create_task(session.prompt("tool please", "run-1"))
            await fake.prompt_started.wait()

            assert await fake.call_server_request(
                _permission_message("acp-session-new")
            ) == {"outcome": {"outcome": "selected", "optionId": "allow-1"}}
            assert not [
                event
                for event in emitted
                if event["type"].startswith("dsh/v1/interaction.")
            ]
            fake.prompt_release.set()
            await prompt_task
        finally:
            await session.close()

    _run(scenario)


def test_permission_escalation_request_selects_advertised_allow_always(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        try:
            prompt_task = asyncio.create_task(session.prompt("escalate", "run-1"))
            await fake.prompt_started.wait()
            message = _permission_message(
                "acp-session-new",
                options=[
                    {
                        "optionId": "reject-escalation",
                        "kind": "reject_once",
                        "name": "Reject",
                    },
                    {
                        "optionId": "allow-always-escalation",
                        "kind": "allow_always",
                        "name": "Always allow escalation",
                    },
                ],
            )
            message["params"]["toolCall"]["title"] = (
                'Escalate to "danger-full-access"'
            )
            assert await fake.call_server_request(message) == {
                "outcome": {
                    "outcome": "selected",
                    "optionId": "allow-always-escalation",
                }
            }
            assert not [
                event
                for event in emitted
                if event["type"].startswith("dsh/v1/interaction.")
            ]
            fake.prompt_release.set()
            await prompt_task
        finally:
            await session.close()

    _run(scenario)


def test_permission_without_allow_option_is_cancelled(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        try:
            prompt_task = asyncio.create_task(session.prompt("tool", "run-1"))
            await fake.prompt_started.wait()
            assert await fake.call_server_request(
                _permission_message(
                    "acp-session-new",
                    options=[
                        {"optionId": "reject-1", "kind": "reject_once"},
                        {"optionId": "other-1", "kind": "other"},
                    ],
                )
            ) == {"outcome": {"outcome": "cancelled"}}
            assert not [
                event
                for event in emitted
                if event["type"].startswith("dsh/v1/interaction.")
            ]
            fake.prompt_release.set()
            await prompt_task
        finally:
            await session.close()

    _run(scenario)


def test_permission_cross_session_and_missing_tool_id_fail_closed(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        prompt_task = asyncio.create_task(session.prompt("tool", "run-1"))
        await fake.prompt_started.wait()
        try:
            assert await fake.call_server_request(
                _permission_message("acp-session-new", tool_call_id=None)
            ) == {"outcome": {"outcome": "cancelled"}}
            assert await fake.call_server_request(
                _permission_message("acp-session-other")
            ) == {"outcome": {"outcome": "cancelled"}}
            # New auto-approved requests never enter the pending map, so the
            # compatibility resolver fails closed for every id.
            with pytest.raises(DshAcpSessionError, match="no pending permission"):
                await session.resolve_permission(
                    "permission-unknown",
                    "approved",
                    {
                        "sessionId": "acp-session-new",
                        "runtimeId": session.runtime_id or "",
                    },
                )
            assert not [
                event
                for event in emitted
                if event["type"].startswith("dsh/v1/interaction.")
            ]
            fake.prompt_release.set()
            await prompt_task
        finally:
            await session.close()

    _run(scenario)


def test_permission_without_active_run_is_cancelled(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        try:
            # No prompt is in flight, so the approval cannot be attributed to
            # a run; the runtime must be told cancelled and nothing emitted.
            assert await fake.call_server_request(
                _permission_message("acp-session-new")
            ) == {"outcome": {"outcome": "cancelled"}}
            assert not [
                event
                for event in emitted
                if event["type"] == "dsh/v1/interaction.requested"
            ]
        finally:
            await session.close()

    _run(scenario)


def test_storage_key_rejects_path_components(
    tmp_path: Path, monkeypatch: Any
) -> None:
    session, _ = _make_session(tmp_path, monkeypatch)
    index = tmp_path / "index"
    index.mkdir()
    digest = hashlib.sha256(b"sid").hexdigest()
    target = index / f"{digest}.json"
    for poisoned in (".", ".."):
        target.write_text(json.dumps({"storageKey": poisoned}), encoding="utf-8")
        assert session._read_storage_key(index, "sid") is None
    target.write_text(json.dumps({"storageKey": "session-ok"}), encoding="utf-8")
    assert session._read_storage_key(index, "sid") == "session-ok"


def test_permission_without_host_is_auto_approved_and_never_waits(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch, emit=None)
        await session.start()
        fake = FakeTransport.instances[-1]
        prompt_task = asyncio.create_task(session.prompt("tool", "run-1"))
        await fake.prompt_started.wait()
        try:
            # Approval no longer needs a host UI, so a lightweight run
            # completes immediately instead of waiting for a 300s timeout.
            assert emitted == []
            assert await asyncio.wait_for(
                fake.call_server_request(_permission_message("acp-session-new")),
                timeout=1.0,
            ) == {"outcome": {"outcome": "selected", "optionId": "allow-1"}}
            assert not [
                event
                for event in emitted
                if event["type"].startswith("dsh/v1/interaction.")
            ]
            fake.prompt_release.set()
            await prompt_task
        finally:
            await session.close()

    _run(scenario)


def test_close_after_auto_approval_is_idempotent(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        prompt_task = asyncio.create_task(session.prompt("tool", "run-1"))
        await fake.prompt_started.wait()
        assert await fake.call_server_request(
            _permission_message("acp-session-new")
        ) == {"outcome": {"outcome": "selected", "optionId": "allow-1"}}
        await session.close()
        await session.close()
        assert fake.closed is True
        assert ("session/close", {"sessionId": "acp-session-new"}) in fake.requests
        assert not [
            event
            for event in emitted
            if event["type"].startswith("dsh/v1/interaction.")
        ]
        fake.prompt_release.set()
        await prompt_task

    _run(scenario)


def test_cancel_after_auto_approval_emits_no_interaction_events(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, emitted = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        try:
            prompt_task = asyncio.create_task(session.prompt("tool", "run-1"))
            await fake.prompt_started.wait()
            assert await fake.call_server_request(
                _permission_message("acp-session-new")
            ) == {"outcome": {"outcome": "selected", "optionId": "allow-1"}}
            FakeTransport.stop_reason = "cancelled"
            assert await session.cancel() is True
            await prompt_task
            assert not [
                event
                for event in emitted
                if event["type"].startswith("dsh/v1/interaction.")
            ]
        finally:
            await session.close()

    _run(scenario)


def test_close_cancelled_midflight_still_releases_and_retry_converges(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        await session.start()
        fake = FakeTransport.instances[-1]
        gate = asyncio.Event()
        FakeTransport.close_gate = gate

        first = asyncio.create_task(session.close())
        await _wait_for(lambda: "session/close" in fake.request_methods())
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        # The shielded cleanup task is still running: the runtime is not yet
        # released, proving cancellation did not skip transport.close().
        assert fake.closed is False

        gate.set()
        # Retrying close must await the same cleanup rather than return early.
        await session.close()
        assert fake.closed is True
        assert session.session_id == "acp-session-new"

    _run(scenario)


def test_start_failure_cleans_up_transport_and_new_storage(
    tmp_path: Path, monkeypatch: Any
) -> None:
    async def scenario() -> None:
        session, _ = _make_session(tmp_path, monkeypatch)
        FakeTransport.start_error = DshAcpError("spawn failed")
        with pytest.raises(DshAcpSessionError, match="failed to start ACP session"):
            await session.start()
        fake = FakeTransport.instances[-1]
        assert fake.closed is True
        assert not any((tmp_path / "storage" / "workspaces").glob("*/sessions/*"))

    _run(scenario)
