import time
from types import SimpleNamespace

from jupyter_aiterminal.agent import events_from_message


def test_tool_use_and_text_blocks():
    message = SimpleNamespace(
        message_id="message-1",
        content=[
            SimpleNamespace(text="working", name=None, input=None, id=None),
            SimpleNamespace(name="Bash", input={"command": "pwd"}, id="t1", text=None),
        ]
    )
    events = events_from_message(message)
    assert events[0] == {
        "type": "text",
        "text": "working",
        "messageId": "message-1",
    }
    assert events[1] | {"startedAt": 0} == {
        "type": "tool_start",
        "id": "t1",
        "name": "Bash",
        "input": {"command": "pwd"},
        "startedAt": 0,
    }
    assert isinstance(events[1]["startedAt"], int)


def test_thinking_block_does_not_expose_reasoning_text():
    message = SimpleNamespace(
        message_id="message-2",
        content=[SimpleNamespace(thinking="private reasoning", signature="sig")],
    )
    assert events_from_message(message) == [
        {
            "type": "thinking",
            "id": "message-2:0",
            "state": "finished",
        }
    ]


def test_tool_result_includes_size_and_duration_metadata():
    starts = {"t1": time.perf_counter() - 0.01}
    message = SimpleNamespace(
        message_id="message-3",
        content=[
            SimpleNamespace(
                tool_use_id="t1",
                content="one\ntwo\n",
                is_error=False,
                name=None,
            )
        ],
    )
    event = events_from_message(message, tool_started_at=starts)[0]
    assert event["type"] == "tool_end"
    assert event["id"] == "t1"
    assert event["output"] == "one\ntwo\n"
    assert event["lineCount"] == 2
    assert event["byteCount"] == len("one\ntwo\n".encode())
    assert event["durationMs"] >= 0


def test_result_message():
    message = type("ResultMessage", (), {})()
    message.result = "10.9.34.98 is reachable."
    message.is_error = False
    message.content = None
    message.duration_ms = 1200
    message.duration_api_ms = 900
    message.num_turns = 4
    message.total_cost_usd = 0.12
    message.usage = {"input_tokens": 10}
    message.errors = []
    message.permission_denials = []
    message.session_id = "123e4567-e89b-12d3-a456-426614174000"
    assert events_from_message(message)[-1] == {
        "type": "result",
        "text": "10.9.34.98 is reachable.",
        "isError": False,
        "durationMs": 1200,
        "apiDurationMs": 900,
        "numTurns": 4,
        "costUsd": 0.12,
        "usage": {"input_tokens": 10},
        "errors": [],
        "permissionDenials": [],
        "sessionId": "123e4567-e89b-12d3-a456-426614174000",
    }


def test_error_result_keeps_message():
    message = type("ResultMessage", (), {})()
    message.result = "command failed"
    message.is_error = True
    message.content = None
    message.duration_ms = 500
    message.duration_api_ms = 400
    message.num_turns = 1
    message.total_cost_usd = None
    message.usage = None
    message.errors = ["failed"]
    message.permission_denials = []
    message.session_id = None
    assert events_from_message(message)[-1] == {
        "type": "result",
        "text": "command failed",
        "isError": True,
        "durationMs": 500,
        "apiDurationMs": 400,
        "numTurns": 1,
        "costUsd": None,
        "usage": None,
        "errors": ["failed"],
        "permissionDenials": [],
    }


def test_events_are_scoped_to_turn():
    message = type("ResultMessage", (), {})()
    message.result = "done"
    message.is_error = False
    message.content = None
    event = events_from_message(message, turn_id="run-7")[-1]
    assert event["turnId"] == "run-7"
