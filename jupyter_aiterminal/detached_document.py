"""Persist a detached AI turn into its owning ``.agentnb``.

The document is JSON in the current workspace snapshot shape. While a browser
is attached, the browser owns the file. While detached, this writer is
authoritative and updates the completed turn.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# Reasons the frontend renderer understands (see src/agent/turn.ts).
# Anything else is dropped rather than persisted or echoed back.
TERMINAL_REASONS = frozenset({"completed", "cancelled", "budget-exhausted", "failed"})


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
    if target_cell is None:
        # Find the last running AI cell or matching turn cell
        for candidate in reversed(cells):
            if not isinstance(candidate, dict) or candidate.get("kind") != "ai":
                continue
            if turn_id and isinstance(candidate.get("turn"), dict):
                if candidate["turn"].get("id") == turn_id:
                    target_cell = candidate
                    break
            if candidate.get("status") == "running":
                target_cell = candidate
                break

    if target_cell is None and cells:
        # Fallback to the last AI cell
        for candidate in reversed(cells):
            if isinstance(candidate, dict) and candidate.get("kind") == "ai":
                target_cell = candidate
                break

    if target_cell is None:
        return False

    target_cell["blocks"] = blocks
    target_cell["status"] = status
    if turn_id:
        existing_turn = target_cell.get("turn")
        presentation = (
            existing_turn.get("presentation")
            if isinstance(existing_turn, dict) and isinstance(existing_turn.get("presentation"), dict)
            else {
                "trace": "auto",
                "expandedActivityIds": [],
                "fullEvidenceActivityIds": [],
                "outcomeExpanded": False,
            }
        )
        turn: dict[str, Any] = {
            "id": turn_id,
            "status": status,
            "resultText": "",
            "resultIsError": status == "error",
            "metrics": {},
            "presentation": presentation,
        }
        if isinstance(reason, str) and reason in TERMINAL_REASONS:
            turn["terminalReason"] = reason
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
