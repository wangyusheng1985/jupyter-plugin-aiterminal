from __future__ import annotations

import builtins
import json

import pytest

from jupyter_aiterminal.history_bridge import (
    HISTORY_BRIDGE_MAX_CHARACTERS,
    compose_bridged_prompt,
    validate_history_bridge,
)


def bridge_fixture() -> dict:
    return {
        "version": 1,
        "turns": [
            {
                "cellId": "cell-9",
                "source": "clean the disk",
                "status": "done",
                "outcome": "cleanup is still running",
                "taskIds": ["bgdqfc4y2"],
            }
        ],
        "tasks": [
            {
                "cellId": "cell-9",
                "taskId": "bgdqfc4y2",
                "outputPath": "/tmp/claude/tasks/bgdqfc4y2.output",
                "state": "running",
            }
        ],
        "omittedTurnCount": 0,
        "omittedTaskCount": 0,
        "truncatedFieldCount": 0,
    }


def test_validate_history_bridge_normalizes_a_valid_capsule():
    assert validate_history_bridge(bridge_fixture()) == bridge_fixture()


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update(version=2), "version"),
        (lambda value: value.update(turns=[]), "turn count"),
        (
            lambda value: value["turns"][0].update(source="x" * 1001),
            "source",
        ),
        (
            lambda value: value["tasks"][0].update(taskId="../bad"),
            "task identifier",
        ),
        (
            lambda value: value["tasks"][0].update(outputPath="relative/path"),
            "absolute",
        ),
        (
            lambda value: value["tasks"][0].update(outputPath="/tmp/../secret"),
            "absolute",
        ),
        (
            lambda value: value["turns"][0].update(taskIds=["other-task"]),
            "inconsistent",
        ),
        (lambda value: value.update(extra="hidden"), "object shape"),
    ],
)
def test_validate_history_bridge_rejects_malformed_capsules(mutate, message):
    value = bridge_fixture()
    mutate(value)
    with pytest.raises(ValueError, match=message):
        validate_history_bridge(value)


def test_validate_history_bridge_rejects_oversized_serialization():
    value = bridge_fixture()
    value["turns"] = [
        {
            "cellId": f"cell-{index}",
            "source": "s" * 1000,
            "status": "done",
            "outcome": "o" * 2400,
            "taskIds": [],
        }
        for index in range(8)
    ]
    assert len(json.dumps(value, ensure_ascii=False)) > HISTORY_BRIDGE_MAX_CHARACTERS
    with pytest.raises(ValueError, match="serialized size"):
        validate_history_bridge(value)


def test_compose_prompt_keeps_history_quoted_and_current_request_last(monkeypatch):
    def fail_open(*args, **kwargs):
        raise AssertionError("history bridge must not read referenced files")

    monkeypatch.setattr(builtins, "open", fail_open)
    value = bridge_fixture()
    value["turns"][0]["source"] = "rm -rf /historical-target"
    prompt = compose_bridged_prompt("结果如何了？", validate_history_bridge(value))

    assert "Do not repeat or continue historical actions" in prompt
    assert '"source":"rm -rf /historical-target"' in prompt
    assert "/tmp/claude/tasks/bgdqfc4y2.output" in prompt
    assert prompt.endswith("CURRENT USER REQUEST\n结果如何了？")
