"""Persist a detached AI turn into its owning ``.agentnb``.

The document is JSON in the current workspace snapshot shape. While a browser
is attached, the browser owns the file. While detached, this writer is
authoritative and updates the completed turn.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Reasons the frontend renderer understands (see src/agent/turn.ts).
# Anything else is dropped rather than persisted or echoed back.
TERMINAL_REASONS = frozenset({"completed", "cancelled", "budget-exhausted", "failed"})
_TERMINAL_STATUSES = frozenset({"done", "interrupted", "error"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def load_workspace(path: str | Path) -> dict[str, Any]:
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError(f"workspace not found at {target}")
    document = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("cells"), list):
        raise ValueError("workspace document has no cells")
    return document


def save_detached_turn(
    path: str | Path,
    *,
    cell_id: str | None = None,
    turn_id: str | None = None,
    blocks: list[dict[str, Any]],
    status: str = "done",
    reason: str | None = None,
) -> bool:
    """Update the running cell in the workspace document with completed blocks.

    ``reason`` is the runtime terminal reason; only known values are stored on
    ``turn.terminalReason`` and it is never written into the assistant text.
    """
    target = Path(path)
    try:
        document = load_workspace(target)
    except Exception:
        return False

    cells = document.get("cells")
    if not isinstance(cells, list):
        return False

    target_cell: dict[str, Any] | None = None
    if cell_id:
        target_cell = next(
            (c for c in cells if isinstance(c, dict) and c.get("id") == cell_id),
            None,
        )
        # A named cell that no longer exists is not an invitation to guess.
        if target_cell is None:
            return False
    elif turn_id:
        target_cell = next(
            (
                c
                for c in cells
                if isinstance(c, dict)
                and isinstance(c.get("turn"), dict)
                and c["turn"].get("id") == turn_id
            ),
            None,
        )
        if target_cell is None:
            return False
    else:
        # Legacy callers without identity may still target the last running AI
        # cell. They never overwrite a cell that already owns a turn.
        for candidate in reversed(cells):
            if not isinstance(candidate, dict) or candidate.get("kind") != "ai":
                continue
            if candidate.get("status") in {"running", "pending"}:
                target_cell = candidate
                break
        if target_cell is None:
            for candidate in reversed(cells):
                if (
                    isinstance(candidate, dict)
                    and candidate.get("kind") == "ai"
                    and candidate.get("turn") is None
                ):
                    target_cell = candidate
                    break

    if target_cell is None:
        return False

    existing_turn = target_cell.get("turn")
    if not isinstance(existing_turn, dict):
        existing_turn = None
    existing_turn_id = (
        existing_turn.get("id") if existing_turn is not None else None
    )
    if not isinstance(existing_turn_id, str) or not existing_turn_id:
        existing_turn_id = None

    # Conflict rule: a named turn may replace an older turn on the same cell,
    # but a newer timestamp always wins. A different turn id with a strictly
    # newer stamp is a later frontend retry; never move the document back.
    if not turn_id and existing_turn_id:
        return False
    if (
        turn_id
        and existing_turn_id is None
        and target_cell.get("status") in _TERMINAL_STATUSES
        and isinstance(target_cell.get("blocks"), list)
        and target_cell["blocks"]
    ):
        return False

    now = _now()
    now_ts = _timestamp(now)
    existing_updated = _timestamp(
        existing_turn.get("updatedAt") if existing_turn is not None else None
    )
    # A frontend that saved after this writer started has a strictly newer
    # stamp; do not move the document backwards over it.
    if (
        now_ts is not None
        and existing_updated is not None
        and existing_updated > now_ts
    ):
        return False

    incoming_blocks = blocks if isinstance(blocks, list) else []
    existing_blocks = (
        target_cell.get("blocks")
        if isinstance(target_cell.get("blocks"), list)
        else []
    )
    same_turn = bool(turn_id and existing_turn_id == turn_id)
    merged_blocks = (
        (incoming_blocks if len(incoming_blocks) >= len(existing_blocks) else existing_blocks)
        if same_turn
        else incoming_blocks
    )

    merged_status = status
    if same_turn and existing_turn is not None:
        existing_status = existing_turn.get("status")
        if (
            existing_status in _TERMINAL_STATUSES
            and len(existing_blocks) > len(incoming_blocks)
        ):
            merged_status = existing_status

    target_cell["blocks"] = merged_blocks
    target_cell["status"] = merged_status
    if turn_id:
        presentation = (
            existing_turn.get("presentation")
            if same_turn
            and existing_turn is not None
            and isinstance(existing_turn.get("presentation"), dict)
            else {
                "trace": "collapsed",
                "expandedActivityIds": [],
                "fullEvidenceActivityIds": [],
            }
        )
        metrics = (
            existing_turn.get("metrics")
            if same_turn
            and existing_turn is not None
            and isinstance(existing_turn.get("metrics"), dict)
            else {}
        )
        existing_result = (
            existing_turn.get("resultText")
            if same_turn
            and existing_turn is not None
            and isinstance(existing_turn.get("resultText"), str)
            else ""
        )
        turn: dict[str, Any] = {
            "id": turn_id,
            "status": merged_status,
            "resultText": existing_result,
            "resultIsError": merged_status == "error",
            "metrics": metrics,
            "presentation": presentation,
            "updatedAt": now,
        }
        terminal_reason = reason
        if not (
            isinstance(terminal_reason, str)
            and terminal_reason in TERMINAL_REASONS
        ):
            terminal_reason = (
                existing_turn.get("terminalReason")
                if same_turn and existing_turn is not None
                else None
            )
        if isinstance(terminal_reason, str) and terminal_reason in TERMINAL_REASONS:
            turn["terminalReason"] = terminal_reason
        target_cell["turn"] = turn

    temporary = target.with_suffix(target.suffix + ".tmp")
    try:
        temporary.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, target)
        return True
    except Exception:
        if temporary.exists():
            temporary.unlink(missing_ok=True)
        return False
