from types import SimpleNamespace

from jupyter_aiterminal.agent import events_from_message


def test_tool_use_and_text_blocks():
    message = SimpleNamespace(
        content=[
            SimpleNamespace(text="working", name=None, input=None, id=None),
            SimpleNamespace(name="Bash", input={"command": "pwd"}, id="t1", text=None),
        ]
    )
    assert events_from_message(message) == [
        {"type": "text", "text": "working"},
        {
            "type": "tool_start",
            "id": "t1",
            "name": "Bash",
            "input": {"command": "pwd"},
        },
    ]


def test_result_message():
    message = type("ResultMessage", (), {})()
    message.result = "10.9.34.98 is reachable."
    message.is_error = False
    message.content = None
    assert events_from_message(message)[-1] == {
        "type": "result",
        "text": "",
        "isError": False,
    }


def test_error_result_keeps_message():
    message = type("ResultMessage", (), {})()
    message.result = "command failed"
    message.is_error = True
    message.content = None
    assert events_from_message(message)[-1] == {
        "type": "result",
        "text": "command failed",
        "isError": True,
    }
