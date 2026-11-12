"""End-to-end integration test for detached AI turn completion and reopen."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from tornado.ioloop import IOLoop

import jupyter_aiterminal.dsh_acp_session as session_module
from jupyter_aiterminal.agent import AgentSession
from jupyter_aiterminal.detached_document import load_workspace
from jupyter_aiterminal.dsh_config import parse_dsh_provider_config
from jupyter_aiterminal.dsh_runtime_host import SharedDshRuntime
from jupyter_aiterminal.handlers import AgentWebSocketHandler
from jupyter_aiterminal.session_registry import SessionRegistry
from jupyter_aiterminal.settings import AgentConfigError


def _create_workspace_file(path: Path, *, session_id: str | None = None) -> None:
    document: dict = {
        "version": 5,
        "cells": [
            {
                "id": "cell-prompt-1",
                "kind": "ai",
                "source": "hello detached agent",
                "output": "",
                "blocks": [],
                "turn": None,
                "status": "running",
            }
        ],
    }
    if session_id is not None:
        document["active"] = 0
        document["agentSessionId"] = session_id
        document["sessionReference"] = {"engine": "dsh", "sessionId": session_id}
    path.write_text(json.dumps(document), encoding="utf-8")


def _saved_session_link(path: Path) -> dict:
    """Exact persisted link fields a reopened document must still resolve."""
    document = load_workspace(path)
    return {
        "agentSessionId": document["agentSessionId"],
        "sessionReference": document["sessionReference"],
    }


def test_detached_turn_persists_to_document_and_reopen_observes_result(
    tmp_path: Path, monkeypatch
) -> None:
    workspace_file = tmp_path / "test.agentnb"
    _create_workspace_file(workspace_file)

    registry = SessionRegistry()
    emitted_events: list[dict] = []

    async def fake_emit(event: dict) -> None:
        emitted_events.append(event)

    session = AgentSession(
        cwd=str(tmp_path),
        emit=fake_emit,
        resume_session_id="session-detached-test",
        workspace_file=str(workspace_file),
        is_detached=lambda: not registry.attached(session.session_id),
    )
    session.session_id = "session-detached-test"
    registry.remember(session)

    # Browser connects initially
    registry.attach("session-detached-test", fake_emit)
    assert registry.attached("session-detached-test") is True

    # Mock acp runner
    fake_acp = Mock()
    fake_acp.session_id = "session-detached-test"
    fake_acp.runtime_id = "runtime-test"

    async def delayed_prompt(prompt, run_id):
        # Simulate browser disconnecting while prompt is running
        registry.detach("session-detached-test", fake_emit)
        assert registry.attached("session-detached-test") is False
        # Emit a tool event while detached
        await session._emit_event(
            {
                "type": "tool_start",
                "id": "tool-1",
                "name": "Bash",
                "startedAt": 1000,
            }
        )
        await session._emit_event(
            {
                "type": "tool_end",
                "id": "tool-1",
                "name": "Bash",
                "output": "command success",
                "isError": False,
            }
        )
        await session._emit_event(
            {"type": "text", "text": "All tasks finished while you were away."}
        )
        return {"stopReason": "end_turn"}

    fake_acp.prompt = delayed_prompt
    session._acp = fake_acp

    # Run query
    asyncio.run(
        session.query(
            "hello detached agent",
            turn_id="turn-abc",
            cell_id="cell-prompt-1",
        )
    )

    # Verify document on disk was updated while detached!
    saved_doc = load_workspace(workspace_file)
    assert saved_doc["cells"][0]["status"] == "done"
    assert saved_doc["cells"][0]["turn"]["id"] == "turn-abc"
    saved_blocks = saved_doc["cells"][0]["blocks"]
    assert any(b.get("name") == "Bash" for b in saved_blocks)
    assert any("finished while you were away" in b.get("text", "") for b in saved_blocks)

    # Now verify reopen: another browser comes in and attaches
    reopened_events: list[dict] = []

    async def second_client_emit(event: dict) -> None:
        reopened_events.append(event)

    # Attaches to same session
    attached_session = registry.attach("session-detached-test", second_client_emit)
    assert attached_session is session
    assert registry.attached("session-detached-test") is True


def test_attached_turn_leaves_the_document_to_the_browser(
    tmp_path: Path, monkeypatch
) -> None:
    """An attached browser owns the file and avoids a stale contents hash."""
    workspace_file = tmp_path / "test-reopened.agentnb"
    _create_workspace_file(workspace_file)

    registry = SessionRegistry()
    emitted_events: list[dict] = []

    async def fake_emit(event: dict) -> None:
        emitted_events.append(event)

    session = AgentSession(
        cwd=str(tmp_path),
        emit=fake_emit,
        resume_session_id="session-reattached-test",
        workspace_file=str(workspace_file),
        is_detached=lambda: not registry.attached(session.session_id),
    )
    session.session_id = "session-reattached-test"
    registry.remember(session)
    registry.attach("session-reattached-test", fake_emit)

    fake_acp = Mock()
    fake_acp.session_id = "session-reattached-test"
    fake_acp.runtime_id = "runtime-reattached"

    async def prompt(prompt_text, run_id):
        await session._emit_event(
            {"type": "text", "text": "finished after a refresh"}
        )
        return {"stopReason": "end_turn"}

    fake_acp.prompt = prompt
    session._acp = fake_acp

    asyncio.run(
        session.query(
            "hello reattached agent",
            turn_id="turn-reattached",
            cell_id="cell-prompt-1",
        )
    )

    # The attached browser saves its own terminal turn. The server must not
    # replace the file behind JupyterLab's contents hash, which is what makes
    # the next browser save ask whether to overwrite or revert.
    saved = load_workspace(workspace_file)
    cell = saved["cells"][0]
    assert cell["status"] == "running"
    assert cell["turn"] is None
    assert cell["blocks"] == []
    result = next(ev for ev in emitted_events if ev.get("type") == "result")
    assert result.get("turnId") == "turn-reattached"
    assert result.get("cellId") == "cell-prompt-1"


def test_real_handler_open_attach_and_detach_flow(tmp_path: Path, monkeypatch):
    """Directly test AgentWebSocketHandler open(), busy rejection, on_close() and reattach."""
    registry = SessionRegistry()
    loop_callbacks = []
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    class RealCallbackLoop:
        def spawn_callback(self, callback, *args):
            loop_callbacks.append((callback, args))
            outcome = callback(*args)
            if asyncio.iscoroutine(outcome):
                loop.run_until_complete(outcome)

    monkeypatch.setattr(IOLoop, "current", lambda: RealCallbackLoop())

    workspace_file = tmp_path / "handler_test.agentnb"
    _create_workspace_file(workspace_file)

    handler = object.__new__(AgentWebSocketHandler)
    handler.cwd = str(tmp_path)
    handler.application = Mock(settings={"aiterminal_sessions": registry})
    handler.ws_connection = Mock()
    handler.get_query_argument = lambda name, default="": {
        "cwd": "",
        "sessionId": "",
        "dshSessionId": "session-h1",
        "workspacePath": "handler_test.agentnb",
    }.get(name, default)
    emitted = []

    async def fake_emit(event: dict) -> None:
        emitted.append(event)

    handler.emit = fake_emit

    # First connection opens
    handler.open()
    session = handler.session
    assert session is not None
    session.session_id = "session-h1"
    session.runtime_id = "runtime-h1"
    session._acp = Mock(session_id="session-h1", runtime_id="runtime-h1")
    registry.remember(session)
    registry.attach("session-h1", handler.emit)
    handler._attached_session_id = "session-h1"
    assert registry.attached("session-h1") is True
    assert session.is_detached() is False

    # Second connection opens while the first is still attached: it takes
    # over the session instead of being rejected.
    second_handler = object.__new__(AgentWebSocketHandler)
    second_handler.cwd = str(tmp_path)
    second_handler.application = Mock(settings={"aiterminal_sessions": registry})
    second_handler.ws_connection = Mock()
    second_handler.get_query_argument = lambda name, default="": {
        "cwd": "",
        "sessionId": "",
        "dshSessionId": "session-h1",
        "workspacePath": "handler_test.agentnb",
    }.get(name, default)
    second_emitted = []
    second_handler.emit = lambda ev: second_emitted.append(ev)

    second_handler.open()
    assert second_handler.session is session
    assert registry.attached("session-h1") is True
    # The newest browser becomes the authoritative sink for the session.
    assert session.emit is second_handler.emit
    assert not any(
        args and isinstance(args[0], dict) and "already attached" in args[0].get("message", "")
        for _cb, args in loop_callbacks
    )

    # First connection closes (browser refresh / window close), but the
    # session now belongs to the second browser and stays attached.
    # Simulate a turn still running with recorded events. Every replayed event
    # carries both identities so the new page can claim the cell.
    session._running = True
    session._active_turn_id = "turn-live"
    session.active_cell_id = "cell-prompt-1"
    session.turn_events = [
        {
            "type": "accepted",
            "turnId": "turn-live",
            "cellId": "cell-prompt-1",
            "sessionId": "session-h1",
        },
        {
            "type": "tool_start",
            "turnId": "turn-live",
            "cellId": "cell-prompt-1",
            "id": "t1",
            "name": "Bash",
            "input": {},
        },
    ]
    handler.on_close()
    assert registry.attached("session-h1") is True
    assert session.is_detached() is False

    # After a real detach, another browser opens and successfully attaches
    third_handler = object.__new__(AgentWebSocketHandler)
    third_handler.cwd = str(tmp_path)
    third_handler.application = Mock(settings={"aiterminal_sessions": registry})
    third_handler.ws_connection = Mock()
    third_handler.get_query_argument = lambda name, default="": {
        "cwd": "",
        "sessionId": "",
        "dshSessionId": "session-h1",
        "workspacePath": "handler_test.agentnb",
    }.get(name, default)
    third_emitted = []

    async def third_emit(ev: dict) -> None:
        third_emitted.append(ev)

    third_handler.emit = third_emit

    third_handler.open()
    assert third_handler.session is session
    assert registry.attached("session-h1") is True
    assert session.is_detached() is False
    ready = next(ev for ev in third_emitted if ev.get("type") == "ready")
    assert ready.get("contextState") == "resumed"
    assert ready.get("running") is True
    assert ready.get("activeTurnId") == "turn-live"
    assert ready.get("activeCellId") == "cell-prompt-1"
    assert any(ev.get("type") == "dsh/v1/session" and ev.get("phase") == "resumed" for ev in third_emitted)
    replay = next(ev for ev in third_emitted if ev.get("type") == "tool_start")
    assert replay.get("id") == "t1"
    assert replay.get("turnId") == "turn-live"
    assert replay.get("cellId") == "cell-prompt-1"

    # The turn finished while the page was away. Reattach still replays the
    # terminal turn, without claiming it is active.
    session._running = False
    session._active_turn_id = None
    session.active_cell_id = None
    fourth_handler = object.__new__(AgentWebSocketHandler)
    fourth_handler.cwd = str(tmp_path)
    fourth_handler.application = Mock(settings={"aiterminal_sessions": registry})
    fourth_handler.ws_connection = Mock()
    fourth_handler.get_query_argument = lambda name, default="": {
        "cwd": "",
        "sessionId": "",
        "dshSessionId": "session-h1",
        "workspacePath": "handler_test.agentnb",
    }.get(name, default)
    fourth_emitted = []

    async def fourth_emit(ev: dict) -> None:
        fourth_emitted.append(ev)

    fourth_handler.emit = fourth_emit
    fourth_handler.open()
    ready_after_finish = next(
        ev for ev in fourth_emitted if ev.get("type") == "ready"
    )
    assert ready_after_finish.get("running") is False
    assert ready_after_finish.get("activeTurnId") is None
    replayed_finish = next(
        ev for ev in fourth_emitted if ev.get("type") == "tool_start"
    )
    assert replayed_finish.get("turnId") == "turn-live"
    assert replayed_finish.get("cellId") == "cell-prompt-1"


# -- Real AgentSession + SharedDshRuntime + DshAcpSession seam ---------------
#
# The tests below use the real server-side classes and only replace the
# underlying DshAcpTransport. No runtime process, model, or network is used, so
# the assertions still prove the shared-runtime wiring rather than a fake
# SharedDshRuntime with its own semantics.

SECRET_TOKEN = "dsh-integration-secret-token-never-echo"
_PINNED_RUNTIME_VERSION = "0.2.1rc2"


def _provider(context_window: int = 8192, max_output_tokens: int = 4096):
    return parse_dsh_provider_config(
        {
            "apiProtocol": "openai-completions",
            "baseUrl": "https://api.example.test/v1",
            "model": "integration-model",
            "token": SECRET_TOKEN,
            "contextWindow": context_window,
            "maxOutputTokens": max_output_tokens,
        }
    )


def _preflight_dump(cwd: Path, budget, *, include_token_meter: bool = True) -> str:
    """A dump-config result that passes the host preflight."""
    rows = [
        "- id: approval\n  config:\n    policy: ask\n",
        (
            "- id: sandbox-policy\n"
            "  config:\n"
            '    mode: "workspace-write"\n'
            f'    workspaceRoot: "{cwd}"\n'
        ),
    ]
    if include_token_meter:
        rows.append("- id: token-meter\n")
    fields = {
        "auto": "true" if budget.compaction_enabled else "false",
        "thresholdRatio": repr(budget.threshold_ratio),
        "headroomTokens": str(budget.headroom),
        "retainRatio": repr(budget.retain_ratio),
        "maxTokens": str(budget.summary_max_tokens),
    }
    body = "".join(f"    {key}: {value}\n" for key, value in fields.items())
    rows.append(f"- id: compaction-basic\n  config:\n{body}")
    return "".join(rows)


class FakeTransport:
    """Transport double shared by every ACP session on one runtime."""

    instances: list["FakeTransport"] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.argv = (
            "fake-dsh-runtime",
            "--profile",
            "acp",
            "--patch",
            str(kwargs.get("patch_path")),
        )
        self.requests: list[tuple[str, object]] = []
        self.notifications: list[tuple[str, object]] = []
        self.listeners: dict[str, dict] = {}
        self.started = 0
        self.closed = False
        self.hold_prompts = False
        self.prompt_results: dict[str, str] = {}
        self.in_flight: set[str] = set()
        self._next_session = 0
        self._prompt_started: dict[str, asyncio.Event] = {}
        self._prompt_release: dict[str, asyncio.Event] = {}
        FakeTransport.instances.append(self)

    async def start(self) -> None:
        self.started += 1
        # Force a scheduling boundary so concurrent first starts really race.
        await asyncio.sleep(0)

    async def request(self, method: str, params=None, timeout=None):
        self.requests.append((method, params))
        if method == "initialize":
            # Yield inside the handshake too: the bootstrap lock, not luck,
            # must keep a second caller from spawning or initializing again.
            await asyncio.sleep(0)
            return {"protocolVersion": 1}
        if method == "session/new":
            self._next_session += 1
            return {"sessionId": f"session-{self._next_session}"}
        if method == "session/prompt":
            session_id = params["sessionId"]
            self.in_flight.add(session_id)
            self._prompt_started.setdefault(session_id, asyncio.Event()).set()
            try:
                if self.hold_prompts:
                    await self._prompt_release.setdefault(
                        session_id, asyncio.Event()
                    ).wait()
            finally:
                self.in_flight.discard(session_id)
            return {"stopReason": self.prompt_results.get(session_id, "end_turn")}
        if method == "session/close":
            return {}
        return {}

    async def notify(self, method: str, params=None) -> None:
        self.notifications.append((method, params))
        if method == "session/cancel":
            session_id = params["sessionId"]
            self.prompt_results[session_id] = "cancelled"
            self._prompt_release.setdefault(session_id, asyncio.Event()).set()

    async def close(self) -> None:
        self.closed = True

    def add_listener(self, key: str, **kwargs) -> None:
        self.listeners[key] = dict(kwargs)

    def remove_listener(self, key: str) -> None:
        self.listeners.pop(key, None)

    def stderr_tail(self, limit: int = 50) -> list[str]:
        return []

    async def wait_prompt(self, session_id: str) -> None:
        await self._prompt_started.setdefault(session_id, asyncio.Event()).wait()

    def release(self, session_id: str) -> None:
        self._prompt_release.setdefault(session_id, asyncio.Event()).set()

    async def deliver(self, session_id: str, method: str, params: dict) -> None:
        listener = self.listeners.get(session_id)
        handler = (
            listener[0]
            if listener is not None
            else self.kwargs.get("on_notification")
        )
        outcome = handler({"jsonrpc": "2.0", "method": method, "params": params})
        if asyncio.iscoroutine(outcome):
            await outcome


def _install_fake_runtime(monkeypatch, settings: list, *, dump_builder=None):
    FakeTransport.instances = []
    monkeypatch.setattr(session_module, "DshAcpTransport", FakeTransport)
    monkeypatch.setattr(
        session_module, "_installed_runtime_version", lambda: _PINNED_RUNTIME_VERSION
    )
    monkeypatch.setattr(
        "jupyter_aiterminal.agent.load_dsh_settings", lambda: settings[0]
    )

    async def policy_preflight(argv, cwd, env, timeout):
        config = settings[0]
        if dump_builder is not None:
            return 0, dump_builder(cwd, config), ""
        return 0, _preflight_dump(cwd, config.budget), ""

    monkeypatch.setattr(session_module, "_run_policy_preflight", policy_preflight)


def _sink(events: list):
    async def emit(event: dict) -> None:
        events.append(event)

    return emit


def test_real_seam_shares_one_transport_and_cancels_only_one_session(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    settings = [_provider()]
    _install_fake_runtime(monkeypatch, settings)
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    async def scenario() -> None:
        first = AgentSession(cwd=str(alpha), emit=emit, runtime=runtime)
        second = AgentSession(cwd=str(beta), emit=emit, runtime=runtime)
        # Both sessions start concurrently: the forced sleep(0) in the fake
        # transport start/initialize must not let a second child spawn or a
        # second initialize handshake run.
        await asyncio.gather(first.start(), second.start())

        transport = runtime._transport
        assert isinstance(transport, FakeTransport)
        # Exactly one transport instance was ever created and started.
        assert FakeTransport.instances == [transport]
        assert transport.started == 1
        methods = [method for method, _ in transport.requests]
        assert methods.count("initialize") == 1
        assert methods.count("session/new") == 2
        assert first.session_id and second.session_id
        assert first.session_id != second.session_id

        transport.hold_prompts = True
        first_turn = asyncio.create_task(first.query("one", turn_id="turn-a"))
        second_turn = asyncio.create_task(second.query("two", turn_id="turn-b"))
        await transport.wait_prompt(first.session_id)
        await transport.wait_prompt(second.session_id)
        # Both prompts are in flight at the same time on the shared transport.
        assert transport.in_flight == {first.session_id, second.session_id}

        await first.interrupt()
        transport.release(second.session_id)
        await asyncio.gather(first_turn, second_turn)
        await asyncio.sleep(0)

        cancelled = {
            params["sessionId"]
            for method, params in transport.notifications
            if method == "session/cancel"
        }
        assert cancelled == {first.session_id}
        results = {
            (event.get("sessionId"), event.get("reason"))
            for event in events
            if event.get("type") == "result"
        }
        assert (first.session_id, "cancelled") in results
        assert (second.session_id, "completed") in results

        # Closing one ACP session must not close the shared transport.
        await second.close()
        assert transport.closed is False
        assert ("session/close", {"sessionId": second.session_id}) in transport.requests
        assert runtime._transport is transport
        await runtime.close()

    asyncio.run(scenario())


def test_new_session_keeps_first_active_snapshot_and_reports_pending(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    settings = [_provider()]
    _install_fake_runtime(monkeypatch, settings)
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    async def scenario() -> None:
        first = AgentSession(cwd=str(alpha), emit=emit, runtime=runtime)
        await first.start()
        report = runtime.configuration_report(desired=settings[0].budget)
        assert report["state"] == "active"
        # The preflight that proved the overlay is carried into the report.
        assert report["preflightApplied"] is True
        assert report["generation"] == 1
        active = report["active"]

        # Saving new settings while the runtime is live only changes desired.
        settings[0] = _provider(context_window=16384, max_output_tokens=8192)
        second = AgentSession(cwd=str(beta), emit=emit, runtime=runtime)
        await second.start()
        await asyncio.sleep(0)

        transport = runtime._transport
        assert [method for method, _ in transport.requests].count("initialize") == 1
        report = runtime.configuration_report(desired=settings[0].budget)
        assert report["state"] == "pending-next-runtime"
        # A new session on the running runtime reuses the first active snapshot.
        assert report["active"] == active
        assert report["generation"] == 1
        assert report["desired"]["contextWindow"] == 16384
        assert report["preflightApplied"] is True
        latest = next(
            event["report"]
            for event in reversed(events)
            if event.get("type") == "configuration"
        )
        assert latest["state"] == "pending-next-runtime"
        assert latest["active"] == active
        await runtime.close()

    asyncio.run(scenario())


def test_compaction_simulation_keeps_session_link_and_never_claims_observed(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    settings = [_provider()]
    _install_fake_runtime(monkeypatch, settings)
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    async def scenario() -> None:
        agent = AgentSession(cwd=str(tmp_path), emit=emit, runtime=runtime)
        await agent.start()
        transport = runtime._transport
        session_id = agent.session_id
        assert session_id is not None

        await agent.query("first turn", turn_id="turn-1")
        session_new_count = len(
            [method for method, _ in transport.requests if method == "session/new"]
        )
        assert session_new_count == 1

        before = runtime.configuration_report(desired=settings[0].budget)
        active = before["active"]
        generation = before["generation"]
        assert before["state"] == "active"

        # The runtime compacts context inside the live session. ACP exposes no
        # compaction event, only usage_update, so this simulates the turn and
        # must not be reported as an observed compaction.
        transport.hold_prompts = True
        turn = asyncio.create_task(agent.query("second turn", turn_id="turn-2"))
        await transport.wait_prompt(session_id)
        await transport.deliver(
            session_id,
            "session/update",
            {
                "sessionId": session_id,
                "update": {"sessionUpdate": "usage_update", "used": 6000, "size": 8192},
            },
        )
        transport.release(session_id)
        await turn
        await asyncio.sleep(0)

        assert agent.session_id == session_id
        assert (
            len(
                [
                    method
                    for method, _ in transport.requests
                    if method == "session/new"
                ]
            )
            == session_new_count
        )
        # usage_update only proves the session link stayed stable; it never
        # becomes an observed compaction claim.
        after = runtime.configuration_report(desired=settings[0].budget)
        assert after["compaction"] == "not-observable"

        # Saving new settings refreshes only desired: the active snapshot and
        # generation of the live runtime must not move because of simulated
        # usage_update or a later settings change.
        settings[0] = _provider(context_window=16384, max_output_tokens=8192)
        refreshed = runtime.configuration_report(desired=settings[0].budget)
        assert refreshed["state"] == "pending-next-runtime"
        assert refreshed["active"] == active
        assert refreshed["generation"] == generation
        assert refreshed["desired"]["contextWindow"] == 16384

        prompt_sessions = [
            params["sessionId"]
            for method, params in transport.requests
            if method == "session/prompt"
        ]
        assert prompt_sessions == [session_id, session_id]
        configuration_events = [
            event for event in events if event.get("type") == "configuration"
        ]
        assert "observed" not in json.dumps(configuration_events)
        await runtime.close()

    asyncio.run(scenario())


def test_compaction_simulation_preserves_saved_session_link_across_detached_save_and_reopen(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    workspace_file = tmp_path / "compaction-link.agentnb"
    saved_session_id = "session-1"
    _create_workspace_file(workspace_file, session_id=saved_session_id)
    # Exact JSON shape written by the browser before the detached turn; the
    # Python detached writer must only complete the cell, never rewrite the
    # persisted session link.
    expected_link = {
        "agentSessionId": saved_session_id,
        "sessionReference": {"engine": "dsh", "sessionId": saved_session_id},
    }
    assert _saved_session_link(workspace_file) == expected_link

    settings = [_provider()]
    _install_fake_runtime(monkeypatch, settings)
    registry = SessionRegistry()
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    async def scenario() -> None:
        agent = AgentSession(
            cwd=str(tmp_path),
            emit=emit,
            runtime=runtime,
            # Reopen resumes the exact session id stored in the document.
            resume_session_id=saved_session_id,
            workspace_file=str(workspace_file),
            is_detached=lambda: not registry.attached(agent.session_id),
        )
        await agent.start()
        registry.remember(agent)
        registry.attach(agent.session_id, emit)
        assert agent.session_id == saved_session_id

        transport = runtime._transport
        methods = [method for method, _ in transport.requests]
        # The saved reference was resumed, not silently replaced.
        assert "session/resume" in methods
        assert "session/new" not in methods
        assert _saved_session_link(workspace_file) == expected_link

        # This turn runs while the browser is detached and delivers only a
        # usage_update. ACP exposes no compaction event, so the usage update
        # proves the live session link stayed stable; it never becomes an
        # observed compaction claim.
        transport.hold_prompts = True
        turn = asyncio.create_task(
            agent.query("first turn", turn_id="turn-1", cell_id="cell-prompt-1")
        )
        await transport.wait_prompt(agent.session_id)
        registry.detach(agent.session_id, emit)
        assert agent.is_detached() is True
        await transport.deliver(
            agent.session_id,
            "session/update",
            {
                "sessionId": agent.session_id,
                "update": {"sessionUpdate": "usage_update", "used": 6000, "size": 8192},
            },
        )
        transport.release(agent.session_id)
        await turn
        await asyncio.sleep(0)

        assert agent.session_id == saved_session_id
        saved_after_usage = load_workspace(workspace_file)
        assert saved_after_usage["cells"][0]["turn"]["id"] == "turn-1"
        assert _saved_session_link(workspace_file) == expected_link

        # A later detached turn saves again and must keep the same link.
        await agent.query("second turn", turn_id="turn-2", cell_id="cell-prompt-1")
        await asyncio.sleep(0)
        saved_after_turn = load_workspace(workspace_file)
        assert saved_after_turn["cells"][0]["turn"]["id"] == "turn-2"
        assert _saved_session_link(workspace_file) == expected_link

        # Reopening the document and attaching again resolves the same saved
        # reference, and the live session still carries that exact id.
        reopened = load_workspace(workspace_file)
        assert _saved_session_link(workspace_file) == expected_link
        assert reopened["sessionReference"] == expected_link["sessionReference"]
        assert reopened["agentSessionId"] == expected_link["agentSessionId"]

        reopened_events: list[dict] = []
        reopened_emit = _sink(reopened_events)
        attached = registry.attach(reopened["sessionReference"]["sessionId"], reopened_emit)
        assert attached is agent
        await agent.reemit_handshake(reopened_emit)
        ready = next(event for event in reopened_events if event.get("type") == "ready")
        assert ready["sessionId"] == saved_session_id
        assert ready["contextState"] == "resumed"
        assert agent.is_detached() is False

        methods = [method for method, _ in transport.requests]
        assert methods.count("session/resume") == 1
        assert "session/new" not in methods
        assert saved_after_turn["sessionReference"] == {
            "engine": "dsh",
            "sessionId": saved_session_id,
        }
        # The simulated usage_update never becomes an observed compaction
        # claim in the persisted document.
        assert "observed" not in json.dumps(load_workspace(workspace_file))
        await runtime.close()

    asyncio.run(scenario())


def test_preflight_failure_uses_in_cell_config_error_without_token(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    settings = [_provider()]

    def missing_row(cwd: Path, config) -> str:
        # Approval and sandbox are applied, but the token-meter row is absent,
        # which is the dump-config row preflight failure 7.3 covers.
        return _preflight_dump(cwd, config.budget, include_token_meter=False)

    _install_fake_runtime(monkeypatch, settings, dump_builder=missing_row)
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    async def scenario() -> None:
        agent = AgentSession(cwd=str(tmp_path), emit=emit, runtime=runtime)
        await agent.query("hello", turn_id="turn-config")
        await asyncio.sleep(0)

        errors = [
            event
            for event in events
            if event.get("type") == "error" and event.get("code") == "config"
        ]
        assert len(errors) == 1
        assert "token-meter" in errors[0]["message"]
        assert SECRET_TOKEN not in json.dumps(events)
        # The failed preflight never bound a transport to the shared runtime.
        assert runtime._transport is None
        assert FakeTransport.instances[0].closed is True
        assert agent._acp is None

    asyncio.run(scenario())


def test_missing_llm_settings_report_existing_config_error_in_cell(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def missing_settings():
        raise AgentConfigError(
            "AI Terminal settings are missing. Open Settings → AI Terminal and "
            "set Base URL, Model, and API Token."
        )

    monkeypatch.setattr("jupyter_aiterminal.agent.load_dsh_settings", missing_settings)
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    async def scenario() -> None:
        agent = AgentSession(cwd=str(tmp_path), emit=emit, runtime=runtime)
        await agent.query("hello", turn_id="turn-config")
        await asyncio.sleep(0)
        errors = [
            event
            for event in events
            if event.get("type") == "error" and event.get("code") == "config"
        ]
        assert len(errors) == 1
        assert "settings are missing" in errors[0]["message"]
        assert runtime._transport is None
        assert agent._acp is None

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "stop_reason,expected_reason",
    [
        ("max_tokens", "budget-exhausted"),
        ("cancelled", "cancelled"),
        ("error", "failed"),
    ],
)
def test_real_seam_detached_turn_persists_and_reopen_attaches_same_session(
    tmp_path: Path, monkeypatch, stop_reason: str, expected_reason: str
) -> None:
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    workspace_file = tmp_path / "detached.agentnb"
    _create_workspace_file(workspace_file)
    settings = [_provider()]
    _install_fake_runtime(monkeypatch, settings)
    registry = SessionRegistry()
    runtime = SharedDshRuntime()
    events: list[dict] = []
    emit = _sink(events)

    async def scenario() -> str:
        agent = AgentSession(
            cwd=str(tmp_path),
            emit=emit,
            runtime=runtime,
            workspace_file=str(workspace_file),
            is_detached=lambda: not registry.attached(agent.session_id),
        )
        await agent.start()
        registry.remember(agent)
        registry.attach(agent.session_id, emit)

        transport = runtime._transport
        transport.hold_prompts = True
        turn = asyncio.create_task(
            agent.query(
                "hello detached",
                turn_id="turn-budget",
                cell_id="cell-prompt-1",
            )
        )
        await transport.wait_prompt(agent.session_id)

        # Browser disconnects while the prompt is still running.
        registry.detach(agent.session_id, emit)
        assert agent.is_detached() is True
        await transport.deliver(
            agent.session_id,
            "session/update",
            {
                "sessionId": agent.session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "msg-1",
                    "content": {"type": "text", "text": "partial answer"},
                },
            },
        )
        transport.prompt_results[agent.session_id] = stop_reason
        transport.release(agent.session_id)
        await turn
        await asyncio.sleep(0)

        result = next(event for event in events if event.get("type") == "result")
        assert result["reason"] == expected_reason
        saved = load_workspace(workspace_file)
        cell = saved["cells"][0]
        assert cell["status"] == "error"
        turn_data = cell["turn"]
        assert turn_data["id"] == "turn-budget"
        # The persisted turn carries the exact terminal reason; a reopened
        # renderer must not have to infer it from the legacy error status.
        assert turn_data["terminalReason"] == expected_reason
        assert turn_data["status"] == "error"
        assert turn_data["resultText"] == ""
        assert turn_data["resultIsError"] is True
        assert turn_data["metrics"] == {}
        assert set(turn_data["presentation"]) == {
            "trace",
            "expandedActivityIds",
            "fullEvidenceActivityIds",
        }
        assert turn_data["presentation"]["trace"] == "collapsed"
        assert any(
            "partial answer" in block.get("text", "") for block in cell["blocks"]
        )

        # Reopening attaches to the same live session, no replacement session.
        reopened: list[dict] = []
        reopened_emit = _sink(reopened)
        attached = registry.attach(agent.session_id, reopened_emit)
        assert attached is agent
        assert agent.is_detached() is False
        await agent.reemit_handshake(reopened_emit)
        ready = next(event for event in reopened if event.get("type") == "ready")
        assert ready["contextState"] == "resumed"
        # Reopened link/prompt fields must survive the detached save.
        assert ready["sessionId"] == agent.session_id
        assert ready["model"] == agent.model
        assert ready["cwd"] == agent.cwd
        session_event = next(
            event for event in reopened if event.get("type") == "dsh/v1/session"
        )
        assert session_event["phase"] == "resumed"
        assert session_event["sessionId"] == agent.session_id
        assert session_event["runtimeId"] == agent.runtime_id
        assert any(
            event.get("type") == "dsh/v1/connection"
            and event.get("phase") == "connected"
            and event.get("runtimeId") == agent.runtime_id
            for event in reopened
        )
        assert (
            len(
                [
                    method
                    for method, _ in transport.requests
                    if method == "session/new"
                ]
            )
            == 1
        )
        await runtime.close()
        return agent.session_id

    assert asyncio.run(scenario())
