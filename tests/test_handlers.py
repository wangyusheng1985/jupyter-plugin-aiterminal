import asyncio
import json
from unittest.mock import AsyncMock, Mock

import pytest
from tornado.ioloop import IOLoop

from jupyter_aiterminal.handlers import (
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
