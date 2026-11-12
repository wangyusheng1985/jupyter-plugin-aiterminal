import asyncio
import json
import stat
from contextlib import asynccontextmanager

from jupyter_aiterminal.agent import (
    AgentSession,
    _is_not_connected_error,
    _terminal_reason,
    dsh_storage_root,
    format_sdk_error,
    normalize_session_id,
    sdk_client_kwargs,
    sdk_environment,
)
from jupyter_aiterminal.detached_document import load_workspace
from jupyter_aiterminal.dsh_acp_session import DshAcpSessionError
from jupyter_aiterminal.dsh_config import DshProviderConfig, derive_dsh_budget
from jupyter_aiterminal.pi_client import PiProcessError
from jupyter_aiterminal.settings import AgentConfigError


def _provider_config(token="secret-token"):
    return DshProviderConfig(
        api_protocol="anthropic-messages",
        base_url="https://api.example/v1",
        model="dsh-model",
        context_window=8192,
        max_output_tokens=4096,
        token=token,
    )


def _budget_config(
    context_window=8192, max_output_tokens=4096, token="secret-token"
):
    return DshProviderConfig(
        api_protocol="anthropic-messages",
        base_url="https://api.example/v1",
        model="dsh-model",
        context_window=context_window,
        max_output_tokens=max_output_tokens,
        token=token,
        budget=derive_dsh_budget(
            {
                "contextWindow": context_window,
                "maxOutputTokens": max_output_tokens,
            }
        ),
    )


def _configure_fake_acp(monkeypatch, factory, config=None):
    """Install an in-process ACP session stand-in. Never spawns a runtime."""
    monkeypatch.setattr(
        "jupyter_aiterminal.agent.load_dsh_settings",
        lambda: config or _provider_config(),
    )
    monkeypatch.setattr("jupyter_aiterminal.agent.DshAcpSession", factory)


class _FakeAcpSession:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.emit = kwargs["emit"]
        self.on_notification = kwargs["on_notification"]
        self.resume_session_id = kwargs.get("resume_session_id")
        self._transport = kwargs.get("transport")
        owns_transport = kwargs.get("owns_transport")
        self._owns_transport = (
            self._transport is None if owns_transport is None else owns_transport
        )
        self.config_preflight_proven = False
        self.session_id = None
        self.runtime_id = None
        self.started = False
        self.start_calls = 0
        self.prompts: list[tuple[str, str]] = []
        self.cancels = 0
        self.closes = 0
        self.resolutions: list[tuple[str, str, dict]] = []
        self.start_error: BaseException | None = None
        self.prompt_error: BaseException | None = None
        self.cancel_error: BaseException | None = None
        self.prompt_result = {"stopReason": "end_turn"}
        self.script: list[dict] = []
        self.permission_events: list[dict] = []
        self.new_session_id = "acp-session-0123456789"
        self.new_runtime_id = "runtime-0123456789"
        # Optional gate so a test can hold start() in-flight.
        self.start_gate: asyncio.Event | None = None
        # Session-scoped metadata advertised by the real ACP session.
        self.config_options: list[dict] = []
        self.available_commands: list[dict] = []
        self.config_calls: list[tuple[str, str]] = []

    async def set_config_option(self, config_id, value):
        self.config_calls.append((config_id, value))
        return {"configOptions": self.config_options}

    async def start(self):
        self.start_calls += 1
        if self.start_gate is not None:
            await self.start_gate.wait()
        if self.start_error is not None:
            raise self.start_error
        self.started = True
        if self._transport is None:
            # A real session creates its own transport inside start().
            self._transport = object()
        self.session_id = self.resume_session_id or self.new_session_id
        self.runtime_id = self.new_runtime_id
        self.emit(
            {
                "type": "dsh/v1/session",
                "sessionId": self.session_id,
                "runtimeId": self.runtime_id,
                "phase": "resumed" if self.resume_session_id else "attached",
            }
        )
        self.emit(
            {
                "type": "dsh/v1/capabilities",
                "runtimeId": self.runtime_id,
                "capabilities": {"cancel": {"status": "available"}},
            }
        )

    async def prompt(self, text, run_id):
        self.prompts.append((text, run_id))
        if self.prompt_error is not None:
            raise self.prompt_error
        for notification in self.script:
            await self.on_notification(notification)
        for event in self.permission_events:
            self.emit(event)
        return self.prompt_result

    async def cancel(self):
        self.cancels += 1
        if self.cancel_error is not None:
            raise self.cancel_error
        return True

    async def resolve_permission(self, request_id, decision, scope):
        self.resolutions.append((request_id, decision, dict(scope)))
        return True

    async def close(self):
        self.closes += 1


def _emit_to(events):
    async def emit(event):
        events.append(event)

    return emit


class _FakeStartup:
    def __init__(self, transport):
        self.transport = transport

    @property
    def owns_bootstrap(self):
        return self.transport is None


class _FakeSharedRuntime:
    """In-process stand-in for ``SharedDshRuntime`` configuration wiring."""

    def __init__(self, transport=None):
        self._transport = transport
        self.active_snapshot = None
        self.adopted: list[tuple] = []
        self.bound: list[tuple] = []
        self.start_calls = 0
        self.report_calls: list = []
        self._bootstrap_lock = asyncio.Lock()
        # Set to a different object to simulate a host that refuses adoption.
        self.adopt_override = None

    @asynccontextmanager
    async def transport_startup(self):
        async with self._bootstrap_lock:
            yield _FakeStartup(self._transport)

    def adopt_initialized_transport(
        self, transport, snapshot=None, preflight_proven=False
    ):
        self.adopted.append((transport, snapshot, preflight_proven))
        if self.adopt_override is not None:
            return self.adopt_override
        if self._transport is None:
            self._transport = transport
            self.active_snapshot = snapshot
        return self._transport

    def bind_transport(self, transport, snapshot=None, preflight_proven=False):
        self.bound.append((transport, snapshot, preflight_proven))
        if self._transport is None:
            self._transport = transport
        return self._transport

    async def start(self):
        self.start_calls += 1

    def configuration_report(self, desired=None):
        self.report_calls.append(desired)
        active = self.active_snapshot
        if active is None:
            state = "not-started"
        elif desired is not None and desired != active:
            state = "pending-next-runtime"
        else:
            state = "active"
        return {
            "active": active,
            "desired": desired,
            "state": state,
            "generation": 1 if active is not None else 0,
        }


def _config_events(events):
    return [event for event in events if event["type"] == "configuration"]


def test_start_reports_config_error_without_launching_acp(tmp_path, monkeypatch):
    created = []

    monkeypatch.setattr(
        "jupyter_aiterminal.agent.load_dsh_settings",
        lambda: (_ for _ in ()).throw(
            AgentConfigError(
                "AI Terminal settings are missing. "
                "Open Settings → AI Terminal and set Base URL, Model, and API Token."
            )
        ),
    )
    monkeypatch.setattr(
        "jupyter_aiterminal.agent.DshAcpSession",
        lambda **kwargs: created.append(kwargs),
    )
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path))

    events = []
    asyncio.run(AgentSession(str(tmp_path), _emit_to(events)).start())

    assert created == []
    assert events == [
        {
            "type": "error",
            "code": "config",
            "message": (
                "AI Terminal settings are missing. "
                "Open Settings → AI Terminal and set Base URL, Model, and API Token."
            ),
        }
    ]


def test_start_attaches_acp_session_and_reports_returned_identity(
    tmp_path, monkeypatch
):
    created = []
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.start()
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    assert len(created) == 1
    acp = created[0]
    assert acp.kwargs["cwd"] == str(tmp_path)
    assert acp.kwargs["resume_session_id"] is None
    assert acp.kwargs["storage_root"] == (
        tmp_path / "data" / "aiterminal" / "dsh"
    )
    assert acp.kwargs["storage_root"].is_dir()
    assert stat.S_IMODE(acp.kwargs["storage_root"].stat().st_mode) == 0o700
    # Session identity comes only from ACP; it is never pre-generated.
    assert session.session_id == acp.new_session_id
    assert session.runtime_id == acp.new_runtime_id
    ready = next(event for event in events if event["type"] == "ready")
    assert ready == {
        "type": "ready",
        "sessionId": acp.new_session_id,
        "contextState": "new",
        "model": "dsh-model",
        "cwd": str(tmp_path),
        "running": False,
        "activeTurnId": None,
        "activeCellId": None,
    }
    assert "dsh/v1/session" in {
        event.get("type") for event in events
    }


def test_resume_uses_acp_id_and_reports_unavailable_context(tmp_path, monkeypatch):
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.start_error = DshAcpSessionError(
            "failed to resume ACP session 'acp-123': not found"
        )
        created.append(session)
        return session

    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    _configure_fake_acp(monkeypatch, factory)

    events = []
    asyncio.run(
        AgentSession(str(tmp_path), _emit_to(events), "acp-123").start()
    )

    assert created[0].kwargs["resume_session_id"] == "acp-123"
    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "resume"
    assert "start a new context" in events[0]["message"]
    assert "not found" in events[0]["message"]


def test_concurrent_starts_create_one_acp_session(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    async def run():
        gate = asyncio.Event()

        def factory(**kwargs):
            session = _FakeAcpSession(**kwargs)
            session.start_gate = gate
            created.append(session)
            return session

        _configure_fake_acp(monkeypatch, factory)
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))

        first = asyncio.create_task(session.start())
        await asyncio.sleep(0)
        second = asyncio.create_task(session.start())
        await asyncio.sleep(0)

        # Both starts are in flight, but the lock keeps ACP creation singular
        # and the ready event is emitted only once after start resumes.
        assert len(created) == 1
        assert not any(event["type"] == "ready" for event in events)

        gate.set()
        await asyncio.gather(first, second)
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    assert len(created) == 1
    assert created[0].started is True
    assert session.session_id == created[0].new_session_id
    ready = [event for event in events if event["type"] == "ready"]
    assert len(ready) == 1
    assert ready[0]["sessionId"] == created[0].new_session_id


def test_query_waits_for_in_progress_start(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    async def run():
        gate = asyncio.Event()

        def factory(**kwargs):
            session = _FakeAcpSession(**kwargs)
            session.start_gate = gate
            created.append(session)
            return session

        _configure_fake_acp(monkeypatch, factory)
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))

        starter = asyncio.create_task(session.start())
        await asyncio.sleep(0)
        querier = asyncio.create_task(session.query("hello", "turn-1"))
        await asyncio.sleep(0)

        # The query queues behind the in-progress start: no second ACP session
        # is created and no prompt is issued before start completes.
        assert len(created) == 1
        assert created[0].prompts == []

        gate.set()
        await asyncio.gather(starter, querier)
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    assert len(created) == 1
    assert created[0].prompts == [("hello", "turn-1")]
    assert session.session_id == created[0].new_session_id
    assert sum(1 for event in events if event["type"] == "ready") == 1
    assert any(event["type"] == "result" for event in events)


def test_query_projects_acp_notifications_to_legacy_turn_events(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.script = [
            {
                "method": "session/update",
                "params": {
                    "sessionId": session.new_session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg-1",
                        "content": {"type": "text", "text": "Hel"},
                    },
                },
            },
            {
                "method": "session/update",
                "params": {
                    "sessionId": session.new_session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg-1",
                        "content": {"type": "text", "text": "lo"},
                    },
                },
            },
            {
                "method": "session/update",
                "params": {
                    "sessionId": session.new_session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tool-1",
                        "title": "bash",
                    },
                },
            },
            {
                "method": "session/update",
                "params": {
                    "sessionId": session.new_session_id,
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "tool-1",
                        "status": "completed",
                        "content": [
                            {
                                "type": "content",
                                "content": {"type": "text", "text": "ok\n"},
                            }
                        ],
                    },
                },
            },
        ]
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("hello", "turn-1")
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    event_types = [event["type"] for event in events]
    assert "dsh/v1/run.started" in event_types
    assert "dsh/v1/run.finished" in event_types
    assert "ready" in event_types

    accepted = next(event for event in events if event["type"] == "accepted")
    assert accepted == {
        "type": "accepted",
        "sessionId": session.session_id,
        "turnId": "turn-1",
    }
    text_events = [event for event in events if event["type"] == "text"]
    assert [event["text"] for event in text_events] == ["Hel", "Hello"]
    assert all(event["messageId"] == "msg-1" for event in text_events)
    assert all(event["turnId"] == "turn-1" for event in text_events)

    tool_start = next(event for event in events if event["type"] == "tool_start")
    assert tool_start["id"] == "tool-1"
    assert tool_start["name"] == "bash"
    tool_end = next(event for event in events if event["type"] == "tool_end")
    assert tool_end["id"] == "tool-1"
    assert tool_end["output"] == "ok\n"
    assert tool_end["isError"] is False
    assert tool_end["lineCount"] == 1

    result = next(event for event in events if event["type"] == "result")
    assert result == {
        "type": "result",
        "text": "",
        "isError": False,
        "reason": "completed",
        "sessionId": session.session_id,
        "turnId": "turn-1",
    }


def test_query_reports_cancelled_prompt_as_error_result(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.prompt_result = {"stopReason": "cancelled"}
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("hello", "turn-2")
        await session.interrupt()
        return session, events

    _, events = asyncio.run(run())
    assert created[0].cancels == 1
    result = next(event for event in events if event["type"] == "result")
    assert result["isError"] is True
    assert result["reason"] == "cancelled"
    assert result["turnId"] == "turn-2"


def test_terminal_reason_falls_back_to_status_without_reason():
    # Older run.finished payloads carried only status; map it to the same
    # stable reason vocabulary instead of forcing clients to guess.
    assert _terminal_reason({"status": "completed"}) == "completed"
    assert _terminal_reason({"status": "cancelled"}) == "cancelled"
    assert _terminal_reason({"status": "failed"}) == "failed"
    assert _terminal_reason({}) == "failed"


def test_query_reports_budget_exhausted_terminal(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.prompt_result = {"stopReason": "max_tokens"}
        session.script = [
            {
                "method": "session/update",
                "params": {
                    "sessionId": "acp-session-0123456789",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg-3",
                        "content": {"type": "text", "text": "partial"},
                    },
                },
            }
        ]
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("hello", "turn-3")
        return session, events

    _, events = asyncio.run(run())
    # The streamed assistant text is preserved, but the result event never
    # fabricates or re-sends an assistant body for a budget-limited stop.
    assert [event["text"] for event in events if event["type"] == "text"] == [
        "partial"
    ]
    results = [event for event in events if event["type"] == "result"]
    assert len(results) == 1
    assert results[0]["isError"] is True
    assert results[0]["reason"] == "budget-exhausted"
    assert results[0]["text"] == ""
    # Exactly one prompt: no automatic retry, continue, or replay.
    assert created[0].prompts == [("hello", "turn-3")]


def test_query_distinguishes_failed_from_cancelled_terminal(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.prompt_result = {"stopReason": "refusal"}
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("hello", "turn-4")
        return session, events

    _, events = asyncio.run(run())
    results = [event for event in events if event["type"] == "result"]
    assert len(results) == 1
    assert results[0]["isError"] is True
    assert results[0]["reason"] == "failed"
    assert results[0]["text"] == ""
    assert created[0].prompts == [("hello", "turn-4")]


def test_close_closes_acp_session(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(str(tmp_path), _emit_to([]))
        await session.start()
        await session.close()

    asyncio.run(run())
    assert created[0].closes == 1


def test_resolve_permission_routes_tracked_acp_scope(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.permission_events = [
            {
                "type": "dsh/v1/interaction.requested",
                "sessionId": session.new_session_id,
                "runtimeId": session.new_runtime_id,
                "runId": "turn-3",
                "requestId": "perm-1",
                "kind": "approval",
                "toolCallId": "tool-1",
                "prompt": "Allow the bash tool call?",
                "options": [],
            }
        ]
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(str(tmp_path), _emit_to([]))
        await session.query("hello", "turn-3")
        await asyncio.sleep(0)
        return await session.resolve_permission("perm-1", "approved")

    assert asyncio.run(run()) is True
    request_id, decision, scope = created[0].resolutions[0]
    assert request_id == "perm-1"
    assert decision == "approved"
    assert scope == {
        "sessionId": created[0].new_session_id,
        "runtimeId": created[0].new_runtime_id,
    }


def test_start_failure_can_retry_after_settings_fixed(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    attempts = {"load": 0}

    def load():
        attempts["load"] += 1
        if attempts["load"] == 1:
            raise AgentConfigError("AI Terminal settings are missing.")
        return _provider_config()

    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        created.append(session)
        return session

    monkeypatch.setattr("jupyter_aiterminal.agent.load_dsh_settings", load)
    monkeypatch.setattr("jupyter_aiterminal.agent.DshAcpSession", factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.start()
        await session.query("hello", "turn-1")
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    assert attempts["load"] == 2
    assert len(created) == 1
    assert created[0].started is True
    assert session.session_id == created[0].new_session_id
    assert any(event["type"] == "ready" for event in events)
    assert any(event["type"] == "result" for event in events)


def test_query_after_start_failure_reports_error_and_cleans_up(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.start_error = DshAcpSessionError("runtime failed to start")
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.start()
        await session.query("hello", "turn-1")
        return events

    events = asyncio.run(run())

    errors = [event for event in events if event["type"] == "error"]
    assert errors
    assert errors[-1]["code"] == "runtime"
    assert "runtime failed to start" in errors[-1]["message"]
    # start() and query() each attempt once; the failed instance is closed and
    # never left running, so the query path is never silently swallowed.
    assert len(created) == 2
    assert created[0].closes == 1
    assert not any(event["type"] == "accepted" for event in events)


def test_failed_turn_resumes_same_session_on_new_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        index = len(created)
        session.new_runtime_id = f"runtime-{index}"
        if index == 0:
            session.prompt_error = DshAcpSessionError("runtime died mid-turn")
        else:
            session.permission_events = [
                {
                    "type": "dsh/v1/interaction.requested",
                    "sessionId": session.new_session_id,
                    "runtimeId": session.new_runtime_id,
                    "runId": "turn-2",
                    "requestId": "perm-2",
                    "kind": "approval",
                    "toolCallId": "tool-2",
                    "prompt": "Allow the bash tool call?",
                    "options": [],
                }
            ]
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("first", "turn-1")
        await asyncio.sleep(0)
        first_session_id = session.session_id
        await session.query("second", "turn-2")
        await asyncio.sleep(0)
        return session, events, first_session_id

    session, events, first_session_id = asyncio.run(run())

    # The failed turn is closed as failed (never left running) and the durable
    # session identity survives: the second runtime resumes the same session.
    assert any(
        event["type"] == "dsh/v1/run.finished" and event.get("status") == "failed"
        for event in events
    )
    assert any(
        event["type"] == "error" and event.get("code") == "runtime"
        for event in events
    )
    assert len(created) == 2
    assert created[1].kwargs["resume_session_id"] == first_session_id
    assert created[1].resume_session_id == first_session_id
    assert session.session_id == first_session_id

    # On the same websocket the new runtime generation is announced before the
    # resumed session handshake; otherwise the browser drops the handshake and
    # every activity/approval event that follows.
    connection_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "dsh/v1/connection"
    )
    connection = events[connection_index]
    assert connection["phase"] == "reconnecting"
    assert connection["runtimeId"] == created[1].new_runtime_id
    resumed_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "dsh/v1/session" and event.get("phase") == "resumed"
    )
    assert connection_index < resumed_index

    # Approvals from the resumed runtime carry the durable session id and the
    # new runtime generation, so a client that adopted the reconnect can render
    # them and route the decision back.
    requested = [
        event for event in events if event["type"] == "dsh/v1/interaction.requested"
    ]
    assert len(requested) == 1
    assert requested[0]["sessionId"] == first_session_id
    assert requested[0]["runtimeId"] == created[1].new_runtime_id


async def _run_turn_after_failed_turn(tmp_path, monkeypatch, factory):
    _configure_fake_acp(monkeypatch, factory)
    events = []
    session = AgentSession(str(tmp_path), _emit_to(events))
    await session.query("first", "turn-1")
    await asyncio.sleep(0)
    await session.query("second", "turn-2")
    await asyncio.sleep(0)
    return session, events


def test_failed_turn_resume_failure_reports_resume_error_without_new(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        index = len(created)
        session.new_runtime_id = f"runtime-{index}"
        if index == 0:
            session.prompt_error = DshAcpSessionError("runtime died mid-turn")
        else:
            session.start_error = DshAcpSessionError(
                "failed to resume ACP session: not found"
            )
        created.append(session)
        return session

    _session, events = asyncio.run(
        _run_turn_after_failed_turn(tmp_path, monkeypatch, factory)
    )

    assert len(created) == 2
    assert created[1].resume_session_id == created[0].new_session_id
    resume_errors = [
        event
        for event in events
        if event["type"] == "error" and event.get("code") == "resume"
    ]
    assert len(resume_errors) == 1
    assert resume_errors[0]["sessionId"] == created[0].new_session_id
    assert "start a new context" in resume_errors[0]["message"]
    # No silent replacement session was created for the second turn.
    assert not any(
        event["type"] == "accepted" and event.get("turnId") == "turn-2"
        for event in events
    )
    handshakes = [event for event in events if event["type"] == "dsh/v1/session"]
    assert len(handshakes) == 1
    assert handshakes[0]["runtimeId"] == created[0].new_runtime_id
    assert handshakes[0]["phase"] == "attached"


def test_discard_without_durable_session_reports_resume_unavailable(tmp_path):
    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        acp = _FakeAcpSession(
            emit=lambda event: None,
            on_notification=lambda message: None,
            cwd=str(tmp_path),
            resume_session_id=None,
            storage_root=tmp_path,
        )
        acp.session_id = None
        await session._discard_session(acp)
        return acp, events

    acp, events = asyncio.run(run())

    assert acp.closes == 1
    assert events == [
        {
            "type": "error",
            "code": "resume",
            "message": (
                "Agent context could not be preserved; start a new context "
                "before continuing."
            ),
        }
    ]


def test_start_error_redacts_token(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.start_error = DshAcpSessionError("rejected secret-token value")
        return session

    _configure_fake_acp(monkeypatch, factory)

    events = []
    asyncio.run(AgentSession(str(tmp_path), _emit_to(events)).start())

    message = events[0]["message"]
    assert "secret-token" not in message
    assert "[redacted]" in message


def test_interrupt_reports_transport_exception(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.cancel_error = RuntimeError("transport write failed")
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("hello", "turn-1")
        await session.interrupt()
        return events

    events = asyncio.run(run())

    errors = [event for event in events if event["type"] == "error"]
    assert any("transport write failed" in event["message"] for event in errors)


def test_format_sdk_error_includes_stderr():
    class CLIProcessError(RuntimeError):
        def __init__(self):
            super().__init__("Command failed with exit code 1")
            self.stderr = "--dangerously-skip-permissions cannot be used with root"

    assert "dangerously-skip-permissions" in format_sdk_error(CLIProcessError())
    assert "rate_limit" in format_sdk_error(
        RuntimeError("Command failed with exit code 1"),
        ["API error: rate_limit_error"],
    )


def test_session_id_normalization_is_uuid_only():
    assert (
        normalize_session_id("123E4567-E89B-12D3-A456-426614174000")
        == "123e4567-e89b-12d3-a456-426614174000"
    )
    assert normalize_session_id("") is None
    assert normalize_session_id("../123e4567-e89b-12d3-a456-426614174000") is None
    assert normalize_session_id("x" * 200) is None
    assert normalize_session_id(None) is None


def test_sdk_environment_allows_root_bypass(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/bin")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "minimax-token")
    monkeypatch.setenv("AITERMINAL_CLAUDE_HOME", str(tmp_path / "claude-home"))
    env = sdk_environment(
        {
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "secret",
            "ANTHROPIC_MODEL": "claude-opus-5",
        }
    )
    assert env["IS_SANDBOX"] == "1"
    assert "/usr/local/bin" in env["PATH"]
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "claude-home")
    assert (tmp_path / "claude-home").is_dir()


def test_sdk_client_kwargs_ignore_user_claude_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/bin")
    monkeypatch.setenv("AITERMINAL_CLAUDE_HOME", str(tmp_path / "claude-home"))
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    claude = fake_bin / "claude"
    claude.write_text("#!/bin/sh\n")
    claude.chmod(0o755)
    monkeypatch.setenv("PATH", str(fake_bin))

    async def hook(_input, _id, _ctx):
        return {}

    kwargs = sdk_client_kwargs(
        {
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "secret",
            "ANTHROPIC_MODEL": "claude-opus-5",
        },
        "/tmp",
        hook,
    )
    assert kwargs["setting_sources"] == []
    assert kwargs["system_prompt"]["preset"] == "claude_code"
    assert "do not summarize" in kwargs["system_prompt"]["append"]
    assert "extra_args" not in kwargs
    assert kwargs["cli_path"] == str(claude)
    assert kwargs["env"]["ANTHROPIC_BASE_URL"] == "https://api.anthropic.com"
    assert "stderr" not in kwargs


def test_not_connected_predicate_is_specific():
    not_connected = type("CLIConnectionError", (RuntimeError,), {})
    assert _is_not_connected_error(
        not_connected("Not connected. Call connect() first.")
    )
    assert not _is_not_connected_error(RuntimeError("relay unavailable"))
    assert not _is_not_connected_error(
        not_connected("Not connected. Call connect() first.\nDetails")
    )
    assert _is_not_connected_error(
        PiProcessError("Pi RPC process is not running.")
    )


def test_dsh_storage_root_uses_server_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path))
    assert dsh_storage_root() == tmp_path / "aiterminal" / "dsh"


def test_start_adopts_initialized_transport_with_budget_snapshot(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    config = _budget_config()
    runtime = _FakeSharedRuntime()
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_preflight_proven = True
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory, config)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events), runtime=runtime)
        await session.start()
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    # The first session initialized its own transport; the shared runtime
    # adopts it instead of starting or initializing a second one.
    assert created[0].start_calls == 1
    assert runtime.start_calls == 0
    assert runtime.bound == []
    assert len(runtime.adopted) == 1
    transport, snapshot, proven = runtime.adopted[0]
    assert transport is created[0]._transport
    assert snapshot is config.budget
    assert proven is True
    assert created[0].kwargs["owns_transport"] is True
    assert created[0]._owns_transport is False
    assert session.session_id == created[0].new_session_id

    configuration = _config_events(events)
    assert len(configuration) == 1
    report = configuration[0]["report"]
    assert report["active"] is config.budget
    assert report["desired"] is config.budget
    assert report["state"] == "active"


def test_new_session_reuses_active_snapshot_and_does_not_initialize(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    active_config = _budget_config()
    pending_config = _budget_config(context_window=16384, max_output_tokens=8192)
    shared_transport = object()
    runtime = _FakeSharedRuntime(transport=shared_transport)
    runtime.active_snapshot = active_config.budget
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory, pending_config)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events), runtime=runtime)
        await session.start()
        await asyncio.sleep(0)
        return session, events

    _session, events = asyncio.run(run())

    # An already-active shared runtime is reused as-is: the new session gets
    # the same initialized transport and no second initialize/start happens.
    assert runtime.adopted == []
    assert runtime.bound == []
    assert runtime.start_calls == 0
    assert created[0].start_calls == 1
    assert created[0].kwargs["transport"] is shared_transport
    assert created[0].kwargs["owns_transport"] is False

    # The active snapshot is not replaced by the new session's desired settings.
    assert runtime.active_snapshot is active_config.budget
    report = _config_events(events)[0]["report"]
    assert report["active"] is active_config.budget
    assert report["desired"] is pending_config.budget
    assert report["state"] == "pending-next-runtime"


def test_reemit_handshake_refreshes_configuration_report(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    config = _budget_config()
    runtime = _FakeSharedRuntime()

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_preflight_proven = True
        return session

    _configure_fake_acp(monkeypatch, factory, config)

    async def run():
        session = AgentSession(str(tmp_path), _emit_to([]), runtime=runtime)
        await session.start()
        attached: list[dict] = []
        await session.reemit_handshake(_emit_to(attached))
        return attached

    attached = asyncio.run(run())

    configuration = _config_events(attached)
    assert len(configuration) == 1
    assert configuration[0]["report"]["active"] is config.budget
    assert configuration[0]["report"]["desired"] is config.budget
    # The handshake events are preserved.
    assert any(event["type"] == "ready" for event in attached)


def test_query_on_existing_session_refreshes_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    config = _budget_config()
    runtime = _FakeSharedRuntime()

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_preflight_proven = True
        return session

    _configure_fake_acp(monkeypatch, factory, config)

    async def run():
        events: list[dict] = []
        session = AgentSession(str(tmp_path), _emit_to(events), runtime=runtime)
        await session.start()
        await session.query("hello", "turn-1")
        await asyncio.sleep(0)
        return events, session

    events, session = asyncio.run(run())

    # One configuration event on start and one refresh for the existing
    # session; the runtime is neither restarted nor re-initialized.
    assert len(_config_events(events)) == 2
    assert runtime.start_calls == 0
    assert any(event["type"] == "result" for event in events)
    handshake_config = _config_events(events)[-1]["report"]
    assert handshake_config["desired"] is config.budget
    assert session.session_id == "acp-session-0123456789"


def test_configuration_refresh_read_failure_reports_configuration_error_and_nonfatal(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    config = _budget_config()
    runtime = _FakeSharedRuntime()
    state = {"fail": False}
    created = []

    def load():
        if state["fail"]:
            raise AgentConfigError(
                "AI Terminal settings are incomplete (secret-token)."
            )
        return config

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_preflight_proven = True
        created.append(session)
        return session

    monkeypatch.setattr("jupyter_aiterminal.agent.load_dsh_settings", load)
    monkeypatch.setattr("jupyter_aiterminal.agent.DshAcpSession", factory)

    async def run():
        events: list[dict] = []
        session = AgentSession(str(tmp_path), _emit_to(events), runtime=runtime)
        await session.start()
        state["fail"] = True
        events.clear()
        await session.query("hello", "turn-1")
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    # A desired-read failure must not use the fatal ``config`` error channel;
    # it is reported on a dedicated non-fatal ``configuration-error`` channel
    # with a fixed message, no turn id, and no leaked exception or token.
    assert not [
        event
        for event in events
        if event["type"] == "error" and event.get("code") == "config"
    ]
    config_errors = [
        event for event in events if event["type"] == "configuration-error"
    ]
    assert len(config_errors) == 1
    failure = config_errors[0]
    assert "turnId" not in failure
    assert "code" not in failure
    assert "secret-token" not in failure["message"]
    assert "AI Terminal provider settings could not be refreshed" in failure["message"]

    # The refresh does not fabricate a desired or active snapshot: the report
    # only carries the runtime's real active budget and a null desired.
    report = _config_events(events)[-1]["report"]
    assert report["active"] is config.budget
    assert report["desired"] is None

    # The turn still runs to completion after the non-fatal refresh failure.
    assert any(event["type"] == "result" for event in events)
    assert created[0].prompts == [("hello", "turn-1")]
    assert session.session_id == created[0].new_session_id


def test_start_config_error_and_refresh_error_use_distinct_channels(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    config = _budget_config()

    # Path 1: a real startup config failure stays a fatal ``config`` error.
    def failing_factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.start_error = AgentConfigError(
            "DSH runtime dump-config is missing a config row (secret-token)"
        )
        return session

    _configure_fake_acp(monkeypatch, failing_factory, config)
    start_events: list[dict] = []
    asyncio.run(AgentSession(str(tmp_path), _emit_to(start_events)).start())
    assert start_events[0]["type"] == "error"
    assert start_events[0]["code"] == "config"
    assert not [
        event for event in start_events if event["type"] == "configuration-error"
    ]

    # Path 2: a refresh failure on an existing runtime never becomes that fatal
    # ``config`` error; it uses the dedicated non-fatal channel instead.
    runtime = _FakeSharedRuntime()

    def ok_factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_preflight_proven = True
        return session

    monkeypatch.setattr(
        "jupyter_aiterminal.agent.DshAcpSession", ok_factory
    )
    state = {"fail": False}

    def load():
        if state["fail"]:
            raise AgentConfigError("incomplete (secret-token)")
        return config

    monkeypatch.setattr("jupyter_aiterminal.agent.load_dsh_settings", load)

    async def run():
        events: list[dict] = []
        session = AgentSession(str(tmp_path), _emit_to(events), runtime=runtime)
        await session.start()
        state["fail"] = True
        events.clear()
        await session.query("hello", "turn-2")
        await asyncio.sleep(0)
        return events

    refresh_events = asyncio.run(run())
    assert not [
        event
        for event in refresh_events
        if event["type"] == "error" and event.get("code") == "config"
    ]
    assert [
        event for event in refresh_events if event["type"] == "configuration-error"
    ]
    assert any(event["type"] == "result" for event in refresh_events)


def test_start_preflight_agent_config_error_reports_config_code(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.start_error = AgentConfigError(
            "DSH runtime dump-config is missing the 'compaction-basic' config "
            "row; refusing to start (secret-token)"
        )
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory, _provider_config())

    events: list[dict] = []
    asyncio.run(AgentSession(str(tmp_path), _emit_to(events)).start())

    assert len(events) == 1
    assert events[0]["type"] == "error"
    # A preflight row failure is a configuration failure, not a generic
    # runtime failure, and it never echoes the token.
    assert events[0]["code"] == "config"
    assert "compaction-basic" in events[0]["message"]
    assert "secret-token" not in events[0]["message"]
    assert "[redacted]" in events[0]["message"]
    assert created[0].closes == 1


def test_concurrent_first_starts_share_one_host_transport(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    runtime = _FakeSharedRuntime()
    created = []

    async def run():
        gate = asyncio.Event()

        def factory(**kwargs):
            session = _FakeAcpSession(**kwargs)
            if not created:
                session.start_gate = gate
            created.append(session)
            return session

        _configure_fake_acp(monkeypatch, factory)
        first = AgentSession(str(tmp_path / "a"), _emit_to([]), runtime=runtime)
        second = AgentSession(str(tmp_path / "b"), _emit_to([]), runtime=runtime)

        first_start = asyncio.create_task(first.start())
        await asyncio.sleep(0)
        second_start = asyncio.create_task(second.start())
        await asyncio.sleep(0)

        # The host bootstrap lock is held across the first session's start, so
        # the second caller has not created an ACP session or a transport yet.
        assert len(created) == 1
        assert created[0].start_calls == 1

        gate.set()
        await asyncio.gather(first_start, second_start)
        return first, second

    first, second = asyncio.run(run())

    assert len(created) == 2
    assert len(runtime.adopted) == 1
    assert runtime.adopted[0][0] is created[0]._transport
    # Exactly one child process was spawned and adopted; the second session
    # reused the host transport instead of starting another one.
    assert created[1].kwargs["transport"] is created[0]._transport
    assert created[1].kwargs["owns_transport"] is False
    assert created[0]._owns_transport is False
    assert created[1]._owns_transport is False
    assert runtime._transport is created[0]._transport
    assert first.session_id == created[0].new_session_id
    assert second.session_id == created[1].new_session_id


def test_start_releases_owned_transport_when_host_does_not_adopt(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    runtime = _FakeSharedRuntime()
    runtime.adopt_override = object()
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    events: list[dict] = []
    async def run():
        session = AgentSession(str(tmp_path), _emit_to(events), runtime=runtime)
        await session.start()
        return session

    session = asyncio.run(run())

    # Adoption failed, so the session keeps ownership long enough to close its
    # own child; it never becomes live and no orphan process is left behind.
    assert session._acp is None
    assert created[0].closes == 1
    assert runtime._transport is None
    assert len(runtime.adopted) == 1
    errors = [event for event in events if event["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["code"] == "runtime"
    assert "did not adopt" in errors[0]["message"]


def _write_running_workspace(path):
    path.write_text(
        json.dumps(
            {
                "version": 5,
                "cells": [
                    {
                        "id": "cell-1",
                        "kind": "ai",
                        "source": "hello",
                        "output": "",
                        "blocks": [],
                        "turn": None,
                        "status": "running",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _persisted_turn(path):
    return load_workspace(path)["cells"][0]["turn"]


def test_detached_turn_persists_completed_terminal_reason(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    workspace = _write_running_workspace(tmp_path / "done.agentnb")

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.prompt_result = {"stopReason": "end_turn"}
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(
            str(tmp_path),
            _emit_to([]),
            workspace_file=str(workspace),
            is_detached=lambda: True,
        )
        await session.query("hello", turn_id="turn-1", cell_id="cell-1")

    asyncio.run(run())

    turn = _persisted_turn(workspace)
    assert turn["status"] == "done"
    assert turn["terminalReason"] == "completed"
    assert turn["resultText"] == ""


def test_detached_turn_persists_cancelled_terminal_reason(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    workspace = _write_running_workspace(tmp_path / "cancelled.agentnb")

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.prompt_result = {"stopReason": "cancelled"}
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(
            str(tmp_path),
            _emit_to([]),
            workspace_file=str(workspace),
            is_detached=lambda: True,
        )
        await session.query("hello", turn_id="turn-2", cell_id="cell-1")

    asyncio.run(run())

    turn = _persisted_turn(workspace)
    assert turn["status"] == "error"
    assert turn["terminalReason"] == "cancelled"


def test_detached_turn_persists_failed_terminal_reason(tmp_path, monkeypatch):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    workspace = _write_running_workspace(tmp_path / "failed.agentnb")

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.prompt_error = DshAcpSessionError("runtime died mid-turn")
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(
            str(tmp_path),
            _emit_to([]),
            workspace_file=str(workspace),
            is_detached=lambda: True,
        )
        await session.query("hello", turn_id="turn-3", cell_id="cell-1")

    asyncio.run(run())

    turn = _persisted_turn(workspace)
    assert turn["status"] == "error"
    assert turn["terminalReason"] == "failed"


def test_host_bootstrap_lock_released_after_first_start_failure(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))
    runtime = _FakeSharedRuntime()
    created = []

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        if str(kwargs["cwd"]).endswith("bad"):
            session.start_error = DshAcpSessionError("first child failed")
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        bad = AgentSession(str(tmp_path / "bad"), _emit_to([]), runtime=runtime)
        await bad.start()
        good = AgentSession(str(tmp_path / "good"), _emit_to([]), runtime=runtime)
        await good.start()
        return bad, good

    bad, good = asyncio.run(run())

    # The failed first start released the host bootstrap lock and left no
    # transport installed, so the next session can bootstrap normally.
    assert bad._acp is None
    assert created[0].closes == 1
    assert good._acp is not None
    assert len(runtime.adopted) == 1
    assert runtime._transport is created[1]._transport
    assert created[1]._owns_transport is False


def test_start_emits_model_and_command_metadata(tmp_path, monkeypatch):
    created = []
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_options = [
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": '["provider","model-a"]',
                "options": [
                    {"value": '["provider","model-a"]', "name": "Model A"},
                    {"value": '["provider","model-b"]', "name": "Model B"},
                ],
            }
        ]
        session.available_commands = [
            {"name": "compact", "description": "Compact the context"}
        ]
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.start()
        await asyncio.sleep(0)
        return session, events

    session, events = asyncio.run(run())

    models = [event for event in events if event.get("type") == "models"]
    assert models, events
    assert models[-1]["current"] == '["provider","model-a"]'
    assert models[-1]["models"] == [
        {"id": '["provider","model-a"]', "name": "Model A"},
        {"id": '["provider","model-b"]', "name": "Model B"},
    ]
    commands = [event for event in events if event.get("type") == "commands"]
    assert commands and commands[-1]["commands"] == ["compact"]


def test_set_model_uses_the_model_config_option(tmp_path, monkeypatch):
    created = []
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(str(tmp_path), _emit_to([]))
        await session.start()
        await session.set_model('["provider","model-b"]')
        return session

    session = asyncio.run(run())
    assert created[0].config_calls == [("model", '["provider","model-b"]')]
    assert session._acp is not None


def test_set_model_after_failed_turn_is_applied_when_session_resumes(
    tmp_path, monkeypatch
):
    created = []
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_options = [
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": '["provider","model-a"]',
                "options": [
                    {"value": '["provider","model-a"]', "name": "Model A"},
                    {"value": '["provider","model-b"]', "name": "Model B"},
                ],
            }
        ]
        if not created:
            # The transport raises a plain RuntimeError for a JSON-RPC error
            # response (the 502 upstream stream interruption seen in a cell).
            session.prompt_error = RuntimeError(
                "ACP request id=17 failed: upstream stream interrupted"
            )
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        events = []
        session = AgentSession(str(tmp_path), _emit_to(events))
        await session.query("first", "turn-1")
        await asyncio.sleep(0)
        assert session._acp is None
        after_failure = len(events)
        await session.set_model('["provider","model-b"]')
        await session.query("second", "turn-2")
        await asyncio.sleep(0)
        return session, events, after_failure

    session, events, after_failure = asyncio.run(run())
    after = events[after_failure:]

    # A discarded ACP session must not turn the switch into a dead end: the
    # selection is accepted and echoed to the selector immediately.
    assert not any(
        event.get("type") == "error"
        and "not connected" in str(event.get("message", ""))
        for event in after
    ), after
    models = [event for event in after if event.get("type") == "models"]
    assert models and models[0]["current"] == '["provider","model-b"]'

    # The next prompt resumes the durable session and applies the selection
    # before sending it, so the answer cannot silently use the old model.
    assert len(created) == 2
    assert created[1].resume_session_id == created[0].new_session_id
    assert created[1].config_calls == [("model", '["provider","model-b"]')]
    assert created[1].prompts == [("second", "turn-2")]
    assert session._selected_model == '["provider","model-b"]'


def test_query_reapplies_the_selected_model_when_the_runtime_drifted(
    tmp_path, monkeypatch
):
    created = []
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(tmp_path / "data"))

    def factory(**kwargs):
        session = _FakeAcpSession(**kwargs)
        session.config_options = [
            {
                "id": "model",
                "name": "Model",
                "currentValue": '["provider","model-a"]',
                "options": [
                    {"value": '["provider","model-a"]', "name": "Model A"},
                    {"value": '["provider","model-b"]', "name": "Model B"},
                ],
            }
        ]
        created.append(session)
        return session

    _configure_fake_acp(monkeypatch, factory)

    async def run():
        session = AgentSession(str(tmp_path), _emit_to([]))
        await session.start()
        await session.set_model('["provider","model-b"]')
        # The fake does not mutate its advertised state; this models a runtime
        # that resumed or replaced itself and reports the old selection.
        assert session._acp is not None
        session._acp.config_options[0]["currentValue"] = '["provider","model-a"]'
        await session.query("continue", turn_id="turn-1", cell_id="cell-1")
        return session

    session = asyncio.run(run())
    assert created[0].config_calls == [
        ("model", '["provider","model-b"]'),
        ("model", '["provider","model-b"]'),
    ]
    assert created[0].prompts == [("continue", "turn-1")]
