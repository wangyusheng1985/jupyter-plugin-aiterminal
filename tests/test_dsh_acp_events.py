"""Contract tests for the pure ACP-to-DSH product event projector.

Samples reproduce the real ACP ``session/update`` shapes. The envelope and
kind set come from the isolated gate probe against ``deepseek_harness_sdk``/
``deepseek_harness_runtime`` ``0.2.1rc2``
(``/private/var/folders/91/8yyb5wfn35vcbxnxwpms2vxr0000gn/T/dsh-acp-probe.5x0c0g``).
The exact emitted fields come from the published ``@deepseek-ai/dsh-acp``
``0.2.1-rc.2`` package that probe installed
(``probe-home/.cache/pkg/.../@deepseek-ai/dsh-acp/lib/index.js``):

* envelope ``params = {sessionId, update}`` with
  ``update.sessionUpdate`` naming the kind (probe observation);
* ``agent_message_chunk`` ``{messageId, content: {type: "text", text}}``
  (published package ``assistantUpdates``; ``messageId`` is release behavior,
  not only master);
* ``tool_call`` ``{toolCallId, title, kind, status, rawInput}`` (published
  ``toolCallUpdate``);
* ``tool_call_update`` ``{toolCallId, status, content: [{type: "content",
  content: {type: "text", text}}]}`` (published ``toolResultUpdate``);
* a prompt response ``{stopReason}``.

The local harness master checkout agrees but is corroboration only. No SDK,
model, network, or private payload is used. ``PUBLISHED_ACP_0_2_1_RC2_UPDATES``
below is the complete observed release shape, with a fake key-free command and
no sensitive fields.
"""

from __future__ import annotations

import json

import pytest

from jupyter_aiterminal.dsh_acp_events import (
    OUTPUT_SUMMARY_MAX_CHARACTERS,
    DshAcpEventProjector,
)

SESSION_ID = "session-acp-contract"
RUNTIME_ID = "runtime-gen-1"
RUN_ID = "run-acp-contract-1"


def _projector(**overrides: str) -> DshAcpEventProjector:
    values = {
        "session_id": SESSION_ID,
        "runtime_id": RUNTIME_ID,
        "run_id": RUN_ID,
        **overrides,
    }
    return DshAcpEventProjector(**values)


def _notification(update: dict, *, session_id: str = SESSION_ID) -> tuple[str, dict]:
    return "session/update", {"sessionId": session_id, "update": update}


def _chunk(text: str, *, message_id: str = "msg_acp_1") -> tuple[str, dict]:
    return _notification(
        {
            "sessionUpdate": "agent_message_chunk",
            "messageId": message_id,
            "content": {"type": "text", "text": text},
        }
    )


def _tool_call(
    *,
    tool_call_id: str = "call_acp_1",
    title: str = "bash",
    raw_input: object = None,
) -> tuple[str, dict]:
    return _notification(
        {
            "sessionUpdate": "tool_call",
            "toolCallId": tool_call_id,
            "title": title,
            "kind": "other",
            "status": "in_progress",
            "rawInput": raw_input if raw_input is not None else {"command": "printf probe"},
        }
    )


def _tool_update(
    *,
    tool_call_id: str = "call_acp_1",
    status: str | None = "completed",
    text: str | None = None,
) -> tuple[str, dict]:
    update: dict = {
        "sessionUpdate": "tool_call_update",
        "toolCallId": tool_call_id,
    }
    if status is not None:
        update["status"] = status
    if text is not None:
        update["content"] = [
            {"type": "content", "content": {"type": "text", "text": text}}
        ]
    return _notification(update)


def test_constructor_requires_explicit_identity() -> None:
    with pytest.raises(ValueError):
        DshAcpEventProjector("", RUNTIME_ID, RUN_ID)
    with pytest.raises(ValueError):
        DshAcpEventProjector(SESSION_ID, "", RUN_ID)
    with pytest.raises(ValueError):
        DshAcpEventProjector(SESSION_ID, RUNTIME_ID, "")


def test_begin_emits_one_run_started_with_host_owned_run_id() -> None:
    projector = _projector()
    expected = [
        {
            "type": "dsh/v1/run.started",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
        }
    ]
    assert projector.begin() == expected
    assert projector.begin() == []
    assert expected[0]["runId"] != expected[0]["sessionId"]


def test_agent_message_chunk_first_is_snapshot_then_ordered_deltas() -> None:
    projector = _projector()
    assert projector.project_notification(*_chunk("Hello ")) == [
        {
            "type": "dsh/v1/text.snapshot",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": "msg_acp_1",
            "text": "Hello ",
        }
    ]
    assert projector.project_notification(*_chunk("world")) == [
        {
            "type": "dsh/v1/text.delta",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": "msg_acp_1",
            "delta": "world",
        }
    ]


def test_identical_incremental_text_is_not_deduplicated() -> None:
    """Chunks have no sequence number, so a repeated word is legitimate."""
    projector = _projector()
    first = projector.project_notification(*_chunk("ha"))
    second = projector.project_notification(*_chunk("ha"))
    third = projector.project_notification(*_chunk("!"))
    assert first[0]["type"] == "dsh/v1/text.snapshot"
    assert first[0]["text"] == "ha"
    assert second == [
        {
            "type": "dsh/v1/text.delta",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": "msg_acp_1",
            "delta": "ha",
        }
    ]
    assert third[0]["delta"] == "!"
    assembled = first[0]["text"] + second[0]["delta"] + third[0]["delta"]
    assert assembled == "haha!"


def test_distinct_message_ids_get_distinct_snapshots() -> None:
    projector = _projector()
    first = projector.project_notification(*_chunk("one", message_id="msg_a"))
    second = projector.project_notification(*_chunk("two", message_id="msg_b"))
    assert first[0]["type"] == "dsh/v1/text.snapshot"
    assert second[0]["type"] == "dsh/v1/text.snapshot"
    assert second[0]["messageId"] == "msg_b"


def test_thought_chunks_project_accumulated_thinking_activity() -> None:
    projector = _projector()
    first = projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "thought_1",
                "content": {"type": "thinking", "text": "step "},
            }
        )
    )
    second = projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "thought_1",
                "content": {"type": "thinking", "text": "one"},
            }
        )
    )
    assert first == [
        {
            "type": "dsh/v1/activity",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "activityId": "thought:thought_1",
            "phase": "started",
            "label": "thinking",
            "outputSummary": "step ",
        }
    ]
    assert second[0]["phase"] == "updated"
    assert second[0]["outputSummary"] == "step one"


def test_message_chunk_with_thinking_content_projects_thought() -> None:
    projector = _projector()
    events = projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "agent_message_chunk",
                "messageId": "thought_2",
                "content": {"type": "thinking", "thinking": "reasoning"},
            }
        )
    )
    assert events[0]["label"] == "thinking"
    assert events[0]["outputSummary"] == "reasoning"


def test_thought_text_content_block_accumulates_reasoning() -> None:
    """A thought update may carry a plain ACP text ContentBlock, not ``thinking``."""
    projector = _projector()
    first = projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "thought_text_1",
                "content": {"type": "text", "text": "consider "},
            }
        )
    )
    second = projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "thought_text_1",
                "content": {"type": "text", "text": "options"},
            }
        )
    )
    assert first[0]["activityId"] == "thought:thought_text_1"
    assert first[0]["phase"] == "started"
    assert first[0]["outputSummary"] == "consider "
    assert second[0]["phase"] == "updated"
    assert second[0]["outputSummary"] == "consider options"


def test_thought_without_message_id_reuses_one_synthetic_id() -> None:
    """Missing ids must not fragment one streamed thought into many rows."""
    projector = _projector()

    def thought(text: str) -> tuple[str, dict]:
        return _notification(
            {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "thinking", "text": text},
            }
        )

    first = projector.project_notification(*thought("step "))
    second = projector.project_notification(*thought("one"))
    assert first[0]["activityId"] == f"{RUN_ID}:thought#1"
    assert first[0]["phase"] == "started"
    assert second[0]["activityId"] == first[0]["activityId"]
    assert second[0]["phase"] == "updated"
    assert second[0]["outputSummary"] == "step one"


def test_finish_closes_open_thought_as_finished() -> None:
    """Run completion flips a still-streaming thought to ``finished``."""
    projector = _projector()
    projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "thought_final",
                "content": {"type": "thinking", "text": "reasoning"},
            }
        )
    )
    events = projector.finish({"stopReason": "end_turn"})
    assert events[0]["type"] == "dsh/v1/run.finished"
    assert events[0]["status"] == "completed"
    finished = events[1]
    assert finished["type"] == "dsh/v1/activity"
    assert finished["activityId"] == "thought:thought_final"
    assert finished["phase"] == "finished"
    assert finished["label"] == "thinking"
    assert finished["outputSummary"] == "reasoning"


def test_tool_call_projects_started_activity_with_raw_input() -> None:
    projector = _projector()
    raw_input = {"command": "printf probe"}
    events = projector.project_notification(*_tool_call(raw_input=raw_input))
    assert events == [
        {
            "type": "dsh/v1/activity",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "activityId": "call_acp_1",
            "phase": "started",
            "toolCallId": "call_acp_1",
            "toolName": "bash",
            "rawInput": raw_input,
        }
    ]


def test_tool_call_without_raw_input_omits_the_field() -> None:
    projector = _projector()
    events = projector.project_notification(
        *_notification(
            {
                "sessionUpdate": "tool_call",
                "toolCallId": "call_acp_1",
                "title": "bash",
            }
        )
    )
    assert events[0]["phase"] == "started"
    assert "rawInput" not in events[0]


def test_tool_call_update_completed_projects_bounded_output_summary() -> None:
    projector = _projector()
    projector.project_notification(*_tool_call())
    long_text = "x" * (OUTPUT_SUMMARY_MAX_CHARACTERS + 50)
    events = projector.project_notification(*_tool_update(text=long_text))
    assert len(events) == 1
    event = events[0]
    assert event["phase"] == "finished"
    assert event["status"] == "ok"
    assert event["toolName"] == "bash"
    assert len(event["outputSummary"]) == OUTPUT_SUMMARY_MAX_CHARACTERS + 1
    assert event["outputSummary"].endswith("\u2026")
    assert "rawInput" not in event


def test_tool_call_update_failed_projects_error_and_is_idempotent() -> None:
    projector = _projector()
    projector.project_notification(*_tool_call())
    denied = (
        'Error: the user rejected escalating this command to "danger-full-access"; '
        "it stays denied, so stop and explain instead of working around it"
    )
    events = projector.project_notification(
        *_tool_update(status="failed", text=denied)
    )
    assert events[0]["phase"] == "finished"
    assert events[0]["status"] == "error"
    assert events[0]["outputSummary"] == denied
    assert projector.project_notification(*_tool_update(status="failed", text=denied)) == []


def test_non_terminal_tool_update_is_updated_and_cannot_rename_the_tool() -> None:
    projector = _projector()
    projector.project_notification(*_tool_call(title="bash"))
    updated = projector.project_notification(
        *_tool_update(status="in_progress", text="working")
    )
    assert updated[0]["phase"] == "updated"
    assert "status" not in updated[0]
    assert updated[0]["toolName"] == "bash"
    assert projector.project_notification(*_tool_call(title="renamed")) == []


def test_unknown_tool_status_is_ignored() -> None:
    projector = _projector()
    projector.project_notification(*_tool_call())
    assert projector.project_notification(*_tool_update(status="teleported")) == []


@pytest.mark.parametrize(
    ("prompt_result", "status"),
    [
        ({"stopReason": "end_turn"}, "completed"),
        ({"stopReason": "cancelled"}, "cancelled"),
        ({"stopReason": "max_tokens"}, "failed"),
        ({"stopReason": "max_turn_requests"}, "failed"),
        ({"stopReason": "refusal"}, "failed"),
        ({"stopReason": "future_reason"}, "failed"),
        ({}, "failed"),
        (None, "failed"),
    ],
)
def test_finish_maps_stop_reason_to_terminal_status(
    prompt_result: object, status: str
) -> None:
    projector = _projector()
    assert projector.finish(prompt_result) == [
        {
            "type": "dsh/v1/run.finished",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "status": status,
        }
    ]


def test_finish_error_is_failed_terminal_and_terminal_is_idempotent() -> None:
    projector = _projector()
    terminal = projector.finish_error(RuntimeError("boom with raw payload"))
    assert terminal[0]["status"] == "failed"
    assert "boom" not in json.dumps(terminal)
    assert projector.finish({"stopReason": "end_turn"}) == []
    assert projector.finish_error() == []


def test_notifications_after_terminal_are_ignored() -> None:
    projector = _projector()
    assert projector.begin()[0]["type"] == "dsh/v1/run.started"
    assert projector.finish({"stopReason": "end_turn"})[0]["status"] == "completed"
    assert projector.project_notification(*_chunk("late")) == []
    assert projector.project_notification(*_tool_call()) == []
    assert projector.begin() == []


def test_cross_session_notification_is_dropped() -> None:
    projector = _projector()
    method, params = _chunk("wrong", message_id="msg_other")
    params["sessionId"] = "someone-else"
    assert projector.project_notification(method, params) == []


def test_unknown_method_and_update_kind_are_ignored() -> None:
    projector = _projector()
    assert projector.project_notification("session/prompt", {"sessionId": SESSION_ID}) == []
    assert projector.project_notification(
        *_notification({"sessionUpdate": "usage_update", "used": 1, "size": 2})
    ) == []
    assert projector.project_notification(
        *_notification({"sessionUpdate": "config_option_update", "configOptions": []})
    ) == []


@pytest.mark.parametrize(
    "params",
    [
        None,
        {},
        {"sessionId": SESSION_ID, "update": None},
        {"sessionId": SESSION_ID, "update": {}},
        {"sessionId": SESSION_ID, "update": {"sessionUpdate": "agent_message_chunk"}},
        {
            "sessionId": SESSION_ID,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "messageId": "msg_bad",
                "content": {"type": "text", "text": 7},
            },
        },
    ],
)
def test_malformed_payloads_return_empty_without_raising(params: object) -> None:
    projector = _projector()
    assert projector.project_notification("session/update", params) == []


# Complete observed release shapes for @deepseek-ai/dsh-acp 0.2.1-rc.2.
# These mirror assistantUpdates/toolCallUpdate/toolResultUpdate verbatim; the
# command is a harmless local placeholder and no key or private payload appears.
PUBLISHED_ACP_0_2_1_RC2_UPDATES = """
[
  {
    "sessionId": "session-acp-contract",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "msg_published_1",
      "content": {"type": "text", "text": "PROBE_TEXT_OK"}
    }
  },
  {
    "sessionId": "session-acp-contract",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call_local_probe_1",
      "title": "bash",
      "kind": "other",
      "status": "in_progress",
      "rawInput": {"command": "printf probe"}
    }
  },
  {
    "sessionId": "session-acp-contract",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_local_probe_1",
      "status": "completed",
      "content": [
        {"type": "content", "content": {"type": "text", "text": "probe"}}
      ]
    }
  }
]
"""


def test_published_0_2_1_rc2_updates_have_message_id_and_project_cleanly() -> None:
    updates = json.loads(PUBLISHED_ACP_0_2_1_RC2_UPDATES)
    chunk = updates[0]["update"]
    assert chunk["messageId"] == "msg_published_1"
    projector = _projector()
    emitted = [
        event
        for session_id, update in [
            (item["sessionId"], item["update"]) for item in updates
        ]
        for event in projector.project_notification(
            "session/update", {"sessionId": session_id, "update": update}
        )
    ]
    assert [event["type"] for event in emitted] == [
        "dsh/v1/text.snapshot",
        "dsh/v1/activity",
        "dsh/v1/activity",
    ]
    assert emitted[0]["messageId"] == "msg_published_1"
    assert emitted[0]["text"] == "PROBE_TEXT_OK"
    assert emitted[1]["phase"] == "started"
    assert emitted[1]["toolName"] == "bash"
    assert emitted[1]["rawInput"] == {"command": "printf probe"}
    assert emitted[2]["phase"] == "finished"
    assert emitted[2]["status"] == "ok"
    assert emitted[2]["outputSummary"] == "probe"


def test_missing_message_id_uses_run_stable_synthetic_until_tool_boundary() -> None:
    projector = _projector()

    def chunk(text: str) -> tuple[str, dict]:
        return _notification(
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text},
            }
        )

    first = projector.project_notification(*chunk("one"))
    second = projector.project_notification(*chunk("one"))
    assert first[0]["type"] == "dsh/v1/text.snapshot"
    assert first[0]["messageId"] == f"{RUN_ID}:acp-agent#1"
    assert second[0]["type"] == "dsh/v1/text.delta"
    assert second[0]["delta"] == "one"
    assert second[0]["messageId"] == first[0]["messageId"]

    projector.project_notification(*_tool_call())
    after_tool = projector.project_notification(*chunk("two"))
    assert after_tool[0]["type"] == "dsh/v1/text.snapshot"
    assert after_tool[0]["messageId"] == f"{RUN_ID}:acp-agent#2"
    assert after_tool[0]["text"] == "two"


def test_tool_update_before_tool_call_does_not_regress_to_started() -> None:
    projector = _projector()
    finished = projector.project_notification(
        *_tool_update(status="completed", text="done")
    )
    assert finished[0]["phase"] == "finished"
    # The late call must not turn an already finished activity back to started.
    assert projector.project_notification(*_tool_call()) == []
    assert projector.project_notification(*_tool_update(status="completed")) == []


@pytest.mark.parametrize("bad_status", [["completed"], {"done": True}, 7, "teleported"])
def test_bad_tool_status_is_ignored_without_raising(bad_status: object) -> None:
    projector = _projector()
    projector.project_notification(*_tool_call())
    update = {
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call_acp_1",
        "status": bad_status,
    }
    assert projector.project_notification(*_notification(update)) == []
