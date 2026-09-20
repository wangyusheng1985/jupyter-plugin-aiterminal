import json
from unittest.mock import Mock

import pytest
from tornado.ioloop import IOLoop

from jupyter_aiterminal.handlers import AgentWebSocketHandler, _parse_resume_session_id


def test_parse_resume_session_id_accepts_only_uuid():
    assert (
        _parse_resume_session_id("123E4567-E89B-12D3-A456-426614174000")
        == "123e4567-e89b-12d3-a456-426614174000"
    )
    assert _parse_resume_session_id("") is None
    with pytest.raises(ValueError):
        _parse_resume_session_id("../123e4567-e89b-12d3-a456-426614174000")
    with pytest.raises(ValueError):
        _parse_resume_session_id("x" * 200)


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
