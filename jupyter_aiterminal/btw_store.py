"""Private, crash-safe persistence for BTW threads and the send-back queue.

Layout (server-owned, one private file per notebook)::

    <storage root>/btw/<user key>/<notebook key>.json

The notebook key is a hash of the normalized notebook path; the file also
stores that path so a hash collision or a copied file is detected instead of
silently serving another notebook's thread. Client-supplied paths are
normalized and resolved under the Jupyter server root: absolute paths, ``..``
segments, backslashes, and symlinks (including a symlinked ancestor) are
rejected before any read or write. Session ids are opaque strings used only as
stored values, never as path components.

Concurrency: every state file is guarded by one ``asyncio.Lock`` per notebook,
and each write goes through a temporary file plus ``os.replace`` with fsync, so
two concurrent BTW operations on the same notebook cannot lose an update and a
crash cannot leave a half-written file.

Send-back queue rules:

* Enqueue is idempotent per ``requestId``: a replay returns the existing entry
  and never appends a second one.
* An entry must be claimed (``queued`` -> ``delivering``) before a client may
  insert it into a main-session input cell, then acknowledged as ``delivered``,
  ``failed``, or ``unknown``.
* ``delivering`` entries found on the first load in a new server process are
  downgraded to ``unknown``: the server cannot prove what the previous client
  did, and replaying would risk a duplicate. They are never auto-retried.
* Only ``queued`` entries can be cancelled; cancelling after a claim would race
  an insertion the user may already see.
"""

from __future__ import annotations

import asyncio
import calendar
import hashlib
import json
import os
import re
import stat
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, TypeVar

from .btw_protocol import (
    BTW_MAX_MESSAGES_PER_THREAD,
    BTW_MAX_MESSAGE_CHARS,
    BTW_MAX_NOTEBOOK_PATH_CHARS,
    BTW_MAX_QUEUE_ENTRIES,
    BTW_MAX_REQUEST_ID_CHARS,
    BTW_MAX_STATE_BYTES,
    BTW_MAX_THREADS_PER_NOTEBOOK,
    BTW_QUEUE_STALE_SECONDS,
)

__all__ = [
    "BtwStorageError",
    "BtwStore",
    "ack_queue_entry",
    "cancel_queue_entry",
    "claim_next_entry",
    "create_thread",
    "enqueue_send_back",
    "find_thread_by_cell",
    "has_delivering_entry",
    "normalize_notebook_path",
    "recover_queue",
]

STATE_VERSION = 1
_NOTEBOOK_SUFFIXES = (".agentnb", ".ipynb")
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,%d}$" % BTW_MAX_REQUEST_ID_CHARS)
_THREAD_ID_PATTERN = re.compile(r"^thread-[0-9a-f]{16,32}$")
_ACK_OUTCOMES = ("delivered", "failed", "unknown")
T = TypeVar("T")


class BtwStorageError(RuntimeError):
    """A BTW storage failure with a stable, user-facing message."""


def normalize_notebook_path(value: object) -> str:
    """Validate a notebook path as a relative, separator-clean document path.

    Returns the normalized POSIX-style path used both as the storage key input
    and as the authoritative notebook identity. Raises
    :class:`BtwStorageError` for anything that could escape the server root or
    name an unsupported document.
    """
    if not isinstance(value, str) or not value.strip():
        raise BtwStorageError("A notebook path is required for BTW.")
    if len(value) > BTW_MAX_NOTEBOOK_PATH_CHARS:
        raise BtwStorageError("The notebook path is too long for BTW.")
    if "\x00" in value or "\\" in value:
        raise BtwStorageError("The notebook path is not a supported BTW path.")
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise BtwStorageError("BTW requires a notebook path inside the server root.")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise BtwStorageError("The notebook path is not a supported BTW path.")
    if not value.endswith(_NOTEBOOK_SUFFIXES):
        raise BtwStorageError("BTW only supports agent notebooks.")
    return value


def resolve_notebook_file(root: str | Path, relative: object) -> Path:
    """Resolve ``relative`` under ``root`` with symlink and traversal checks.

    Every existing component is inspected with ``lstat`` so a symlinked parent
    cannot redirect the lookup, and the final real path must stay inside the
    server root. Missing documents raise instead of creating anything.
    """
    normalized = normalize_notebook_path(relative)
    root_path = Path(root).resolve(strict=True)
    candidate = root_path
    for part in normalized.split("/"):
        candidate = candidate / part
        try:
            info = candidate.lstat()
        except FileNotFoundError as exc:
            raise BtwStorageError(
                "The notebook for this BTW thread is missing or outside the "
                "server root."
            ) from exc
        except OSError as exc:
            raise BtwStorageError(
                "The notebook for this BTW thread could not be inspected."
            ) from exc
        if stat.S_ISLNK(info.st_mode):
            raise BtwStorageError(
                "The notebook for this BTW thread must not be a symlink."
            )
    real = candidate.resolve()
    if not real.is_relative_to(root_path):
        raise BtwStorageError(
            "The notebook for this BTW thread is outside the server root."
        )
    if not real.is_file():
        raise BtwStorageError(
            "The notebook for this BTW thread is missing or outside the server "
            "root."
        )
    return real


def _user_key(user: str) -> str:
    if not isinstance(user, str) or not user:
        raise BtwStorageError("A BTW user scope is required.")
    return hashlib.sha256(user.encode("utf-8")).hexdigest()[:32]


def _notebook_key(notebook: str) -> str:
    return hashlib.sha256(notebook.encode("utf-8")).hexdigest()[:32]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def empty_state(notebook: str) -> dict[str, Any]:
    return {"version": STATE_VERSION, "notebook": notebook, "threads": {}}


def create_thread(
    state: dict[str, Any],
    *,
    cell_id: str,
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    """Create and store one thread for ``cell_id``; return the stored thread."""
    threads = state["threads"]
    if len(threads) >= BTW_MAX_THREADS_PER_NOTEBOOK:
        raise BtwStorageError(
            "This notebook already has the maximum number of BTW threads. "
            "Remove older BTW threads before starting another."
        )
    thread = {
        "threadId": f"thread-{uuid.uuid4().hex[:24]}",
        "cellId": cell_id,
        "answerNumber": int(snapshot.get("answerNumber") or 0),
        "snapshotVersion": STATE_VERSION,
        "snapshot": {
            "text": str(snapshot.get("text") or ""),
            "capturedAt": str(snapshot.get("capturedAt") or ""),
            "omittedPairs": int(snapshot.get("omittedPairs") or 0),
            "truncated": bool(snapshot.get("truncated")),
            "sourceChars": int(snapshot.get("sourceChars") or 0),
            "terminalStatus": str(snapshot.get("terminalStatus") or "unknown"),
        },
        "sessionId": None,
        "createdAt": _now(),
        "updatedAt": _now(),
        "messages": [],
        "messagesOmitted": 0,
        "queue": [],
    }
    threads[thread["threadId"]] = thread
    return thread


def find_thread_by_cell(
    state: Mapping[str, Any], cell_id: str
) -> dict[str, Any] | None:
    threads = state.get("threads")
    if not isinstance(threads, Mapping):
        return None
    for thread in threads.values():
        if isinstance(thread, dict) and thread.get("cellId") == cell_id:
            return thread
    return None


def append_message(
    thread: dict[str, Any], *, role: str, text: str, status: str
) -> dict[str, Any]:
    """Append one message, trimming the oldest entries beyond the bound."""
    if role not in ("user", "assistant"):
        raise BtwStorageError("BTW message role is invalid.")
    if status not in ("done", "cancelled", "failed"):
        raise BtwStorageError("BTW message status is invalid.")
    if not isinstance(text, str):
        raise BtwStorageError("BTW message text is invalid.")
    if role == "user" and len(text) > BTW_MAX_MESSAGE_CHARS:
        raise BtwStorageError(
            "The BTW message is too long. Shorten it before sending."
        )
    if len(text) > BTW_MAX_MESSAGE_CHARS:
        text = (
            text[:BTW_MAX_MESSAGE_CHARS]
            + "\n[... BTW answer truncated by the server ...]"
        )
    message = {
        "id": f"msg-{uuid.uuid4().hex[:16]}",
        "role": role,
        "text": text,
        "status": status,
        "at": _now(),
    }
    messages = thread.setdefault("messages", [])
    messages.append(message)
    overflow = len(messages) - BTW_MAX_MESSAGES_PER_THREAD
    if overflow > 0:
        del messages[:overflow]
        thread["messagesOmitted"] = int(thread.get("messagesOmitted") or 0) + overflow
    thread["updatedAt"] = _now()
    return message


def _prune_terminal_queue(thread: dict[str, Any]) -> None:
    queue = thread.setdefault("queue", [])
    if len(queue) < BTW_MAX_QUEUE_ENTRIES:
        return
    for index, entry in enumerate(queue):
        if entry.get("status") in ("delivered", "cancelled", "failed"):
            del queue[index]
            return


def enqueue_send_back(
    thread: dict[str, Any], *, request_id: str, text: str
) -> tuple[dict[str, Any], bool]:
    """Idempotently enqueue one send-back request.

    Returns ``(entry, created)``. A repeated ``request_id`` never appends a
    second entry, so a retried HTTP request cannot duplicate a delivery.
    """
    if (
        not isinstance(request_id, str)
        or _REQUEST_ID_PATTERN.fullmatch(request_id) is None
    ):
        raise BtwStorageError("The send-back request id is invalid.")
    if not isinstance(text, str) or not text.strip():
        raise BtwStorageError("Send-back text must not be empty.")
    if len(text) > BTW_MAX_MESSAGE_CHARS:
        raise BtwStorageError(
            "The send-back text is too long. Shorten it before queueing."
        )
    queue = thread.setdefault("queue", [])
    for entry in queue:
        if entry.get("requestId") == request_id:
            return entry, False
    _prune_terminal_queue(thread)
    entry = {
        "requestId": request_id,
        "text": text,
        "status": "queued",
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    queue.append(entry)
    thread["updatedAt"] = _now()
    return entry, True


def _find_entry(thread: Mapping[str, Any], request_id: str) -> dict[str, Any] | None:
    queue = thread.get("queue")
    if not isinstance(queue, list):
        return None
    for entry in queue:
        if isinstance(entry, dict) and entry.get("requestId") == request_id:
            return entry
    return None


def claim_next_entry(thread: dict[str, Any]) -> dict[str, Any] | None:
    """Atomically claim the oldest ``queued`` entry for delivery.

    The claim writes a ``claimId`` onto the entry. Only the holder of that id
    may acknowledge or cancel it, so a second client that somehow races the
    claim cannot overwrite the outcome of the first one.
    """
    queue = thread.get("queue")
    if not isinstance(queue, list):
        return None
    for entry in queue:
        if entry.get("status") == "queued":
            entry["status"] = "delivering"
            entry["claimId"] = f"claim-{uuid.uuid4().hex[:16]}"
            entry["updatedAt"] = _now()
            thread["updatedAt"] = _now()
            return entry
    return None


def has_delivering_entry(state: Mapping[str, Any]) -> bool:
    """Whether any thread in this notebook already holds a live claim."""
    threads = state.get("threads")
    if not isinstance(threads, Mapping):
        return False
    for thread in threads.values():
        queue = thread.get("queue") if isinstance(thread, Mapping) else None
        if not isinstance(queue, list):
            continue
        for entry in queue:
            if isinstance(entry, Mapping) and entry.get("status") == "delivering":
                return True
    return False


def ack_queue_entry(
    thread: dict[str, Any], *, request_id: str, claim_id: object, outcome: str
) -> dict[str, Any]:
    """Record a delivery outcome for the entry this client claimed.

    The claim id must match the one written by :func:`claim_next_entry`; a
    missing or stale id is rejected, so two clients cannot acknowledge the same
    delivery or acknowledge one they never claimed. Terminal entries stay
    idempotent (repeating the same outcome returns the stored entry).
    """
    if outcome not in _ACK_OUTCOMES:
        raise BtwStorageError("The send-back outcome is invalid.")
    entry = _find_entry(thread, request_id)
    if entry is None:
        raise BtwStorageError("The send-back request was not found.")
    status = entry.get("status")
    if status == "queued":
        raise BtwStorageError(
            "The send-back request was not claimed before acknowledgement."
        )
    if status in ("delivered", "failed", "unknown", "cancelled"):
        return entry
    stored = entry.get("claimId")
    if (
        not isinstance(claim_id, str)
        or not claim_id
        or not isinstance(stored, str)
        or stored != claim_id
    ):
        raise BtwStorageError(
            "The send-back claim does not match this delivery."
        )
    entry["status"] = outcome
    entry.pop("claimId", None)
    entry["updatedAt"] = _now()
    thread["updatedAt"] = _now()
    return entry


def cancel_queue_entry(
    thread: dict[str, Any], *, request_id: str, claim_id: object = None
) -> dict[str, Any]:
    """Cancel one queued request, or a claimed one by its claim holder."""
    entry = _find_entry(thread, request_id)
    if entry is None:
        raise BtwStorageError("The send-back request was not found.")
    status = entry.get("status")
    if status == "delivering":
        stored = entry.get("claimId")
        if (
            not isinstance(claim_id, str)
            or not claim_id
            or not isinstance(stored, str)
            or stored != claim_id
        ):
            raise BtwStorageError(
                "The send-back claim does not match this delivery."
            )
    elif status != "queued":
        raise BtwStorageError(
            "Only a queued send-back request can be cancelled."
        )
    entry["status"] = "cancelled"
    entry.pop("claimId", None)
    entry["updatedAt"] = _now()
    thread["updatedAt"] = _now()
    return entry


def recover_queue(
    thread: dict[str, Any], *, stale_seconds: int = BTW_QUEUE_STALE_SECONDS
) -> int:
    """Downgrade unprovable ``delivering`` entries to ``unknown``.

    Called once per state file after a new server process loads it, and for a
    claim that has been in flight longer than ``stale_seconds``. The entry is
    never replayed automatically: ``unknown`` requires an explicit user
    decision.
    """
    queue = thread.get("queue")
    if not isinstance(queue, list):
        return 0
    now = time.time()
    changed = 0
    for entry in queue:
        if entry.get("status") != "delivering":
            continue
        stamp = entry.get("updatedAt")
        age = None
        try:
            # ``updatedAt`` is UTC; ``calendar.timegm`` reads the struct as UTC
            # so a non-UTC server timezone cannot fabricate an age.
            age = now - calendar.timegm(
                time.strptime(str(stamp), "%Y-%m-%dT%H:%M:%SZ")
            )
        except (ValueError, OverflowError):
            age = None
        if age is None or age >= stale_seconds:
            entry["status"] = "unknown"
            entry.pop("claimId", None)
            entry["note"] = (
                "Delivery could not be confirmed. Confirm before sending again."
            )
            entry["updatedAt"] = _now()
            changed += 1
    if changed:
        thread["updatedAt"] = _now()
    return changed


def validate_state(state: object, notebook: str) -> dict[str, Any]:
    """Validate a loaded state document, refusing anything ambiguous."""
    if not isinstance(state, dict):
        raise BtwStorageError(
            "The saved BTW state for this notebook is not readable."
        )
    if state.get("notebook") != notebook:
        raise BtwStorageError(
            "The saved BTW state does not belong to this notebook."
        )
    if state.get("version") != STATE_VERSION:
        raise BtwStorageError(
            "The saved BTW state uses an unsupported version."
        )
    threads = state.get("threads")
    if not isinstance(threads, dict):
        raise BtwStorageError("The saved BTW state is not readable.")
    for thread_id, thread in threads.items():
        if (
            not isinstance(thread_id, str)
            or _THREAD_ID_PATTERN.fullmatch(thread_id) is None
            or not isinstance(thread, dict)
            or thread.get("threadId") != thread_id
            or not isinstance(thread.get("messages"), list)
            or not isinstance(thread.get("queue"), list)
        ):
            raise BtwStorageError("The saved BTW state is not readable.")
    return state


class BtwStore:
    """One private BTW store for one Jupyter server process."""

    def __init__(
        self,
        root: str | Path,
        *,
        max_state_bytes: int = BTW_MAX_STATE_BYTES,
    ) -> None:
        path = Path(root)
        if not path.is_absolute():
            raise BtwStorageError("BTW storage root must be an absolute path.")
        self._root = path
        self._max_state_bytes = max_state_bytes
        self._locks: dict[str, asyncio.Lock] = {}
        self._recovered: set[str] = set()

    @property
    def root(self) -> Path:
        return self._root

    def _ensure_private_dir(self, path: Path) -> Path:
        if path.exists() or path.is_symlink():
            if path.is_symlink() or not path.is_dir():
                raise BtwStorageError(
                    "The BTW storage directory is not usable."
                )
        else:
            path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, 0o700)
        return path

    def state_path(self, user: str, notebook: str) -> Path:
        normalized = normalize_notebook_path(notebook)
        directory = self._ensure_private_dir(
            self._ensure_private_dir(self._root) / "btw" / _user_key(user)
        )
        return directory / f"{_notebook_key(normalized)}.json"

    def load(self, user: str, notebook: str) -> dict[str, Any]:
        normalized = normalize_notebook_path(notebook)
        path = self.state_path(user, notebook)
        state = empty_state(normalized)
        if path.is_file():
            if path.is_symlink():
                raise BtwStorageError("The saved BTW state must not be a symlink.")
            try:
                raw = path.read_text(encoding="utf-8")
                if len(raw.encode("utf-8")) > self._max_state_bytes:
                    raise BtwStorageError(
                        "The saved BTW state for this notebook is too large."
                    )
                state = validate_state(json.loads(raw), normalized)
            except BtwStorageError:
                raise
            except (OSError, json.JSONDecodeError) as exc:
                raise BtwStorageError(
                    "The saved BTW state for this notebook is not readable."
                ) from exc
        elif path.exists():
            raise BtwStorageError("The saved BTW state is not a regular file.")
        first_load = str(path) not in self._recovered
        self._recovered.add(str(path))
        for thread in state["threads"].values():
            # A claim that was live when the previous server process ended can
            # never be proven delivered, so the first load in a new process
            # downgrades it immediately; later loads only expire stale claims.
            recover_queue(thread, stale_seconds=0 if first_load else BTW_QUEUE_STALE_SECONDS)
        return state

    def save(self, user: str, notebook: str, state: Mapping[str, Any]) -> None:
        normalized = normalize_notebook_path(notebook)
        path = self.state_path(user, notebook)
        validated = validate_state(dict(state), normalized)
        raw = json.dumps(validated, ensure_ascii=True, sort_keys=True)
        if len(raw.encode("utf-8")) > self._max_state_bytes:
            raise BtwStorageError(
                "The saved BTW state for this notebook would be too large. "
                "Remove older BTW threads."
            )
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix=".btw-",
                delete=False,
            ) as stream:
                temporary = stream.name
                os.chmod(temporary, 0o600)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError as exc:
            raise BtwStorageError(
                "The BTW state for this notebook could not be saved."
            ) from exc
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)

    def lock(self, user: str, notebook: str) -> asyncio.Lock:
        key = str(self.state_path(user, notebook))
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def update(
        self,
        user: str,
        notebook: str,
        mutate: Callable[[dict[str, Any]], T],
    ) -> tuple[dict[str, Any], T]:
        """Apply ``mutate`` to a locked, freshly loaded state and persist it."""
        async with self.lock(user, notebook):
            state = self.load(user, notebook)
            result = mutate(state)
            self.save(user, notebook, state)
            return state, result


def thread_queue(thread: Mapping[str, Any]) -> Sequence[Mapping[str, Any]]:
    queue = thread.get("queue")
    return queue if isinstance(queue, list) else []
