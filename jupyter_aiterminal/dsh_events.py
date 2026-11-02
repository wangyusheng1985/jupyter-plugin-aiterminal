"""Project DeepSeek Harness session notifications onto ``dsh/v1`` product events.

The projector is pure Python and stateful; it never imports the harness SDK and
never inspects or forwards private runtime fields. Input is a decoded notification envelope (``{"method": ..., "payload": ...}`` or
an object with ``method``/``payload`` attributes) matching the reviewed probes in
``tests/test_dsh_capabilities.py`` and ``tests/test_dsh_policy.py``:

* ``session.event`` -> ``payload.event = {"type": str, "data": dict}``
* ``session.status`` -> ``payload.status = "idle"``

Field names inside ``data`` are taken from the harness protocol declarations in
``packages/core/session/src/types.ts`` (``SessionEventMap``) of the local master
checkout (``0.2.2-alpha.2``), not guessed: ``tool/call`` carries
``callId``/``name``; ``tool/result`` carries ``message.toolCallId``/``message.isError``;
``turn/end`` carries ``reason: {kind: str}``; ``assistant/message`` carries
``message.id`` (plus ``turn``/``step``). Probe evidence only attests assistant
``content``/``stream`` text; the tool/``reason`` key names are protocol
*declarations* from that local checkout and are not yet verified against the
pinned released harness. No fabricated fixture stands in for that missing proof;
adding release-version contract tests for those fields is still pending. Fields
absent from a payload are simply ignored, so the projection degrades to nothing
rather than inventing values.

Only event types whose shape is declared by those protocol definitions are projected:
``turn/start`` -> ``dsh/v1/run.started``; ``assistant/message`` ->
``dsh/v1/text.snapshot``/``dsh/v1/text.delta``; ``tool/call``/``tool/result`` ->
``dsh/v1/activity``; ``turn/end`` -> ``dsh/v1/run.finished``. Everything else
(``step/start``, ``user/message``, ``agent/inbox/spliced``, ``step/end``,
artifact/question/approval/job/subagent types, unknown methods) is ignored and
never raises.

Scope and identity are explicit. The host owns ``sessionId``, ``runtimeId`` and
``runId``; the projector stamps them onto every emitted event and drops any
notification that names a different session or run. ``runtimeId`` is a
connection generation, not a session identity: ``reset_runtime`` clears
transient projection state on reconnect without deleting the durable session.
A new run is projected by a fresh projector for that ``runId``.

Text is corrected for the real duplicate shape: an ``assistant/message`` may
carry both ``data.message.content`` text blocks and ``data.stream``
``text-chunks`` records; both describe one message, so they are joined once (all
``text-chunks`` records concatenated, never double counted with content) and a
repeat of the same message yields nothing. Message identity is a run-stable
reference: ``message.id`` when present (the real protocol always sets it),
otherwise a reference derived from the attested ``turn``/``step`` boundary. A
message whose boundary is unknown gets a fresh isolated reference so distinct
assistant messages are never concatenated. A longer repeat of a known message
emits a ``text.delta`` suffix; a non-prefix change re-emits ``text.snapshot``.
Terminal events are idempotent: one ``turn/end`` produces one ``run.finished``
and later duplicates or a trailing ``session.status: idle`` produce nothing.

Tool activity is only mapped when trusted structure is present: a ``tool/call``
needs both a non-empty ``callId`` and ``name``, and a ``tool/result`` needs the
``message.toolCallId`` of an already-started call. ``outputSummary`` is bounded
short text from text blocks, never the raw tool payload; a top-level
``durationMs`` is used only when it is a finite non-negative number. Turn
outcome uses the runtime's own ``reason.kind``; ``completed``/``aborted``/
``blocked``/``max-tokens``/``interrupted`` are terminal ``turn/end`` reasons and
all map to ``failed`` so a run never lingers ``running``: ``blocked`` is a
pre-step rejection, ``max-tokens`` an output-limit stop, and ``interrupted`` is a
post-hoc close added while recovering a crash (never a live user cancel, so it is
*not* mapped to ``cancelled``). ``completed`` stays the only success. ``forked``
is a fork-seed marker that only appears in seed logs, never a live-run terminal;
the host must not feed it as a live event, so it is ignored on purpose to avoid a
false ``completed``. A structurally valid but unknown/future ``reason.kind`` is
defensively mapped to ``failed`` (documented default, never success); a
malformed/missing reason yields nothing and never raises.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

DSH_EVENT_NAMESPACE = "dsh"
DSH_EVENT_VERSION = 1
DSH_EVENT_PREFIX = f"{DSH_EVENT_NAMESPACE}/v{DSH_EVENT_VERSION}/"

OUTPUT_SUMMARY_MAX_CHARACTERS = 400
_TRUNCATION_SUFFIX = "\u2026"

_RUN_STATUS_BY_REASON = {
    # Attested ``TurnEndReason.kind`` values (packages/core/session/src/types.ts).
    # ``blocked``/``max-tokens``/``interrupted`` are terminal but never success.
    "completed": "completed",
    "aborted": "cancelled",
    "error": "failed",
    "blocked": "failed",
    "max-tokens": "failed",
    "interrupted": "failed",
    # Legacy non-authoritative string tokens kept as a plain-string fallback.
    "end_turn": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}
# ``forked`` only marks a fork seed, never a live run terminal; ignore it so a
# seed replay cannot be mistaken for a ``completed`` live run.
_IGNORED_TURN_END_REASONS = {"forked"}
_ACTIVITY_STATUSES = {"ok", "error"}


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _coerce_notification(notification: Any) -> tuple[str | None, Any]:
    if isinstance(notification, Mapping):
        method = notification.get("method")
        payload = notification.get("payload")
    else:
        method = getattr(notification, "method", None)
        payload = getattr(notification, "payload", None)
    return (method if isinstance(method, str) else None), payload


def _text_block_content(container: Any) -> str | None:
    content = container.get("content") if isinstance(container, Mapping) else None
    if not isinstance(content, list):
        return None
    parts = [
        block["text"]
        for block in content
        if isinstance(block, Mapping)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    text = "".join(parts)
    return text or None


def _assistant_message_text(data: Mapping[str, Any]) -> str | None:
    """Join attested assistant text once, preferring final content over chunks."""
    content_text = _text_block_content(data.get("message"))
    if content_text is not None:
        return content_text
    stream = data.get("stream")
    if isinstance(stream, list):
        parts: list[str] = []
        for chunk in stream:
            if not isinstance(chunk, Mapping) or chunk.get("type") != "text-chunks":
                continue
            texts = chunk.get("texts")
            if isinstance(texts, list) and all(isinstance(item, str) for item in texts):
                parts.extend(texts)
        text = "".join(parts)
        if text:
            return text
    return None


def _boundary_index(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _tool_call_id(data: Mapping[str, Any]) -> str | None:
    """Resolve the call id from the attested locations, top level or result message."""
    for key in ("toolCallId", "callId"):
        value = data.get(key)
        if _non_empty_string(value):
            return value
    message = data.get("message")
    if isinstance(message, Mapping):
        value = message.get("toolCallId")
        if _non_empty_string(value):
            return value
    return None


def _tool_name(data: Mapping[str, Any]) -> str | None:
    for key in ("toolName", "name"):
        value = data.get(key)
        if _non_empty_string(value):
            return value
    return None


def _tool_error_flag(data: Mapping[str, Any]) -> bool | None:
    """Read ``message.isError`` (attested) with top-level ``error`` as a fallback."""
    message = data.get("message")
    if isinstance(message, Mapping):
        value = message.get("isError")
        if isinstance(value, bool):
            return value
    value = data.get("isError")
    if isinstance(value, bool):
        return value
    if data.get("error") is not None:
        return True
    return None


def _turn_end_reason_kind(data: Mapping[str, Any]) -> str | None:
    """Read ``reason.kind`` (attested) or fall back to a plain-string reason."""
    reason = data.get("reason")
    if isinstance(reason, Mapping):
        kind = reason.get("kind")
        return kind if _non_empty_string(kind) else None
    if _non_empty_string(reason):
        return reason
    return None


def _bounded_output_summary(text: str) -> str:
    if len(text) <= OUTPUT_SUMMARY_MAX_CHARACTERS:
        return text
    return text[:OUTPUT_SUMMARY_MAX_CHARACTERS] + _TRUNCATION_SUFFIX


def _duration_ms(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return value


class DshEventProjector:
    """Stateful, side-effect-free projector for one session run generation."""

    def __init__(self, *, session_id: str, runtime_id: str, run_id: str) -> None:
        for label, value in (
            ("session_id", session_id),
            ("runtime_id", runtime_id),
            ("run_id", run_id),
        ):
            if not _non_empty_string(value):
                raise ValueError(f"{label} must be a non-empty string")
        self._session_id = session_id
        self._runtime_id = runtime_id
        self._run_id = run_id
        self._message_text: dict[str, str] = {}
        self._activities: dict[str, dict[str, Any]] = {}
        self._finished_activities: set[str] = set()
        self._unbounded_message_ordinal = 0
        self._run_started = False
        self._run_finished = False

    def project(self, notification: Any) -> list[dict[str, Any]]:
        """Project one notification; malformed or unknown input yields ``[]``."""
        method, payload = _coerce_notification(notification)
        if method is None or not isinstance(payload, Mapping):
            return []
        if method == "session.event":
            return self._project_session_event(payload)
        return []

    def reset_runtime(self, runtime_id: str) -> None:
        """Start a new runtime generation after reconnect, dropping transient state.

        The durable ``sessionId``/``runId`` are kept; replay text, tool activity,
        started/finished flags are cleared so the new generation can re-project
        them under the new ``runtimeId``. No event is emitted: connection
        lifecycle belongs to the host, not to a session notification.
        """
        if not _non_empty_string(runtime_id):
            raise ValueError("runtime_id must be a non-empty string")
        self._runtime_id = runtime_id
        self._message_text.clear()
        self._activities.clear()
        self._finished_activities.clear()
        self._unbounded_message_ordinal = 0
        self._run_started = False
        self._run_finished = False

    def _in_scope(self, source: Mapping[str, Any]) -> bool:
        session_id = source.get("sessionId")
        if session_id is not None and session_id != self._session_id:
            return False
        run_id = source.get("runId")
        if run_id is not None and run_id != self._run_id:
            return False
        return True

    def _scope(self) -> dict[str, str]:
        return {
            "sessionId": self._session_id,
            "runtimeId": self._runtime_id,
            "runId": self._run_id,
        }

    def _project_session_event(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        if not self._in_scope(payload):
            return []
        event = payload.get("event")
        if not isinstance(event, Mapping) or not self._in_scope(event):
            return []
        kind = event.get("type")
        data = event.get("data")
        if not _non_empty_string(kind) or not isinstance(data, Mapping):
            return []
        if not self._in_scope(data) or self._run_finished:
            return []
        if kind == "turn/start":
            return self._project_run_started()
        if kind == "assistant/message":
            return self._project_assistant_message(data)
        if kind == "tool/call":
            return self._project_tool_call(data)
        if kind == "tool/result":
            return self._project_tool_result(data)
        if kind == "turn/end":
            return self._project_turn_end(data)
        return []

    def _project_run_started(self) -> list[dict[str, Any]]:
        if self._run_started:
            return []
        self._run_started = True
        return [{"type": "dsh/v1/run.started", **self._scope()}]

    def _assistant_message_ref(self, data: Mapping[str, Any]) -> str:
        """Return a run-stable message reference with an explicit message boundary.

        ``message.id`` is authoritative. Without it, the attested ``turn``/``step``
        boundary yields a stable per-message reference so growing streamed text is
        a delta rather than a fresh message. When no boundary is known, a fresh
        isolated reference is allocated so distinct assistant messages are never
        concatenated into one bubble.
        """
        message = data.get("message")
        message_id = message.get("id") if isinstance(message, Mapping) else None
        if _non_empty_string(message_id):
            return message_id
        turn = _boundary_index(data.get("turn"))
        step = _boundary_index(data.get("step"))
        if turn is not None and step is not None:
            return f"{self._run_id}:turn{turn}/step{step}:assistant"
        if turn is not None:
            return f"{self._run_id}:turn{turn}:assistant"
        self._unbounded_message_ordinal += 1
        return f"{self._run_id}:assistant#{self._unbounded_message_ordinal}"

    def _project_assistant_message(
        self, data: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        text = _assistant_message_text(data)
        if text is None:
            return []
        message_id = self._assistant_message_ref(data)
        previous = self._message_text.get(message_id)
        if previous is None:
            self._message_text[message_id] = text
            return [
                {
                    "type": "dsh/v1/text.snapshot",
                    **self._scope(),
                    "messageId": message_id,
                    "text": text,
                }
            ]
        if text == previous:
            return []
        if text.startswith(previous):
            self._message_text[message_id] = text
            return [
                {
                    "type": "dsh/v1/text.delta",
                    **self._scope(),
                    "messageId": message_id,
                    "delta": text[len(previous) :],
                }
            ]
        self._message_text[message_id] = text
        return [
            {
                "type": "dsh/v1/text.snapshot",
                **self._scope(),
                "messageId": message_id,
                "text": text,
            }
        ]

    def _project_tool_call(self, data: Mapping[str, Any]) -> list[dict[str, Any]]:
        tool_call_id = _tool_call_id(data)
        tool_name = _tool_name(data)
        if tool_call_id is None or tool_name is None:
            return []
        if tool_call_id in self._activities:
            return []
        activity = {
            "type": "dsh/v1/activity",
            **self._scope(),
            "activityId": tool_call_id,
            "phase": "started",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
        }
        self._activities[tool_call_id] = activity
        return [dict(activity)]

    def _project_tool_result(self, data: Mapping[str, Any]) -> list[dict[str, Any]]:
        tool_call_id = _tool_call_id(data)
        if tool_call_id is None:
            return []
        started = self._activities.get(tool_call_id)
        if started is None or tool_call_id in self._finished_activities:
            return []
        status: str | None = None
        explicit_status = data.get("status")
        if isinstance(explicit_status, str) and explicit_status in _ACTIVITY_STATUSES:
            status = explicit_status
        else:
            is_error = _tool_error_flag(data)
            if is_error is not None:
                status = "error" if is_error else "ok"
        finished: dict[str, Any] = {
            "type": "dsh/v1/activity",
            **self._scope(),
            "activityId": tool_call_id,
            "phase": "finished",
            "toolCallId": tool_call_id,
            "toolName": started["toolName"],
        }
        if status is not None:
            finished["status"] = status
        text = _text_block_content(data.get("message"))
        if text:
            finished["outputSummary"] = _bounded_output_summary(text)
        duration_ms = _duration_ms(data.get("durationMs"))
        if duration_ms is not None:
            finished["durationMs"] = duration_ms
        self._finished_activities.add(tool_call_id)
        return [finished]

    def _project_turn_end(self, data: Mapping[str, Any]) -> list[dict[str, Any]]:
        kind = _turn_end_reason_kind(data)
        if kind is None:
            return []
        if kind in _IGNORED_TURN_END_REASONS:
            return []
        # A valid-but-unknown future kind still closes the run: fail defensively
        # rather than leave it running forever. ``failed`` is never success.
        status = _RUN_STATUS_BY_REASON.get(kind, "failed")
        self._run_finished = True
        return [{"type": "dsh/v1/run.finished", **self._scope(), "status": status}]
