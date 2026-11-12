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
        "updatedAt",
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


def _turn_workspace(path: Path, turn: dict) -> None:
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
                        "blocks": [{"kind": "text", "id": "kept", "text": "kept"}],
                        "status": "done",
                        "turn": turn,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_detached_write_does_not_replace_a_different_newer_turn(
    tmp_path: Path,
) -> None:
    path = tmp_path / "workspace.agentnb"
    _turn_workspace(
        path,
        {
            "id": "turn-new",
            "status": "done",
            "resultText": "newer answer",
            "resultIsError": False,
            "metrics": {},
            "presentation": {
                "trace": "collapsed",
                "expandedActivityIds": [],
                "fullEvidenceActivityIds": [],
            },
            "updatedAt": "2999-01-01T00:00:00Z",
        },
    )
    before = path.read_text(encoding="utf-8")

    assert (
        save_detached_turn(
            path,
            cell_id="cell-1",
            turn_id="turn-old",
            blocks=[{"kind": "text", "id": "old", "text": "stale"}],
            status="done",
        )
        is False
    )
    assert path.read_text(encoding="utf-8") == before


def test_detached_write_does_not_overwrite_a_newer_frontend_stamp(
    tmp_path: Path,
) -> None:
    path = tmp_path / "workspace.agentnb"
    _turn_workspace(
        path,
        {
            "id": "turn-same",
            "status": "done",
            "resultText": "frontend final",
            "resultIsError": False,
            "metrics": {},
            "presentation": {
                "trace": "collapsed",
                "expandedActivityIds": [],
                "fullEvidenceActivityIds": [],
            },
            "updatedAt": "2999-01-01T00:00:00Z",
        },
    )
    before = path.read_text(encoding="utf-8")

    assert (
        save_detached_turn(
            path,
            cell_id="cell-1",
            turn_id="turn-same",
            blocks=[{"kind": "text", "id": "server", "text": "server final"}],
            status="done",
        )
        is False
    )
    assert path.read_text(encoding="utf-8") == before


def test_detached_write_replaces_an_interrupted_placeholder(
    tmp_path: Path,
) -> None:
    path = tmp_path / "workspace.agentnb"
    _turn_workspace(
        path,
        {
            "id": "turn-same",
            "status": "interrupted",
            "resultText": "",
            "resultIsError": False,
            "metrics": {},
            "presentation": {
                "trace": "collapsed",
                "expandedActivityIds": [],
                "fullEvidenceActivityIds": [],
            },
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    assert (
        save_detached_turn(
            path,
            cell_id="cell-1",
            turn_id="turn-same",
            blocks=[{"kind": "text", "id": "done", "text": "server final"}],
            status="done",
            reason="completed",
        )
        is True
    )
    cell = load_workspace(path)["cells"][0]
    assert cell["status"] == "done"
    assert cell["turn"]["status"] == "done"
    assert cell["turn"]["terminalReason"] == "completed"
    assert cell["blocks"][0]["text"] == "server final"


def test_detached_write_preserves_a_longer_frontend_result(
    tmp_path: Path,
) -> None:
    path = tmp_path / "workspace.agentnb"
    _turn_workspace(
        path,
        {
            "id": "turn-same",
            "status": "done",
            "resultText": "frontend final",
            "resultIsError": False,
            "metrics": {},
            "presentation": {
                "trace": "expanded",
                "expandedActivityIds": ["a1"],
                "fullEvidenceActivityIds": [],
            },
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    # The frontend has more evidence than the server's replay.
    document = load_workspace(path)
    document["cells"][0]["blocks"] = [
        {"kind": "text", "id": "one", "text": "one"},
        {"kind": "text", "id": "two", "text": "two"},
    ]
    path.write_text(json.dumps(document), encoding="utf-8")

    assert (
        save_detached_turn(
            path,
            cell_id="cell-1",
            turn_id="turn-same",
            blocks=[{"kind": "text", "id": "server", "text": "server"}],
            status="done",
        )
        is True
    )
    cell = load_workspace(path)["cells"][0]
    assert cell["turn"]["resultText"] == "frontend final"
    assert cell["turn"]["presentation"]["trace"] == "expanded"
    assert [block["id"] for block in cell["blocks"]] == ["one", "two"]


def test_late_server_write_after_a_newer_frontend_save_is_ignored(
    tmp_path: Path,
) -> None:
    path = tmp_path / "workspace.agentnb"
    _workspace(path)
    assert (
        save_detached_turn(
            path,
            cell_id="cell-1",
            turn_id="turn-same",
            blocks=[{"kind": "text", "id": "server-1", "text": "first write"}],
            status="done",
        )
        is True
    )

    # Frontend saves a richer terminal snapshot after the server write.
    document = load_workspace(path)
    cell = document["cells"][0]
    cell["blocks"] = [
        {"kind": "text", "id": "one", "text": "one"},
        {"kind": "text", "id": "two", "text": "two"},
    ]
    cell["turn"]["resultText"] = "frontend answer"
    cell["turn"]["updatedAt"] = "2999-01-01T00:00:00Z"
    path.write_text(json.dumps(document), encoding="utf-8")

    # A late duplicate server write must not move the file backwards.
    assert (
        save_detached_turn(
            path,
            cell_id="cell-1",
            turn_id="turn-same",
            blocks=[{"kind": "text", "id": "server-2", "text": "late"}],
            status="done",
        )
        is False
    )
    cell = load_workspace(path)["cells"][0]
    assert cell["turn"]["resultText"] == "frontend answer"
    assert [block["id"] for block in cell["blocks"]] == ["one", "two"]
