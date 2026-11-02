"""Contract tests for the pure-Python DSH notification projector.

Samples reproduce the notification/event shapes from the reviewed probes in
``tests/test_dsh_capabilities.py`` and ``tests/test_dsh_policy.py`` combined with
the local master harness protocol declarations in
``packages/core/session/src/types.ts`` (``SessionEventMap``): ``session.event``
envelopes with ``type``/``data``; ``assistant/message`` carrying ``message.id``
plus ``message.content`` text blocks and ``stream`` ``text-chunks``;
``tool/call`` carrying ``callId``/``name``; ``tool/result`` carrying
``message.toolCallId``/``message.isError``; ``turn/start``/``turn/end`` with
``reason: {kind: ...}``; and ``session.status: idle``. No SDK, model, network, or
private payload is used. Probe evidence only attests assistant text; the
tool/``reason`` key names are protocol declarations from the local master
checkout (``0.2.2-alpha.2``), not yet verified against the pinned released
harness, and no fixture is fabricated to imply that verification.
"""

from __future__ import annotations

import json

import pytest

from jupyter_aiterminal.dsh_events import (
    DSH_EVENT_PREFIX,
    OUTPUT_SUMMARY_MAX_CHARACTERS,
    DshEventProjector,
)

SESSION_ID = "session-contract"
RUNTIME_ID = "runtime-gen-1"
RUN_ID = "run-contract-1"


def _projector(**overrides: str) -> DshEventProjector:
    values = {
        "session_id": SESSION_ID,
        "runtime_id": RUNTIME_ID,
        "run_id": RUN_ID,
        **overrides,
    }
    return DshEventProjector(**values)


def _notification(method: str, payload: dict) -> dict:
    return {"method": method, "payload": payload}


def _session_event(event_type: str, data: dict, **extra: object) -> dict:
    event = {"type": event_type, "data": data, **extra}
    return _notification("session.event", {"event": event})


def _text_message(text: str, *, message_id: str | None = "msg_stub", turn: int = 1, step: int = 1) -> dict:
    message: dict = {"role": "assistant", "content": [{"type": "text", "text": text}]}
    if message_id is not None:
        message["id"] = message_id
    return _session_event("assistant/message", {"turn": turn, "step": step, "message": message})


def test_run_started_has_explicit_scope_and_is_idempotent() -> None:
    projector = _projector()
    expected = [
        {
            "type": "dsh/v1/run.started",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
        }
    ]
    assert projector.project(_session_event("turn/start", {"turn": 1})) == expected
    assert projector.project(_session_event("turn/start", {"turn": 1})) == []


def test_assistant_message_joins_text_blocks_and_chunks_once() -> None:
    """The final content and the text-chunks stream describe the same message."""
    projector = _projector()
    event = _session_event(
        "assistant/message",
        {
            "turn": 1,
            "step": 1,
            "message": {
                "id": "msg_stub",
                "role": "assistant",
                "content": [{"type": "text", "text": "OAI-DELTA"}],
            },
            "stream": [{"type": "text-chunks", "texts": ["OAI-", "DELTA"]}],
        },
    )
    expected = [
        {
            "type": "dsh/v1/text.snapshot",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": "msg_stub",
            "text": "OAI-DELTA",
        }
    ]
    assert projector.project(event) == expected
    assert projector.project(event) == []


def test_assistant_message_concatenates_all_text_chunks_without_final_content() -> None:
    projector = _projector()
    events = projector.project(
        _session_event(
            "assistant/message",
            {
                "turn": 1,
                "step": 1,
                "stream": [
                    {"type": "text-chunks", "texts": ["OA", "I"]},
                    {"type": "reasoning-chunks", "texts": ["ignored"]},
                    {"type": "text-chunks", "texts": ["-", "DONE"]},
                ],
            },
        )
    )
    assert len(events) == 1
    assert events[0]["type"] == "dsh/v1/text.snapshot"
    assert events[0]["text"] == "OAI-DONE"


def test_assistant_message_without_id_uses_stable_turn_step_reference() -> None:
    """No message id: the turn/step boundary keeps one growing message a delta."""
    projector = _projector()
    reference = f"{RUN_ID}:turn1/step1:assistant"

    first = projector.project(_text_message("OA", message_id=None))
    assert first == [
        {
            "type": "dsh/v1/text.snapshot",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": reference,
            "text": "OA",
        }
    ]
    # Same boundary, longer text: a suffix delta on the same stable reference.
    assert projector.project(_text_message("OAI", message_id=None)) == [
        {
            "type": "dsh/v1/text.delta",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": reference,
            "delta": "I",
        }
    ]
    # Duplicate of the same message yields nothing.
    assert projector.project(_text_message("OAI", message_id=None)) == []
    # Non-prefix replacement of the same boundary re-snapshots.
    replaced = projector.project(_text_message("rewritten", message_id=None))
    assert replaced[0]["type"] == "dsh/v1/text.snapshot"
    assert replaced[0]["messageId"] == reference
    assert replaced[0]["text"] == "rewritten"


def test_assistant_messages_with_distinct_boundaries_do_not_merge() -> None:
    projector = _projector()
    assert projector.project(_text_message("first", message_id=None, turn=1, step=1))[0]["text"] == (
        "first"
    )
    second = projector.project(_text_message("second", message_id=None, turn=1, step=2))
    assert second[0]["type"] == "dsh/v1/text.snapshot"
    assert second[0]["text"] == "second"
    assert second[0]["messageId"] == f"{RUN_ID}:turn1/step2:assistant"


def test_assistant_message_without_any_boundary_is_not_concatenated() -> None:
    """Unknown message boundary must never stitch two assistant messages together."""
    projector = _projector()
    first = projector.project(_session_event("assistant/message", {"stream": [{"type": "text-chunks", "texts": ["a"]}]}))
    second = projector.project(_session_event("assistant/message", {"stream": [{"type": "text-chunks", "texts": ["ab"]}]}))
    assert first[0]["type"] == "dsh/v1/text.snapshot"
    assert second[0]["type"] == "dsh/v1/text.snapshot"
    assert first[0]["messageId"] != second[0]["messageId"]
    assert second[0]["text"] == "ab"


def test_longer_repeat_emits_suffix_delta_and_replacement_resnapshots() -> None:
    projector = _projector()
    assert projector.project(_text_message("OA"))[0]["text"] == "OA"
    assert projector.project(_text_message("OAI")) == [
        {
            "type": "dsh/v1/text.delta",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": "msg_stub",
            "delta": "I",
        }
    ]
    replaced = projector.project(_text_message("rewritten"))
    assert replaced == [
        {
            "type": "dsh/v1/text.snapshot",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "messageId": "msg_stub",
            "text": "rewritten",
        }
    ]


def test_tool_call_and_result_project_activity_fields() -> None:
    projector = _projector()
    started = projector.project(
        _session_event(
            "tool/call",
            {"turn": 1, "step": 1, "callId": "call-1", "name": "bash", "arguments": '{"command":"echo hi"}'},
        )
    )
    assert started == [
        {
            "type": "dsh/v1/activity",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "activityId": "call-1",
            "phase": "started",
            "toolCallId": "call-1",
            "toolName": "bash",
        }
    ]
    assert "echo hi" not in json.dumps(started)
    assert (
        projector.project(
            _session_event(
                "tool/call",
                {"turn": 1, "step": 1, "callId": "call-1", "name": "bash", "arguments": '{"command":"echo hi"}'},
            )
        )
        == []
    )

    finished = projector.project(
        _session_event(
            "tool/result",
            {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "call-1-result",
                    "role": "tool",
                    "toolCallId": "call-1",
                    "content": [{"type": "text", "text": "gated"}],
                    "isError": False,
                },
                "durationMs": 12,
            },
        )
    )
    assert finished == [
        {
            "type": "dsh/v1/activity",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "activityId": "call-1",
            "phase": "finished",
            "toolCallId": "call-1",
            "toolName": "bash",
            "status": "ok",
            "outputSummary": "gated",
            "durationMs": 12,
        }
    ]
    # Duplicate results and unknown call ids are ignored.
    assert (
        projector.project(
            _session_event(
                "tool/result",
                {"message": {"toolCallId": "call-1", "isError": False}},
            )
        )
        == []
    )
    assert (
        projector.project(
            _session_event(
                "tool/result",
                {"message": {"toolCallId": "call-unknown", "isError": False}},
            )
        )
        == []
    )


def test_tool_result_error_summary_is_bounded_and_hides_payload() -> None:
    projector = _projector()
    projector.project(_session_event("tool/call", {"callId": "call-2", "name": "write"}))
    long_text = "x" * (OUTPUT_SUMMARY_MAX_CHARACTERS + 50)
    events = projector.project(
        _session_event(
            "tool/result",
            {
                "message": {
                    "toolCallId": "call-2",
                    "isError": True,
                    "content": [{"type": "text", "text": long_text}],
                },
                "error": {"name": "ToolError", "code": "E"},
                "privatePayload": {"secret": "not-forwarded"},
                "durationMs": -1,
            },
        )
    )
    assert len(events) == 1
    event = events[0]
    assert event["status"] == "error"
    assert event["outputSummary"] == (
        "x" * OUTPUT_SUMMARY_MAX_CHARACTERS + "\u2026"
    )
    assert "durationMs" not in event
    assert "privatePayload" not in event
    assert "not-forwarded" not in json.dumps(events)


def test_tool_result_with_unhashable_status_does_not_raise() -> None:
    """A JSON array/object ``status`` is malformed; it must not raise unhashable errors."""
    projector = _projector()
    projector.project(_session_event("tool/call", {"callId": "call-9", "name": "bash"}))
    events = projector.project(
        _session_event(
            "tool/result",
            {
                "message": {
                    "toolCallId": "call-9",
                    "isError": False,
                    "content": [{"type": "text", "text": "ok"}],
                },
                "status": ["ok"],
            },
        )
    )
    assert len(events) == 1
    # Falls back to the attested message.isError flag rather than the bad status.
    assert events[0]["status"] == "ok"


def test_tool_call_without_trusted_structure_is_ignored() -> None:
    projector = _projector()
    assert projector.project(_session_event("tool/call", {"arguments": "{}"})) == []
    assert projector.project(_session_event("tool/call", {"callId": "call-3"})) == []


@pytest.mark.parametrize(
    ("kind", "status"),
    [
        ("completed", "completed"),
        ("aborted", "cancelled"),
        ("error", "failed"),
        # Terminal non-success reasons must still close the run as ``failed``.
        ("blocked", "failed"),
        ("max-tokens", "failed"),
        # ``interrupted`` is a crash-recovery close, not a user cancel.
        ("interrupted", "failed"),
    ],
)
def test_turn_end_maps_real_reason_kind_to_run_status(kind: str, status: str) -> None:
    projector = _projector()
    expected = [
        {
            "type": "dsh/v1/run.finished",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "status": status,
        }
    ]
    event = _session_event("turn/end", {"turn": 1, "reason": {"kind": kind}})
    assert projector.project(event) == expected
    assert projector.project(event) == []
    # A trailing idle status must not fabricate a second terminal event.
    assert projector.project(_notification("session.status", {"status": "idle"})) == []


def test_turn_end_with_unknown_kind_fails_defensively_and_forked_is_ignored() -> None:
    """Unknown kinds are non-success terminals; ``forked`` seeds and malformed stay silent."""
    projector = _projector()
    # A structurally valid but unknown/future kind still closes the run as failed.
    unknown = projector.project(_session_event("turn/end", {"reason": {"kind": "mystery"}}))
    assert unknown == [
        {
            "type": "dsh/v1/run.finished",
            "sessionId": SESSION_ID,
            "runtimeId": RUNTIME_ID,
            "runId": RUN_ID,
            "status": "failed",
        }
    ]
    # Terminal idempotency holds for the defensive default too.
    assert projector.project(_session_event("turn/end", {"reason": {"kind": "mystery"}})) == []
    assert projector.project(_notification("session.status", {"status": "idle"})) == []

    # ``forked`` is a fork-seed marker, not a live terminal: never a false completed.
    fork = _projector()
    assert fork.project(_session_event("turn/end", {"reason": {"kind": "forked"}})) == []
    # Malformed/missing reason still yields nothing and never raises.
    assert fork.project(_session_event("turn/end", {"reason": {}})) == []
    assert fork.project(_session_event("turn/end", {})) == []
    # A later real reason can still finish the run.
    assert fork.project(
        _session_event("turn/end", {"reason": {"kind": "completed"}})
    )[0]["status"] == "completed"


def test_unknown_session_event_types_and_methods_are_ignored() -> None:
    projector = _projector()
    for event_type in (
        "step/start",
        "step/end",
        "user/message",
        "agent/inbox/spliced",
        "artifact/created",
        "question/requested",
        "approval/requested",
        "job/started",
        "subagent/started",
    ):
        assert projector.project(_session_event(event_type, {"anything": 1})) == []
    assert projector.project(_notification("session.status", {"status": "working"})) == []
    assert projector.project(_notification("initialize", {"capabilities": {}})) == []


@pytest.mark.parametrize(
    "notification",
    [
        None,
        "session.event",
        42,
        {},
        {"method": "session.event"},
        {"method": "session.event", "payload": None},
        {"method": "session.event", "payload": {"event": None}},
        {"method": "session.event", "payload": {"event": {"type": "", "data": {}}}},
        {"method": "session.event", "payload": {"event": {"type": "turn/start"}}},
        {"method": "session.event", "payload": {"event": {"type": "turn/start", "data": []}}},
        {"method": None, "payload": {"event": {"type": "turn/start", "data": {}}}},
    ],
)
def test_malformed_notifications_return_empty_without_raising(notification: object) -> None:
    projector = _projector()
    assert projector.project(notification) == []


def test_cross_session_and_cross_run_notifications_are_filtered() -> None:
    projector = _projector()
    foreign_session = _notification(
        "session.event",
        {"sessionId": "other-session", "event": {"type": "turn/start", "data": {}}},
    )
    assert projector.project(foreign_session) == []
    foreign_run = _session_event("turn/start", {"runId": "other-run"})
    assert projector.project(foreign_run) == []
    matching_scope = _notification(
        "session.event",
        {
            "sessionId": SESSION_ID,
            "event": {"type": "turn/start", "data": {"runId": RUN_ID}},
        },
    )
    assert projector.project(matching_scope)[0]["runId"] == RUN_ID


def test_runtime_reset_reprojects_transient_state_under_new_generation() -> None:
    projector = _projector()
    message = _text_message("OAI")
    assert projector.project(message)[0]["runtimeId"] == RUNTIME_ID
    assert projector.project(message) == []

    projector.reset_runtime("runtime-gen-2")
    replay = projector.project(message)
    assert [event["runtimeId"] for event in replay] == ["runtime-gen-2"]
    assert replay[0]["type"] == "dsh/v1/text.snapshot"
    assert projector.project(_session_event("turn/end", {"reason": {"kind": "completed"}}))[0][
        "runtimeId"
    ] == "runtime-gen-2"
    assert projector.project(_session_event("turn/end", {"reason": {"kind": "completed"}})) == []


def test_events_after_run_finished_are_ignored() -> None:
    projector = _projector()
    projector.project(_session_event("turn/start", {"turn": 1}))
    projector.project(_session_event("turn/end", {"reason": {"kind": "completed"}}))
    assert projector.project(_text_message("late")) == []
    assert projector.project(_session_event("run.started", {})) == []


def test_projector_rejects_invalid_identity_inputs() -> None:
    with pytest.raises(ValueError):
        DshEventProjector(session_id="", runtime_id=RUNTIME_ID, run_id=RUN_ID)
    with pytest.raises(ValueError):
        _projector().reset_runtime("")


def test_emitted_event_types_stay_inside_the_dsh_v1_namespace() -> None:
    projector = _projector()
    emitted = []
    emitted += projector.project(_session_event("turn/start", {"turn": 1}))
    emitted += projector.project(_text_message("hi"))
    emitted += projector.project(_session_event("turn/end", {"reason": {"kind": "completed"}}))
    assert emitted
    for event in emitted:
        assert event["type"].startswith(DSH_EVENT_PREFIX)
        assert event["sessionId"] == SESSION_ID
        assert event["runtimeId"] == RUNTIME_ID
        assert event["runId"] == RUN_ID
