import asyncio
import json
from unittest.mock import AsyncMock, Mock

import pytest
from tornado.ioloop import IOLoop

from jupyter_aiterminal.handlers import (
    _CONFIGURATION_REFRESH_ERROR_MESSAGE,
    _NO_SESSION_CONFIGURATION_MESSAGE,
    AgentWebSocketHandler,
    _check_legacy_session_id,
    _parse_dsh_session_id,
)


def test_parse_dsh_session_id_accepts_opaque_acp_ids():
    assert _parse_dsh_session_id("") is None
    assert (
        _parse_dsh_session_id("123e4567-e89b-12d3-a456-426614174000")
        == "123e4567-e89b-12d3-a456-426614174000"
    )
    # ACP ids are opaque, not necessarily legacy UUIDs.
    assert _parse_dsh_session_id("sess_01H:abc-2") == "sess_01H:abc-2"
    for bad in (
        "../123e4567-e89b-12d3-a456-426614174000",
        "sess/child",
        "sess\\child",
        "..",
        "with space",
        "sess\x00id",
        "会话",
        "x" * 300,
    ):
        with pytest.raises(ValueError):
            _parse_dsh_session_id(bad)


def test_legacy_session_id_rejected_unless_it_is_the_dsh_id():
    _check_legacy_session_id("", "dsh-1")
    _check_legacy_session_id("dsh-1", "dsh-1")
    with pytest.raises(ValueError):
        _check_legacy_session_id("123e4567-e89b-12d3-a456-426614174000", None)
    with pytest.raises(ValueError):
        _check_legacy_session_id("old-pi-id", "dsh-1")


class CallbackRecorder:
    def __init__(self):
        self.calls = []

    def spawn_callback(self, callback, *args):
        self.calls.append((callback, args))


class RunningCallbackRecorder(CallbackRecorder):
    """Run scheduled callbacks synchronously so emitted events are observed."""

    def spawn_callback(self, callback, *args):
        super().spawn_callback(callback, *args)
        outcome = callback(*args)
        if asyncio.iscoroutine(outcome):
            asyncio.run(outcome)


def bridge_fixture():
    return {
        "version": 1,
        "turns": [
            {
                "cellId": "cell-1",
                "source": "inspect disk",
                "status": "done",
                "outcome": "cleanup running",
                "taskIds": [],
            }
        ],
        "tasks": [],
        "omittedTurnCount": 0,
        "omittedTaskCount": 0,
        "truncatedFieldCount": 0,
    }


def test_browser_disconnect_detaches_without_closing_ai_session(monkeypatch):
    from jupyter_aiterminal.session_registry import SessionRegistry

    recorder = CallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    registry = SessionRegistry()
    session = Mock()
    session.session_id = "session-1"
    registry.remember(session)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = session
    handler.shell = None
    handler._registry = registry
    handler._attached_session_id = None
    handler.ws_connection = None
    registry.attach("session-1", handler.emit)

    handler.on_close()

    session.close.assert_not_called()
    assert registry.get("session-1") is session
    assert registry.attached("session-1") is False


def test_explicit_shutdown_closes_only_that_ai_session(monkeypatch):
    class RunningLoop(CallbackRecorder):
        def spawn_callback(self, callback, *args):
            super().spawn_callback(callback, *args)
            outcome = callback(*args)
            if asyncio.iscoroutine(outcome):
                asyncio.run(outcome)

    recorder = RunningLoop()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    session = Mock()
    session.session_id = "session-1"
    session.close = AsyncMock()
    handler.session = session
    handler._registry = None
    handler._attached_session_id = "session-1"
    handler.emit = Mock()

    handler.on_message(json.dumps({"type": "shutdown"}))

    session.close.assert_awaited_once()
    assert handler.session is None


def test_invalid_bridge_emits_context_error_without_query(monkeypatch):
    recorder = CallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = Mock()
    handler.emit = Mock()

    handler.on_message(
        json.dumps(
            {
                "type": "user",
                "turnId": "run-bridge",
                "text": "result?",
                "historyBridge": {"version": 999},
            }
        )
    )

    handler.session.query.assert_not_called()
    assert recorder.calls == [
        (
            handler.emit,
            (
                {
                    "type": "error",
                    "code": "context",
                    "message": "History bridge has an invalid object shape.",
                    "turnId": "run-bridge",
                },
            ),
        )
    ]


def fake_handler(monkeypatch):
    recorder = CallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = Mock()
    handler.session.session_id = "session-1"
    handler.session.runtime_id = "runtime-1"
    handler.emit = Mock()
    return handler, recorder


def resolve_message(**overrides):
    payload = {
        "type": "dsh/v1/interaction.resolve",
        "requestId": "perm-1",
        "resolution": "approved",
        "scope": {
            "sessionId": "session-1",
            "runtimeId": "runtime-1",
            "runId": "run-1",
        },
    }
    payload.update(overrides)
    return json.dumps(payload)


def test_interaction_resolve_routes_valid_decision(monkeypatch):
    handler, recorder = fake_handler(monkeypatch)

    handler.on_message(resolve_message())

    assert recorder.calls == [
        (
            handler._resolve_permission,
            (
                "perm-1",
                "approved",
                {
                    "sessionId": "session-1",
                    "runtimeId": "runtime-1",
                    "runId": "run-1",
                },
            ),
        )
    ]


@pytest.mark.parametrize(
    "payload",
    [
        resolve_message(resolution="allow"),
        resolve_message(resolution=None),
        resolve_message(requestId=""),
        resolve_message(requestId="a" * 300),
        resolve_message(requestId=123),
        resolve_message(scope=None),
        resolve_message(scope=["session-1"]),
        resolve_message(scope={"sessionId": "session-1"}),
        resolve_message(
            scope={"sessionId": "session-1", "runtimeId": "runtime-1", "action": "x"}
        ),
        resolve_message(
            scope={"sessionId": "other", "runtimeId": "runtime-1"}
        ),
        resolve_message(
            scope={"sessionId": "session-1", "runtimeId": "other"}
        ),
        resolve_message(
            scope={"sessionId": "session-1", "runtimeId": "runtime-1", "runId": 7}
        ),
    ],
)
def test_interaction_resolve_rejects_malformed_decisions(monkeypatch, payload):
    handler, recorder = fake_handler(monkeypatch)

    handler.on_message(payload)

    assert len(recorder.calls) == 1
    callback, args = recorder.calls[0]
    assert callback == handler.emit
    event = args[0]
    assert event["type"] == "error"
    assert event["code"] == "permission"
    assert "message" in event
    assert "resolution" not in event


def test_interaction_resolve_rejects_non_object_payload(monkeypatch):
    handler, recorder = fake_handler(monkeypatch)

    handler.on_message(json.dumps(["dsh/v1/interaction.resolve"]))

    assert recorder.calls == [
        (
            handler.emit,
            (
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "Invalid agent message.",
                },
            ),
        )
    ]


def test_resolve_permission_uses_tracked_scope_and_safe_errors(monkeypatch):
    handler, recorder = fake_handler(monkeypatch)
    handler.session.resolve_permission = AsyncMock(return_value=True)
    scope = {"sessionId": "session-1", "runtimeId": "runtime-1"}

    asyncio.run(handler._resolve_permission("perm-1", "rejected", scope))
    handler.session.resolve_permission.assert_awaited_once_with("perm-1", "rejected")
    assert recorder.calls == []

    handler.session.resolve_permission = AsyncMock(
        side_effect=RuntimeError("token=secret")
    )
    asyncio.run(handler._resolve_permission("perm-1", "rejected", scope))
    callback, args = recorder.calls[-1]
    assert callback == handler.emit
    assert args[0] == {
        "type": "error",
        "code": "permission",
        "sessionId": "session-1",
        "runtimeId": "runtime-1",
        "message": "Permission request could not be resolved.",
    }


def test_valid_bridge_schedules_composed_prompt(monkeypatch):
    recorder = CallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = Mock()
    handler.emit = Mock()

    handler.on_message(
        json.dumps(
            {
                "type": "user",
                "turnId": "run-bridge",
                "text": "结果如何了？",
                "historyBridge": bridge_fixture(),
            },
            ensure_ascii=False,
        )
    )

    assert len(recorder.calls) == 1
    callback, args = recorder.calls[0]
    assert callback == handler.session.query
    assert args[1] == "run-bridge"
    assert args[0].endswith("CURRENT USER REQUEST\n结果如何了？")


def test_configuration_request_emits_report_without_turn(monkeypatch):
    from jupyter_aiterminal.session_registry import SessionRegistry

    recorder = RunningCallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    registry = SessionRegistry()
    session = Mock()
    session.session_id = "session-1"
    session.is_running = True
    session.query = Mock()
    session.start = Mock()
    report = {"state": "active", "active": None, "desired": None}
    events = [{"type": "configuration", "report": report}]
    session._configuration_events = Mock(return_value=events)
    registry.remember(session)

    handler = object.__new__(AgentWebSocketHandler)
    handler.session = session
    handler._registry = registry
    handler._attached_session_id = "session-1"
    handler.emit = AsyncMock()
    registry.attach("session-1", handler.emit)
    other_handler = object.__new__(AgentWebSocketHandler)
    other_handler.emit = AsyncMock()

    handler.on_message(json.dumps({"type": "configuration"}))

    handler.emit.assert_called_once_with(events[0])
    other_handler.emit.assert_not_called()
    session.query.assert_not_called()
    session.start.assert_not_called()
    assert session.is_running is True
    assert recorder.calls == [(handler.refresh_configuration, ())]


def test_configuration_request_on_running_session_keeps_busy(monkeypatch):
    recorder = RunningCallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = Mock()
    handler.session.session_id = "session-1"
    handler.session.is_running = True
    handler.session.query = Mock()
    handler.session.start = Mock()
    handler.session._configuration_events = Mock(return_value=[])
    handler.emit = AsyncMock()

    handler.on_message(json.dumps({"type": "configuration"}))

    handler.emit.assert_not_called()
    handler.session.query.assert_not_called()
    handler.session.start.assert_not_called()
    assert handler.session.is_running is True


def test_configuration_request_without_session_emits_dedicated_error(monkeypatch):
    recorder = RunningCallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = None
    handler._registry = None
    handler._attached_session_id = None
    handler.emit = AsyncMock()

    handler.on_message(json.dumps({"type": "configuration"}))

    handler.emit.assert_called_once_with(
        {
            "type": "configuration-error",
            "message": _NO_SESSION_CONFIGURATION_MESSAGE,
        }
    )
    event = handler.emit.call_args[0][0]
    assert event["type"] != "error"
    assert "code" not in event


def test_configuration_refresh_failure_uses_fixed_message(monkeypatch):
    recorder = RunningCallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = Mock()
    handler.session._configuration_events = Mock(
        side_effect=RuntimeError("token=secret")
    )
    handler.emit = AsyncMock()

    handler.on_message(json.dumps({"type": "configuration"}))

    handler.emit.assert_called_once_with(
        {
            "type": "configuration-error",
            "message": _CONFIGURATION_REFRESH_ERROR_MESSAGE,
        }
    )
    assert "secret" not in handler.emit.call_args[0][0]["message"]


def test_user_message_without_session_emits_error(monkeypatch):
    recorder = CallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = None
    handler._registry = None
    handler._attached_session_id = None
    handler.emit = Mock()

    handler.on_message(json.dumps({"type": "user", "text": "hi"}))

    assert recorder.calls == [
        (
            handler.emit,
            (
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "AI session is not connected. Please reload the workspace.",
                },
            ),
        )
    ]


def test_user_message_recovers_session_from_registry(monkeypatch):
    from jupyter_aiterminal.session_registry import SessionRegistry

    recorder = CallbackRecorder()
    monkeypatch.setattr(IOLoop, "current", lambda: recorder)
    registry = SessionRegistry()
    session = Mock()
    session.session_id = "session-1"
    registry.remember(session)
    handler = object.__new__(AgentWebSocketHandler)
    handler.session = None
    handler._registry = registry
    handler._attached_session_id = "session-1"
    handler.emit = Mock()

    handler.on_message(json.dumps({"type": "user", "text": "hi", "turnId": "run-1"}))

    assert handler.session is session
    assert session.emit is handler.emit
    assert recorder.calls[0][0] == session.query
    assert recorder.calls[0][1][0] == "hi"
    assert recorder.calls[0][1][1] == "run-1"
