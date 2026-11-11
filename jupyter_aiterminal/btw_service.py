"""Service layer that binds BTW threads, snapshots, storage, and the runtime.

The service is the only place that decides when a BTW runtime or session is
created. Opening the panel, or clicking BTW again on the same card, never
starts a model call: a session is created on the first sent message, and a
thread is keyed by the source cell id so repeated clicks resume the same
conversation.

Every stored mutation goes through :class:`~jupyter_aiterminal.btw_store.BtwStore`
(one lock per notebook, atomic writes). The model call itself runs outside the
storage lock so one slow BTW answer cannot block another thread's bookkeeping.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .btw_protocol import (
    BTW_ERROR_RESTORE_FAILED,
    BTW_ERROR_UNKNOWN_NOTEBOOK,
)
from .btw_snapshot import BtwSnapshotError, build_btw_snapshot
from .btw_store import (
    BtwStorageError,
    BtwStore,
    ack_queue_entry,
    append_message,
    cancel_queue_entry,
    claim_next_entry,
    create_thread,
    enqueue_send_back,
    find_thread_by_cell,
    has_delivering_entry,
    normalize_notebook_path,
    resolve_notebook_file,
)
from .dsh_btw import BtwRuntime, BtwRuntimeError
from .dsh_config import DshProviderConfig
from .settings import AgentConfigError, load_dsh_settings

__all__ = ["BtwService", "BtwServiceError"]

_SNAPSHOT_HEADER = (
    "[BTW side chat]\n"
    "Use the snapshot above as background. This side chat has no tools: it can "
    "only discuss. Do not claim to have run commands or changed files.\n\n"
)


class BtwServiceError(RuntimeError):
    """A BTW request failure with a user-facing message."""


class BtwService:
    def __init__(
        self,
        *,
        root: str | Path,
        store: BtwStore,
        settings_loader: Callable[[], DshProviderConfig] = load_dsh_settings,
        runtime_factory: Callable[..., BtwRuntime] = BtwRuntime,
    ) -> None:
        path = Path(root)
        if not path.is_absolute() or not path.is_dir():
            raise BtwServiceError("BTW requires an absolute server root directory")
        self._root = path
        self._store = store
        self._settings_loader = settings_loader
        self._runtime_factory = runtime_factory
        self._runtime: BtwRuntime | None = None
        self._runtime_lock = asyncio.Lock()
        self._busy: set[tuple[str, str]] = set()
        self._busy_lock = asyncio.Lock()

    # -- lifecycle -----------------------------------------------------------

    async def _ensure_runtime(self) -> BtwRuntime:
        async with self._runtime_lock:
            if self._runtime is not None:
                return self._runtime
            try:
                config = self._settings_loader()
            except AgentConfigError as exc:
                raise BtwServiceError(str(exc)) from exc
            except Exception as exc:  # noqa: BLE001 - never echo raw settings
                raise BtwServiceError(
                    "AI Terminal provider settings could not be loaded for BTW."
                ) from exc
            try:
                runtime = self._runtime_factory(
                    config=config,
                    workspace_root=str(self._root),
                    storage_root=str(self._store.root / "runtime"),
                )
            except BtwRuntimeError as exc:
                raise BtwServiceError(str(exc)) from exc
            self._runtime = runtime
            return runtime

    async def close(self) -> None:
        async with self._runtime_lock:
            runtime = self._runtime
            self._runtime = None
        if runtime is not None:
            try:
                await runtime.close()
            except Exception:  # noqa: BLE001 - shutdown is best effort
                pass

    def status(self) -> dict[str, Any]:
        runtime = self._runtime
        return {
            "running": runtime is not None and runtime.running,
            "tools": "disabled",
            "threadsBusy": len(self._busy),
        }

    # -- threads -------------------------------------------------------------

    def _load_document(self, notebook: str) -> dict[str, Any]:
        try:
            path = resolve_notebook_file(self._root, notebook)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise BtwServiceError(BTW_ERROR_UNKNOWN_NOTEBOOK) from exc
        try:
            document = json.loads(text)
        except json.JSONDecodeError as exc:
            raise BtwServiceError(
                "The notebook for this BTW thread is not readable JSON."
            ) from exc
        if not isinstance(document, dict):
            raise BtwServiceError(
                "The notebook for this BTW thread is not a supported document."
            )
        return document

    async def open_thread(
        self, user: str, notebook: str, cell_id: str
    ) -> dict[str, Any]:
        """Return the thread for ``cell_id``, creating it once if absent."""
        normalized = normalize_notebook_path(notebook)
        if not isinstance(cell_id, str) or not cell_id:
            raise BtwServiceError("A source answer cell is required for BTW.")
        state = self._load_state(user, normalized)
        existing = find_thread_by_cell(state, cell_id)
        if existing is not None:
            return self._view(user, normalized, existing)
        document = self._load_document(normalized)
        try:
            snapshot = build_btw_snapshot(document, cell_id=cell_id)
        except BtwSnapshotError as exc:
            raise BtwServiceError(str(exc)) from exc

        def mutate(current: dict[str, Any]) -> dict[str, Any]:
            found = find_thread_by_cell(current, cell_id)
            if found is not None:
                # Another request created it between load and lock.
                return found
            return create_thread(current, cell_id=cell_id, snapshot=snapshot)

        try:
            state, thread = await self._store.update(user, normalized, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc
        return self._view_from_state(user, normalized, thread)

    async def restore_thread(
        self, user: str, notebook: str, cell_id: str
    ) -> dict[str, Any] | None:
        """Recover one thread by source cell id; never create anything.

        ``None`` means this answer has no stored thread yet. A corrupt or
        unreadable store raises instead of looking like "no thread", so a
        restore failure is never silently turned into a fresh thread.
        """
        normalized = normalize_notebook_path(notebook)
        state = self._load_state(user, normalized)
        thread = find_thread_by_cell(state, cell_id)
        if thread is None:
            return None
        return self._view_from_state(user, normalized, thread)

    def _load_state(self, user: str, notebook: str) -> dict[str, Any]:
        try:
            return self._store.load(user, notebook)
        except BtwStorageError as exc:
            raise BtwServiceError(f"{BTW_ERROR_RESTORE_FAILED} ({exc})") from exc

    def _view_from_state(
        self, user: str, notebook: str, thread: Mapping[str, Any]
    ) -> dict[str, Any]:
        return self._view(user, notebook, thread)

    def _view(
        self, user: str, notebook: str, thread: Mapping[str, Any]
    ) -> dict[str, Any]:
        thread_id = str(thread.get("threadId") or "")
        snapshot = thread.get("snapshot") or {}
        return {
            "threadId": thread_id,
            "cellId": thread.get("cellId"),
            "answerNumber": thread.get("answerNumber"),
            "notebook": notebook,
            "snapshot": {
                "capturedAt": snapshot.get("capturedAt"),
                "answerNumber": thread.get("answerNumber"),
                "omittedPairs": snapshot.get("omittedPairs", 0),
                "truncated": bool(snapshot.get("truncated")),
                "sourceChars": snapshot.get("sourceChars", 0),
                "terminalStatus": snapshot.get("terminalStatus", "unknown"),
            },
            "messages": [
                {
                    "id": message.get("id"),
                    "role": message.get("role"),
                    "text": message.get("text"),
                    "status": message.get("status"),
                    "at": message.get("at"),
                }
                for message in thread.get("messages") or []
                if isinstance(message, Mapping)
            ],
            "messagesOmitted": int(thread.get("messagesOmitted") or 0),
            "queue": [
                {
                    "requestId": entry.get("requestId"),
                    "text": entry.get("text"),
                    "status": entry.get("status"),
                    "claimId": entry.get("claimId"),
                    "updatedAt": entry.get("updatedAt"),
                    "note": entry.get("note"),
                }
                for entry in thread.get("queue") or []
                if isinstance(entry, Mapping)
            ],
            "busy": (user, thread_id) in self._busy,
        }

    def _find_thread(
        self, state: Mapping[str, Any], thread_id: str
    ) -> dict[str, Any]:
        threads = state.get("threads") or {}
        thread = threads.get(thread_id) if isinstance(threads, Mapping) else None
        if not isinstance(thread, dict):
            raise BtwServiceError("This BTW thread no longer exists.")
        return thread

    # -- conversation --------------------------------------------------------

    async def send(
        self, user: str, notebook: str, thread_id: str, text: str
    ) -> dict[str, Any]:
        """Send one message, creating the BTW session on the first send."""
        normalized = normalize_notebook_path(notebook)
        prompt = text if isinstance(text, str) else ""
        if not prompt.strip():
            raise BtwServiceError("The BTW message is empty.")
        key = (user, thread_id)
        async with self._busy_lock:
            if key in self._busy:
                raise BtwServiceError(
                    "This BTW thread is already answering. Wait for it to finish "
                    "or stop it first."
                )
            self._busy.add(key)
        try:
            state = self._load_state(user, normalized)
            thread = self._find_thread(state, thread_id)
            runtime = await self._ensure_runtime()
            session_id = thread.get("sessionId")
            try:
                if not isinstance(session_id, str) or not session_id:
                    session_id = await runtime.open_session(str(self._root))
                    await self._store_session(
                        user, normalized, thread_id, session_id
                    )
                else:
                    # A stored session that cannot be resumed is an explicit
                    # error; BTW never silently replaces it with a new session.
                    await runtime.resume_session(session_id, str(self._root))
            except BtwRuntimeError as exc:
                raise BtwServiceError(str(exc)) from exc
            snapshot_text = str((thread.get("snapshot") or {}).get("text") or "")
            first = not any(
                message.get("role") == "user"
                for message in thread.get("messages") or []
                if isinstance(message, Mapping)
            )
            await self._record_message(
                user, normalized, thread_id, role="user", text=prompt, status="done"
            )
            wire = prompt if not first else f"{snapshot_text}\n{_SNAPSHOT_HEADER}{prompt}"
            error = None
            try:
                result = await runtime.prompt(session_id, wire)
                answer = str(result.get("text") or "")
                status = str(result.get("status") or "failed")
                message_status = (
                    "done"
                    if status == "completed"
                    else "cancelled"
                    if status == "cancelled"
                    else "failed"
                )
                if not answer.strip():
                    answer = (
                        "BTW returned no answer."
                        if status == "completed"
                        else "BTW stopped before producing an answer."
                    )
                await self._record_message(
                    user,
                    normalized,
                    thread_id,
                    role="assistant",
                    text=answer,
                    status=message_status,
                )
            except BtwRuntimeError as exc:
                error = str(exc)
                await self._record_message(
                    user,
                    normalized,
                    thread_id,
                    role="assistant",
                    text="BTW could not answer this message.",
                    status="failed",
                )
            state = self._load_state(user, normalized)
            view = self._view_from_state(
                user, normalized, self._find_thread(state, thread_id)
            )
            if error is not None:
                view["error"] = error
            return view
        finally:
            async with self._busy_lock:
                self._busy.discard(key)

    async def _record_message(
        self,
        user: str,
        notebook: str,
        thread_id: str,
        *,
        role: str,
        text: str,
        status: str,
    ) -> None:
        def mutate(state: dict[str, Any]) -> None:
            thread = self._find_thread(state, thread_id)
            append_message(thread, role=role, text=text, status=status)

        try:
            await self._store.update(user, notebook, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc

    async def _store_session(
        self, user: str, notebook: str, thread_id: str, session_id: str
    ) -> None:
        def mutate(state: dict[str, Any]) -> None:
            thread = self._find_thread(state, thread_id)
            if thread.get("sessionId") and thread["sessionId"] != session_id:
                # Never replace a durable identity that another request set.
                raise BtwServiceError(
                    "This BTW thread already has a different saved session."
                )
            thread["sessionId"] = session_id

        try:
            await self._store.update(user, notebook, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc

    async def cancel(
        self, user: str, notebook: str, thread_id: str
    ) -> dict[str, Any]:
        """Cancel only this BTW thread's in-flight answer."""
        normalized = normalize_notebook_path(notebook)
        state = self._load_state(user, normalized)
        thread = self._find_thread(state, thread_id)
        session_id = thread.get("sessionId")
        runtime = self._runtime
        cancelled = False
        if runtime is not None and isinstance(session_id, str) and session_id:
            try:
                cancelled = await runtime.cancel(session_id)
            except BtwRuntimeError as exc:
                raise BtwServiceError(str(exc)) from exc
        state = self._load_state(user, normalized)
        view = self._view_from_state(
            user, normalized, self._find_thread(state, thread_id)
        )
        view["cancelled"] = cancelled
        return view

    # -- send-back queue -----------------------------------------------------

    async def enqueue(
        self,
        user: str,
        notebook: str,
        thread_id: str,
        request_id: str,
        text: str,
    ) -> dict[str, Any]:
        normalized = normalize_notebook_path(notebook)

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            thread = self._find_thread(state, thread_id)
            entry, created = enqueue_send_back(
                thread, request_id=request_id, text=text
            )
            return {**entry, "created": created}

        try:
            _, entry = await self._store.update(user, normalized, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc
        return entry

    async def claim(self, user: str, notebook: str) -> dict[str, Any]:
        """Claim the oldest queued send-back, at most one claim at a time.

        While any entry in this notebook is ``delivering`` another claim is
        refused with ``inFlight`` and no entry, so two tabs (or a restore racing
        an idle event) cannot each start a main turn.
        """
        normalized = normalize_notebook_path(notebook)
        claimed: dict[str, Any] | None = None
        in_flight = False

        def mutate(state: dict[str, Any]) -> dict[str, Any] | None:
            nonlocal in_flight
            if has_delivering_entry(state):
                in_flight = True
                return None
            threads = state.get("threads") or {}
            for thread_id in threads:
                thread = threads[thread_id]
                entry = claim_next_entry(thread)
                if entry is not None:
                    return {**entry, "threadId": thread_id}
            return None

        try:
            _, claimed = await self._store.update(user, normalized, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc
        return {"entry": claimed, "inFlight": in_flight and claimed is None}

    async def ack(
        self,
        user: str,
        notebook: str,
        request_id: str,
        claim_id: str,
        outcome: str,
    ) -> dict[str, Any]:
        normalized = normalize_notebook_path(notebook)

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            threads = state.get("threads") or {}
            for thread in threads.values():
                if any(
                    entry.get("requestId") == request_id
                    for entry in thread.get("queue") or []
                    if isinstance(entry, Mapping)
                ):
                    return ack_queue_entry(
                        thread,
                        request_id=request_id,
                        claim_id=claim_id,
                        outcome=outcome,
                    )
            raise BtwStorageError("The send-back request was not found.")

        try:
            _, entry = await self._store.update(user, normalized, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc
        return entry

    async def cancel_queued(
        self,
        user: str,
        notebook: str,
        request_id: str,
        claim_id: str | None = None,
    ) -> dict[str, Any]:
        normalized = normalize_notebook_path(notebook)

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            threads = state.get("threads") or {}
            for thread in threads.values():
                if any(
                    entry.get("requestId") == request_id
                    for entry in thread.get("queue") or []
                    if isinstance(entry, Mapping)
                ):
                    return cancel_queue_entry(
                        thread, request_id=request_id, claim_id=claim_id
                    )
            raise BtwStorageError("The send-back request was not found.")

        try:
            _, entry = await self._store.update(user, normalized, mutate)
        except BtwStorageError as exc:
            raise BtwServiceError(str(exc)) from exc
        return entry

    async def list_queue(self, user: str, notebook: str) -> dict[str, Any]:
        normalized = normalize_notebook_path(notebook)
        state = self._load_state(user, normalized)
        entries: list[dict[str, Any]] = []
        for thread_id, thread in (state.get("threads") or {}).items():
            for entry in thread.get("queue") or []:
                if isinstance(entry, Mapping):
                    entries.append(
                        {
                            "requestId": entry.get("requestId"),
                            "threadId": thread_id,
                            "text": entry.get("text"),
                            "status": entry.get("status"),
                            "claimId": entry.get("claimId"),
                            "updatedAt": entry.get("updatedAt"),
                            "note": entry.get("note"),
                        }
                    )
        return {"entries": entries}
