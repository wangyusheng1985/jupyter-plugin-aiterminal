"""Server-authoritative context snapshot for a BTW side chat.

The snapshot is built from the saved ``.agentnb`` document on the server, never
from client-supplied text, so a failure cannot inject content and the panel
cannot include material the document does not hold. Only user questions and
committed assistant text are included: tool records, thinking blocks, evidence
panels, later cells and credentials never enter the snapshot by construction.

The snapshot is fixed at thread creation and never rebuilt. It is bounded by
whole question/answer pairs: oldest pairs are dropped first with a visible
omission notice, and the source pair is always kept. A source pair that alone
exceeds the source bound is an explicit error instead of a silent truncation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from .btw_protocol import (
    BTW_ERROR_SNAPSHOT_TOO_LARGE,
    BTW_MAX_SNAPSHOT_CHARS,
    BTW_MAX_SOURCE_CHARS,
)

__all__ = [
    "BtwSnapshotError",
    "answer_cards",
    "build_btw_snapshot",
]

_TERMINAL_STATUS = {
    "done": "completed",
    "interrupted": "interrupted",
    "error": "error",
}


class BtwSnapshotError(ValueError):
    """A snapshot that cannot be built safely, with a user-facing message."""


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _answer_text(cell: Mapping[str, Any]) -> str:
    turn = cell.get("turn")
    result = ""
    if isinstance(turn, Mapping):
        result = _text(turn.get("resultText")).strip()
    if result:
        return result
    blocks = cell.get("blocks")
    if not isinstance(blocks, list):
        return ""
    parts = [
        _text(block.get("text")).strip()
        for block in blocks
        if isinstance(block, Mapping) and block.get("kind") == "text"
    ]
    return "\n\n".join(part for part in parts if part)


def _terminal_status(cell: Mapping[str, Any]) -> str:
    turn = cell.get("turn")
    if not isinstance(turn, Mapping):
        return "unknown"
    reason = turn.get("terminalReason")
    if isinstance(reason, str) and reason in ("completed", "cancelled", "failed"):
        return reason
    status = turn.get("status")
    if isinstance(status, str):
        return _TERMINAL_STATUS.get(status, "unknown")
    return "unknown"


def answer_cards(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return every finished AI answer card in document order.

    A card is eligible only when it is an ``ai`` cell with a terminal turn and
    committed assistant text. Its ``answerNumber`` is 1-based over eligible
    cards, which is what the panel header shows as "source answer #N".
    """
    cells = document.get("cells")
    if not isinstance(cells, list):
        return []
    cards: list[dict[str, Any]] = []
    for cell in cells:
        if not isinstance(cell, Mapping) or cell.get("kind") != "ai":
            continue
        question = _text(cell.get("source")).strip()
        answer = _answer_text(cell)
        if not answer:
            continue
        status = _terminal_status(cell)
        if status == "unknown":
            # A running or never-finished turn has no snapshotable answer.
            continue
        cell_id = _text(cell.get("id"))
        if not cell_id:
            continue
        cards.append(
            {
                "answerNumber": len(cards) + 1,
                "cellId": cell_id,
                "question": question,
                "answer": answer,
                "status": status,
            }
        )
    return cards


def _pair_text(card: Mapping[str, Any], label: str) -> str:
    status = card.get("status")
    header = label if status == "completed" else f"{label} ({status})"
    question = card.get("question") or "(empty question)"
    return f"{header}\nQ: {question}\nA: {card.get('answer')}\n"


def build_btw_snapshot(
    document: Mapping[str, Any],
    *,
    cell_id: str,
    captured_at: str | None = None,
    max_chars: int = BTW_MAX_SNAPSHOT_CHARS,
    max_source_chars: int = BTW_MAX_SOURCE_CHARS,
) -> dict[str, Any]:
    """Build the fixed, bounded snapshot for the answer card ``cell_id``.

    Raises :class:`BtwSnapshotError` when the card does not exist or has no
    finished answer, and when the source question and answer together exceed
    ``max_source_chars`` (the refusal names sizes, never content). A source
    pair is never silently cut: either it fits and is stored whole, or the
    request is refused with a visible message.
    """
    if not isinstance(cell_id, str) or not cell_id:
        raise BtwSnapshotError("BTW source cell id must be a non-empty string")
    cards = answer_cards(document)
    index = next(
        (position for position, card in enumerate(cards) if card["cellId"] == cell_id),
        None,
    )
    if index is None:
        raise BtwSnapshotError(
            "The selected answer is not finished, so BTW cannot snapshot it."
        )
    source = dict(cards[index])
    source_chars = len(source["question"]) + len(source["answer"])
    if source_chars > max_source_chars:
        raise BtwSnapshotError(
            f"{BTW_ERROR_SNAPSHOT_TOO_LARGE} "
            f"(source is {source_chars} characters, limit {max_source_chars})"
        )

    stamp = captured_at or datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    header = (
        "[BTW context snapshot]\n"
        f"Captured: {stamp}\n"
        f"Source: answer #{source['answerNumber']} "
        f"(cell {source['cellId']}, status {source['status']}).\n"
        "Included: earlier user questions and committed assistant answers, in "
        "document order, and the source question and answer.\n"
        "Excluded: later cells, hidden reasoning, tool records, evidence "
        "panels, and credentials. Tools are disabled in this side chat.\n"
    )
    footer = "[End of snapshot]\n"
    source_block = _pair_text(
        source, f"[Source question/{answer_label(source)}]"
    )

    used = len(header) + len(source_block) + len(footer)
    included: list[str] = []
    omitted = 0
    for card in reversed(cards[:index]):
        block = _pair_text(card, f"[Earlier {answer_label(card)}]")
        if used + len(block) > max_chars:
            omitted += 1
            continue
        used += len(block)
        included.append(block)
    included.reverse()

    notice = ""
    if omitted:
        notice = (
            f"[{omitted} earlier question/answer pair(s) omitted to keep the "
            f"snapshot within {max_chars} characters. Snapshot captured at "
            f"{stamp}.]\n"
        )
    text = header + notice + "".join(included) + source_block + footer
    return {
        "cellId": source["cellId"],
        "answerNumber": source["answerNumber"],
        "terminalStatus": source["status"],
        "capturedAt": stamp,
        "omittedPairs": omitted,
        # The source pair is never cut: an oversized pair is refused above, so
        # a stored snapshot is always complete for the answer it names.
        "truncated": False,
        "sourceChars": source_chars,
        "text": text,
    }


def answer_label(card: Mapping[str, Any]) -> str:
    return f"answer #{card.get('answerNumber')}"


def snapshot_payload(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """Return the client-visible snapshot description without the raw text."""
    fields: Sequence[str] = (
        "capturedAt",
        "answerNumber",
        "omittedPairs",
        "truncated",
        "sourceChars",
    )
    return {key: snapshot.get(key) for key in fields}
