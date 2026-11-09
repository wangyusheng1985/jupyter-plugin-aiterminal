"""Detached turn persistence updates the running cell in .agentnb."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jupyter_aiterminal.detached_document import (
    TERMINAL_REASONS,
    load_workspace,
    save_detached_turn,
)


def _workspace(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 5,
                "cells": [
                    {
                        "id": "cell-1",
                        "kind": "ai",
                        "source": "run",
                        "output": "",
                        "blocks": [],
                        "turn": None,
                        "status": "running",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_detached_completion_is_saved(tmp_path: Path) -> None:
    path = tmp_path / "workspace.agentnb"
    _workspace(path)

    success = save_detached_turn(
        path,
        cell_id="cell-1",
        turn_id="turn-123",
        blocks=[{"kind": "text", "id": "text-1", "text": "finished while detached"}],
        status="done",
    )

    assert success is True
    saved = load_workspace(path)
    assert saved["cells"][0]["status"] == "done"
    assert saved["cells"][0]["blocks"][0]["text"] == "finished while detached"
    assert saved["cells"][0]["turn"]["id"] == "turn-123"
    assert not path.with_suffix(".agentnb.tmp").exists()


def test_detached_fallback_finds_running_cell(tmp_path: Path) -> None:
    path = tmp_path / "workspace.agentnb"
    _workspace(path)

    success = save_detached_turn(
        path,
        blocks=[{"kind": "text", "id": "text-2", "text": "auto found cell"}],
        status="done",
    )

    assert success is True
    saved = load_workspace(path)
    assert saved["cells"][0]["status"] == "done"
    assert saved["cells"][0]["blocks"][0]["text"] == "auto found cell"
    assert saved["cells"][0]["turn"] is None


@pytest.mark.parametrize(
    "reason", ["completed", "cancelled", "budget-exhausted", "failed"]
)
def test_detached_turn_persists_known_terminal_reason(
    tmp_path: Path, reason: str
) -> None:
    path = tmp_path / "workspace.agentnb"
    _workspace(path)

    success = save_detached_turn(
        path,
        cell_id="cell-1",
        turn_id="turn-456",
        blocks=[{"kind": "text", "id": "text-3", "text": "partial answer"}],
        status="error" if reason == "failed" else "done",
        reason=reason,
    )

    assert success is True
    saved = load_workspace(path)
    turn = saved["cells"][0]["turn"]
    # Field name matches the frontend PersistedTurn protocol.
    assert turn["terminalReason"] == reason
    assert turn["resultText"] == ""
    assert saved["cells"][0]["blocks"][0]["text"] == "partial answer"


def test_detached_turn_drops_unknown_terminal_reason(tmp_path: Path) -> None:
    path = tmp_path / "workspace.agentnb"
    _workspace(path)

    secret = "secret-cancelled-note"
    success = save_detached_turn(
        path,
        cell_id="cell-1",
        turn_id="turn-789",
        blocks=[{"kind": "text", "id": "text-4", "text": "done"}],
        status="done",
        reason=secret,
    )

    assert success is True
    saved = load_workspace(path)
    assert "terminalReason" not in saved["cells"][0]["turn"]
    assert secret not in path.read_text(encoding="utf-8")
    assert secret not in saved["cells"][0]["turn"]["resultText"]


def test_detached_turn_without_reason_keeps_legacy_shape(tmp_path: Path) -> None:
    path = tmp_path / "workspace.agentnb"
    _workspace(path)

    success = save_detached_turn(
        path,
        cell_id="cell-1",
        turn_id="turn-000",
        blocks=[{"kind": "text", "id": "text-5", "text": "legacy"}],
        status="done",
    )

    assert success is True
    turn = load_workspace(path)["cells"][0]["turn"]
    assert "terminalReason" not in turn
    assert set(turn) == {
        "id",
        "status",
        "resultText",
        "resultIsError",
        "metrics",
        "presentation",
    }


def test_detached_turn_reason_preserves_linkage_and_presentation(
    tmp_path: Path,
) -> None:
    path = tmp_path / "workspace.agentnb"
    path.write_text(
        json.dumps(
            {
                "version": 5,
                "cells": [
                    {
                        "id": "cell-1",
                        "kind": "ai",
                        "source": "run",
                        "output": "",
                        "blocks": [],
                        "status": "running",
                        "turn": {
                            "id": "turn-link",
                            "status": "running",
                            "resultText": "",
                            "resultIsError": False,
                            "metrics": {},
                            "presentation": {
                                "trace": "expanded",
                                "expandedActivityIds": ["a1"],
                                "fullEvidenceActivityIds": [],
                                "outcomeExpanded": True,
                            },
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    success = save_detached_turn(
        path,
        cell_id="cell-1",
        turn_id="turn-link",
        blocks=[{"kind": "text", "id": "text-6", "text": "finished"}],
        status="done",
        reason="completed",
    )

    assert success is True
    cell = load_workspace(path)["cells"][0]
    assert cell["id"] == "cell-1"
    assert cell["status"] == "done"
    assert cell["turn"]["id"] == "turn-link"
    assert cell["turn"]["terminalReason"] == "completed"
    assert cell["turn"]["presentation"] == {
        "trace": "expanded",
        "expandedActivityIds": ["a1"],
        "fullEvidenceActivityIds": [],
        "outcomeExpanded": True,
    }


def test_terminal_reasons_match_frontend_protocol() -> None:
    assert TERMINAL_REASONS == {"completed", "cancelled", "budget-exhausted", "failed"}
