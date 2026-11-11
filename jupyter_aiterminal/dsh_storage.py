"""Locate runtime-owned persistence without moving or rewriting session logs."""
from __future__ import annotations

from pathlib import Path


def runtime_storage_home(root: Path, session_id: str | None = None) -> Path:
    """New sessions share a stable store; old sessions retain their real store.

    Older shared runtimes wrote logs under the first session's DSH_HOME,
    irrespective of the later sessions' workspace indexes. Discover by exact
    directory name (never interpolate an opaque session id into a glob/path).
    Ambiguous copies are rejected rather than selecting potentially stale data.
    """
    root = root.resolve()
    default = root / "runtime" / "dsh"
    if not session_id:
        return default
    stores = [default, *root.glob("workspaces/*/sessions/*/dsh")]
    matches: set[Path] = set()
    for store in stores:
        if store.is_symlink() or not store.is_dir():
            continue
        for directory in (store / "sessions").glob("*/*"):
            if directory.name != session_id or directory.is_symlink():
                continue
            resolved = directory.resolve()
            if not resolved.is_relative_to(root):
                continue
            if any(p.is_file() and not p.is_symlink()
                   for p in directory.glob("session*.jsonl*")):
                matches.add(store.resolve())
    if len(matches) > 1:
        raise RuntimeError("Multiple durable stores contain this session; refusing ambiguous recovery.")
    if matches:
        return matches.pop()
    # Missing history must fail resume, never silently create a replacement.
    return default
