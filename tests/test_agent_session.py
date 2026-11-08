import asyncio
import stat

from jupyter_aiterminal.agent import (
    AgentSession,
    _is_not_connected_error,
    dsh_storage_root,
    format_sdk_error,
    normalize_session_id,
    sdk_client_kwargs,
    sdk_environment,
)
from jupyter_aiterminal.dsh_acp_session import DshAcpSessionError
from jupyter_aiterminal.dsh_config import DshProviderConfig
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
        self.session_id = None
        self.runtime_id = None
        self.started = False
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

    async def start(self):
        if self.start_gate is not None:
            await self.start_gate.wait()
        if self.start_error is not None:
            raise self.start_error
        self.started = True
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
    assert result["turnId"] == "turn-2"


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
