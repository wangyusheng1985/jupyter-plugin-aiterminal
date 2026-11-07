"""Project ACP ``session/update`` notifications onto ``dsh/v1`` product events.

The DSH-backed ACP bridge emits standard ACP updates; this module is the pure,
stateful translation layer between that wire shape and the product event
contract declared in ``src/agent/protocol.ts`` (``DshProductEvent``). It never
imports the harness SDK, starts a runtime, or touches the network.

Wire shapes are taken from real evidence, not guessed:

* The isolated ACP gate probe produced with
  ``deepseek_harness_sdk``/``deepseek_harness_runtime`` ``0.2.1rc2``
  (``/private/var/folders/91/8yyb5wfn35vcbxnxwpms2vxr0000gn/T/dsh-acp-probe.5x0c0g``)
  captured ``agent_message_chunk``, ``usage_update``, ``tool_call`` and
  ``tool_call_update`` notifications under ``params.sessionId`` /
  ``params.update``.
* The published package that same probe installed, ``@deepseek-ai/dsh-acp``
  ``0.2.1-rc.2`` (``probe-home/.cache/pkg/.../@deepseek-ai/dsh-acp/lib/
  index.js``), is the release evidence for the emitted fields:
  ``assistantUpdates`` sets ``messageId`` on every ``agent_message_chunk`` and
  ``content: {type: 'text', text}``; ``toolCallUpdate`` sets
  ``toolCallId``/``title``/``kind``/``status``/``rawInput``;
  ``toolResultUpdate`` sets ``toolCallId``/``status`` plus
  ``content: [{type: 'content', content: {type: 'text', text}}]``.
  ``session/update`` envelopes carry ``{sessionId, update}`` and a prompt
  response carries ``{stopReason}``. The local harness master checkout agrees
  but is corroboration, not release evidence.
* ``messageId`` is therefore present in the measured release, but a missing
  id must not drop assistant text. Without it the projector uses a ``run_id``
  scoped synthetic message reference that survives until the next tool-call
  boundary, so chunks still snapshot once and then delta.

Projection rules:

* ``agent_message_chunk`` text is committed incremental content, so each
  chunk is projected exactly once in arrival order: the first chunk of a
  ``messageId`` is a ``text.snapshot`` and later chunks are ``text.delta``.
  Identical text is never treated as a retransmission (there is no sequence
  number), so legitimate repeated words survive; duplicates can only be
  disambiguated by the host, not deduplicated here.
* ``tool_call``/``tool_call_update`` become ``activity`` events keyed by the
  tool call id. Tool naming is fixed by the first trusted ``tool_call``;
  later updates cannot silently rename an activity. ``outputSummary`` is
  bounded text from the standard content blocks and never the raw input.
* Unknown update kinds and unknown methods are ignored safely. ACP does not
  expose artifact presentation/change events through this surface, so no
  artifact event is fabricated. Questions and permissions are host-owned; this
  module never synthesizes interaction events or answers approvals.
* Run identity is explicit: ``session_id``, ``runtime_id`` and ``run_id`` are
  supplied by the host and stamped onto every event. A notification naming a
  different session is dropped; ``run_id`` is never derived from ``session_id``.

Terminal handling is idempotent. ``finish`` maps the ACP prompt response's
``stopReason`` onto ``dsh/v1/run.finished`` as a stable terminal ``reason``
(``end_turn`` -> ``completed``, ``cancelled`` -> ``cancelled``, ``max_tokens``
-> ``budget-exhausted``, any other or missing value -> ``failed``) while
keeping the existing ``status`` for backward compatibility. The raw
``stopReason`` is never echoed onto the event: an unknown or arbitrary value
collapses to ``failed`` without entering the event or docs. ``finish_error``
closes the run as ``failed`` when an exception occurred outside a prompt
response. Only the first terminal event is emitted;
late notifications are ignored. No automatic retry or continuation is ever
triggered.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

OUTPUT_SUMMARY_MAX_CHARACTERS = 400
_TRUNCATION_SUFFIX = "\u2026"

_SESSION_UPDATE_METHOD = "session/update"
_FINISHED_TOOL_STATUSES = {"completed": "ok", "failed": "error"}
_NON_TERMINAL_TOOL_STATUSES = {"pending", "in_progress"}
# Legacy terminal ``status`` values, kept for clients that only read status.
_PROMPT_SUCCESS_STATUSES = {"end_turn": "completed", "cancelled": "cancelled"}
# Stable terminal ``reason`` values carried alongside status. ``max_tokens`` is
# a budget-limited stop, not a generic failure.
_TERMINAL_REASONS = {
    "end_turn": "completed",
    "cancelled": "cancelled",
    "max_tokens": "budget-exhausted",
}


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _bounded_output_summary(text: str) -> str:
    if len(text) <= OUTPUT_SUMMARY_MAX_CHARACTERS:
        return text
    return text[:OUTPUT_SUMMARY_MAX_CHARACTERS] + _TRUNCATION_SUFFIX


def _content_text(value: Any) -> str | None:
    """Join standard ACP text content blocks, never the raw input payload."""
    if not isinstance(value, list):
        return None
    parts: list[str] = []
    for entry in value:
        if not isinstance(entry, Mapping):
            continue
        block = entry.get("content")
        if isinstance(block, Mapping) and block.get("type") == "text":
            text = block.get("text")
        elif entry.get("type") == "text":
            text = entry.get("text")
        else:
            continue
        if isinstance(text, str):
            parts.append(text)
    joined = "".join(parts)
    return joined or None


class DshAcpEventProjector:
    """Stateful, side-effect-free projector for one ACP session run."""

    def __init__(self, session_id: str, runtime_id: str, run_id: str) -> None:
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
        self._message_ids: set[str] = set()
        self._synthetic_message_id: str | None = None
        self._synthetic_message_ordinal = 0
        self._tool_names: dict[str, str] = {}
        self._finished_activities: set[str] = set()
        self._run_started = False
        self._run_finished = False

    def _scope(self) -> dict[str, str]:
        return {
            "sessionId": self._session_id,
            "runtimeId": self._runtime_id,
            "runId": self._run_id,
        }

    def begin(self) -> list[dict[str, Any]]:
        """Emit the one ``run.started`` event for this host-owned run."""
        if self._run_started or self._run_finished:
            return []
        self._run_started = True
        return [{"type": "dsh/v1/run.started", **self._scope()}]

    def finish(self, prompt_result: Any) -> list[dict[str, Any]]:
        """Emit one terminal event from an ACP ``session/prompt`` response."""
        stop_reason = (
            prompt_result.get("stopReason")
            if isinstance(prompt_result, Mapping)
            else None
        )
        if isinstance(stop_reason, str):
            status = _PROMPT_SUCCESS_STATUSES.get(stop_reason, "failed")
            reason = _TERMINAL_REASONS.get(stop_reason, "failed")
        else:
            status = "failed"
            reason = "failed"
        return self._finish(status, reason)

    def finish_error(self, error: Any = None) -> list[dict[str, Any]]:
        """Emit a ``failed`` terminal when the host caught an out-of-band error."""
        # ``error`` is intentionally ignored: exception text can contain raw
        # payloads or credentials and must never reach the product event.
        return self._finish("failed", "failed")

    def _finish(self, status: str, reason: str) -> list[dict[str, Any]]:
        if self._run_finished:
            return []
        self._run_finished = True
        return [
            {
                "type": "dsh/v1/run.finished",
                **self._scope(),
                "status": status,
                "reason": reason,
            }
        ]

    def project_notification(
        self, method: Any, params: Any
    ) -> list[dict[str, Any]]:
        """Project one ACP notification; malformed or unknown input yields ``[]``."""
        if method != _SESSION_UPDATE_METHOD or self._run_finished:
            return []
        if not isinstance(params, Mapping):
            return []
        if params.get("sessionId") != self._session_id:
            return []
        update = params.get("update")
        if not isinstance(update, Mapping):
            return []
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            return self._project_message_chunk(update)
        if kind == "tool_call":
            return self._project_tool_call(update)
        if kind == "tool_call_update":
            return self._project_tool_call_update(update)
        return []

    def _message_ref(self, update: Mapping[str, Any]) -> str:
        """Resolve the message reference, synthesizing a stable one if absent.

        The measured release sets ``messageId``; the fallback keeps text when a
        future or partial runtime omits it. The synthetic reference is stable
        for the run until a tool boundary, so chunks snapshot once and then
        delta instead of being dropped or starting a new message each time.
        """
        message_id = update.get("messageId")
        if _non_empty_string(message_id):
            return message_id
        if self._synthetic_message_id is None:
            self._synthetic_message_ordinal += 1
            self._synthetic_message_id = (
                f"{self._run_id}:acp-agent#{self._synthetic_message_ordinal}"
            )
        return self._synthetic_message_id

    def _project_message_chunk(
        self, update: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        content = update.get("content")
        if not isinstance(content, Mapping) or content.get("type") != "text":
            return []
        text = content.get("text")
        if not isinstance(text, str) or text == "":
            return []
        message_id = self._message_ref(update)
        common = {**self._scope(), "messageId": message_id}
        if message_id not in self._message_ids:
            self._message_ids.add(message_id)
            return [{"type": "dsh/v1/text.snapshot", **common, "text": text}]
        # ACP chunks are committed increments with no sequence number: forward
        # each one so repeated words are never mistaken for a duplicate.
        return [{"type": "dsh/v1/text.delta", **common, "delta": text}]

    def _project_tool_call(
        self, update: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        tool_call_id = update.get("toolCallId")
        if not _non_empty_string(tool_call_id) or tool_call_id in self._tool_names:
            return []
        tool_name = update.get("title")
        if not _non_empty_string(tool_name):
            return []
        self._tool_names[tool_call_id] = tool_name
        # A tool call starts a new assistant message; a late call after its
        # terminal update must enrich the name, not regress the activity.
        self._synthetic_message_id = None
        if tool_call_id in self._finished_activities:
            return []
        return [
            {
                "type": "dsh/v1/activity",
                **self._scope(),
                "activityId": tool_call_id,
                "phase": "started",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
            }
        ]

    def _project_tool_call_update(
        self, update: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        tool_call_id = update.get("toolCallId")
        if not _non_empty_string(tool_call_id):
            return []
        if tool_call_id in self._finished_activities:
            return []
        status = update.get("status")
        if isinstance(status, str) and status in _FINISHED_TOOL_STATUSES:
            phase = "finished"
            activity_status = _FINISHED_TOOL_STATUSES[status]
        elif status is None or (
            isinstance(status, str) and status in _NON_TERMINAL_TOOL_STATUSES
        ):
            phase = "updated"
            activity_status = None
        else:
            # Unknown/future or non-string status: ignore instead of inventing
            # an outcome, and never fabricate a duration for the missing field.
            return []
        self._synthetic_message_id = None
        event: dict[str, Any] = {
            "type": "dsh/v1/activity",
            **self._scope(),
            "activityId": tool_call_id,
            "phase": phase,
            "toolCallId": tool_call_id,
        }
        tool_name = self._tool_names.get(tool_call_id)
        if tool_name is not None:
            event["toolName"] = tool_name
        if activity_status is not None:
            event["status"] = activity_status
        summary = _content_text(update.get("content"))
        if summary is not None:
            event["outputSummary"] = _bounded_output_summary(summary)
        if phase == "finished":
            self._finished_activities.add(tool_call_id)
        return [event]
