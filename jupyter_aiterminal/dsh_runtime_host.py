"""One shared DSH runtime process hosting many ACP sessions.

The transport and its ``initialize`` handshake belong to the Jupyter server.
Each workspace session only sends ``session/new`` or ``session/resume`` through
that transport. Closing one session does not stop the process.
"""

from __future__ import annotations

import asyncio
import copy
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from .dsh_acp_config import build_acp_session_params
from .dsh_acp_session import DshAcpSessionError
from .dsh_acp_transport import DshAcpError, DshAcpTransport
from .dsh_config import BUDGET_SOURCES, DerivedBudget

_PROTOCOL_VERSION = 1

# Configuration snapshots are presentation data with exactly one safe shape:
# the fixed report produced by ``DerivedBudget.safe_report()``. A snapshot or
# desired mapping is projected onto that whitelist instead of being scrubbed by
# key name, so an unknown key (``baseUrl``, ``note``, ``auth``, ...) can never
# carry a credential or userinfo URL into the report.
_BUDGET_FIELD_NAMES = frozenset(
    {
        "context_window",
        "max_output_tokens",
        "compaction_enabled",
        "threshold_ratio",
        "headroom",
        "retain_ratio",
        "summary_max_tokens",
        "message_budget",
        "pressure",
        "threshold",
        "retain",
    }
)
_COMPACTION_FIELDS = {
    "enabled": "boolean",
    "thresholdRatio": "ratio",
    "headroom": "integer",
    "retainRatio": "ratio",
    "summaryMaxTokens": "integer",
}
_COMPUTED_FIELDS = {
    "messageBudget": "integer",
    "pressure": "integer",
    "threshold": "integer",
    "retain": "integer",
}


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_ratio(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _project_scalar(key: str, value: Any, kind: str, path: str) -> Any:
    """Validate one known field's value type before it may be reported."""
    expected = {
        "boolean": (isinstance(value, bool), "a boolean"),
        "integer": (_is_integer(value), "an integer"),
        "ratio": (_is_ratio(value), "a number"),
    }
    accepted, description = expected[kind]
    if not accepted:
        raise DshAcpSessionError(f"{path}.{key} must be {description}")
    return value


def _project_fields(
    source: Mapping[str, Any], fields: Mapping[str, str], path: str
) -> dict[str, Any]:
    projected: dict[str, Any] = {}
    for key, kind in fields.items():
        if key in source:
            projected[key] = _project_scalar(key, source[key], kind, path)
    return projected


def _project_provenance_entry(entry: Any, path: str) -> dict[str, Any]:
    if not isinstance(entry, Mapping):
        raise DshAcpSessionError(f"{path} must be a mapping")
    source = entry.get("source")
    if source not in BUDGET_SOURCES:
        raise DshAcpSessionError(
            f"{path}.source must be one of: {', '.join(BUDGET_SOURCES)}"
        )
    projected: dict[str, Any] = {"source": source}
    derived_from = entry.get("derivedFrom")
    if derived_from is not None:
        if isinstance(derived_from, (str, bytes)) or not isinstance(
            derived_from, Sequence
        ):
            raise DshAcpSessionError(f"{path}.derivedFrom must be a list")
        names: list[str] = []
        for item in derived_from:
            if not isinstance(item, str) or item not in _BUDGET_FIELD_NAMES:
                raise DshAcpSessionError(
                    f"{path}.derivedFrom entries must be known budget field "
                    "names"
                )
            names.append(item)
        projected["derivedFrom"] = names
    return projected


def _project_provenance(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise DshAcpSessionError(f"{path} must be a mapping")
    projected: dict[str, Any] = {}
    for name, entry in value.items():
        if name not in _BUDGET_FIELD_NAMES:
            continue
        projected[name] = _project_provenance_entry(entry, f"{path}.{name}")
    return projected


def _project_snapshot(source: Any, label: str) -> dict[str, Any]:
    """Project a caller snapshot onto the fixed ``safe_report`` shape.

    Unknown keys are dropped rather than copied, so raw settings (which carry
    ``baseUrl`` and a token) cannot leak through the report. Known fields must
    hold their documented scalar type, and provenance accepts only a recorded
    source enum plus known budget field names, so no arbitrary string can
    reach the report.
    """
    if isinstance(source, DerivedBudget):
        source = source.safe_report()
    if not isinstance(source, Mapping):
        raise DshAcpSessionError(f"{label} must be a mapping or a DerivedBudget")
    projected: dict[str, Any] = {}
    for key in ("contextWindow", "maxOutputTokens"):
        if key in source:
            projected[key] = _project_scalar(key, source[key], "integer", label)
    for key, fields in (
        ("compaction", _COMPACTION_FIELDS),
        ("computed", _COMPUTED_FIELDS),
    ):
        if key not in source:
            continue
        nested = source[key]
        if not isinstance(nested, Mapping):
            raise DshAcpSessionError(f"{label}.{key} must be a mapping")
        projected[key] = _project_fields(nested, fields, f"{label}.{key}")
    if "provenance" in source:
        projected["provenance"] = _project_provenance(
            source["provenance"], f"{label}.provenance"
        )
    return projected


def _snapshot_differences(
    active: Any, desired: Any, prefix: str, out: dict[str, dict[str, Any]]
) -> None:
    """Flatten every differing leaf into ``path -> {active, desired}``."""
    if isinstance(active, Mapping) and isinstance(desired, Mapping):
        for key in sorted(set(active) | set(desired), key=str):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in active:
                out[path] = {
                    "active": None,
                    "desired": copy.deepcopy(desired[key]),
                }
            elif key not in desired:
                out[path] = {
                    "active": copy.deepcopy(active[key]),
                    "desired": None,
                }
            else:
                _snapshot_differences(active[key], desired[key], path, out)
        return
    if active != desired:
        out[prefix] = {
            "active": copy.deepcopy(active),
            "desired": copy.deepcopy(desired),
        }


def _compaction_state(
    active: Mapping[str, Any] | None, preflight_proven: bool
) -> str:
    """Only a proven runtime observation may ever report ``disabled``.

    An unproven snapshot describes desired configuration, not what the child
    actually launched with, so claiming ``disabled`` there would be a false
    observation; the honest answer is ``not-observable``.
    """
    if active is None or not preflight_proven:
        return "not-observable"
    compaction = active.get("compaction")
    if isinstance(compaction, Mapping) and compaction.get("enabled") is False:
        return "disabled"
    return "not-observable"


NotificationCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class TransportStartup:
    """Frozen view of the shared transport while its bootstrap lock is held.

    Yielded by :meth:`SharedDshRuntime.transport_startup`. ``transport`` is the
    host transport that existed when the lock was acquired; ``owns_bootstrap``
    is ``True`` only when no transport existed, meaning this caller is the one
    allowed to create and start the first ``DshAcpSession`` and adopt it. The
    view never changes mid-transaction, so the caller can branch once even
    after it adopts its own transport.
    """

    def __init__(self, transport: "DshAcpTransport | None") -> None:
        self._transport = transport

    @property
    def transport(self) -> "DshAcpTransport | None":
        return self._transport

    @property
    def owns_bootstrap(self) -> bool:
        return self._transport is None


class SharedDshRuntime:
    """Process owner for every ACP session in one Jupyter server."""

    def __init__(self, transport: DshAcpTransport | None = None) -> None:
        self._transport = transport
        self._start_lock = asyncio.Lock()
        # Dedicated outer bootstrap lock: serializes inspection of the shared
        # transport, the first child start, and adoption as one transaction.
        # It is deliberately separate from ``_start_lock`` so a started
        # transport's ``start`` handshake can never deadlock against it.
        self._bootstrap_lock = asyncio.Lock()
        self._started = False
        self._subscribers: dict[str, NotificationCallback] = {}
        self._active_prompts: set[str] = set()
        self._prompt_lock = asyncio.Lock()
        self._attachments: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._running_prompts: dict[str, asyncio.Task[Any]] = {}
        self._snapshots: dict[str, dict[str, Any]] = {}
        self._sessions: dict[str, Path] = {}
        self.initialize_count = 0
        self.session_new_count = 0
        self.session_resume_count = 0
        # The configuration snapshot is fixed when the shared process starts.
        # ``_generation`` is monotonic only within this Jupyter server runtime;
        # ``_runtime_lifetime`` bounds that identity so a report never claims
        # persistence across a Jupyter restart.
        self._runtime_lifetime = uuid.uuid4().hex
        self._candidate_snapshot: dict[str, Any] | None = None
        self._candidate_preflight_proven = False
        self._active_snapshot: dict[str, Any] | None = None
        self._active_preflight_proven = False
        self._generation = 0
        if transport is not None:
            transport._on_notification = self._route_notification

    @property
    def process_id(self) -> int | None:
        proc = getattr(self._transport, "_proc", None)
        pid = getattr(proc, "pid", None)
        return pid if isinstance(pid, int) else None

    def bind_transport(
        self,
        transport: DshAcpTransport,
        snapshot: Mapping[str, Any] | None = None,
        preflight_proven: bool = False,
    ) -> DshAcpTransport:
        """Keep the first safely prepared transport as the server runtime.

        ``snapshot`` is either a ``DerivedBudget`` or the fixed mapping from
        ``DerivedBudget.safe_report()``; it is projected onto that whitelist,
        so unknown keys and unexpected value types are excluded from every
        report. It only becomes the active configuration after :meth:`start`
        performs a successful handshake. ``preflight_proven`` records whether
        the runtime profile patch was verified; it is evidence, never an
        assumption. Later binds cannot replace the first transport's snapshot
        or provenance.
        """
        if self._transport is None:
            candidate = (
                None
                if snapshot is None
                else _project_snapshot(
                    snapshot, "runtime configuration snapshot"
                )
            )
            self._transport = transport
            if candidate is not None:
                self._candidate_snapshot = candidate
                self._candidate_preflight_proven = bool(preflight_proven)
        return self._transport

    def adopt_initialized_transport(
        self,
        transport: DshAcpTransport,
        snapshot: Mapping[str, Any] | None = None,
        preflight_proven: bool = False,
    ) -> DshAcpTransport:
        """Adopt a transport whose ACP ``initialize`` already succeeded.

        The caller (``DshAcpSession``) already started the child and completed
        the ``initialize`` handshake, so this never calls ``transport.start``
        and never sends ``initialize``. It only records the shared runtime as
        started and promotes the first transport's configuration snapshot to
        active, which is the one place ``generation`` advances here.

        The first transport stays authoritative. Repeating the call for the
        same transport is idempotent even when a snapshot is passed again, and
        a different transport is returned untouched instead of being replaced
        or closed. When :meth:`bind_transport` already recorded a candidate
        snapshot, that candidate is what becomes active; a later ``snapshot``
        argument cannot override the first authority. ``snapshot`` is projected
        and validated before any state changes, so a rejected snapshot leaves
        no half-bound transport.
        """
        if self._transport is None:
            candidate = (
                None
                if snapshot is None
                else _project_snapshot(
                    snapshot, "runtime configuration snapshot"
                )
            )
            self._transport = transport
            self._started = True
            self._candidate_snapshot = candidate
            self._candidate_preflight_proven = bool(preflight_proven)
            if candidate is not None:
                self._active_snapshot = _project_snapshot(
                    candidate, "active runtime configuration"
                )
                self._active_preflight_proven = (
                    self._candidate_preflight_proven
                )
                self._generation += 1
            return self._transport

        if self._transport is not transport:
            # Never replace or close a transport this runtime already owns.
            return self._transport

        # Same transport and already started: idempotent, nothing to promote.
        if self._started:
            return self._transport

        # ``bind_transport`` recorded this transport but the handshake did not
        # run through :meth:`start`; adopt the candidate it already holds.
        self._started = True
        if self._candidate_snapshot is not None and self._active_snapshot is None:
            self._active_snapshot = _project_snapshot(
                self._candidate_snapshot, "active runtime configuration"
            )
            self._active_preflight_proven = self._candidate_preflight_proven
            self._generation += 1
        return self._transport

    @asynccontextmanager
    async def transport_startup(self) -> AsyncIterator[TransportStartup]:
        """Serialize the outer transport bootstrap transaction for this host.

        The block runs while a dedicated bootstrap lock is held, covering the
        caller's whole span: inspecting whether a shared transport already
        exists, creating and starting the first ``DshAcpSession``, and adopting
        that transport into this runtime. Concurrent callers therefore cannot
        both spawn a child: the first caller bootstraps and adopts while every
        other waits, then sees the installed transport via
        :attr:`TransportStartup.transport` and takes the shared fast path. The
        fast path still acquires the lock before checking, so a race can never
        slip through between the check and the spawn.

        This method starts, closes, and restarts nothing itself; it only
        carries the caller's transaction. It uses its own lock rather than
        ``start``'s ``_start_lock``, so starting an already adopted transport
        cannot deadlock with it. The lock is released on normal exit, on
        exception, and on cancellation.
        """
        async with self._bootstrap_lock:
            yield TransportStartup(self._transport)

    async def start(self) -> None:
        """Start the child and perform ``initialize`` exactly once."""
        async with self._start_lock:
            if self._started:
                return
            if self._transport is None:
                raise DshAcpSessionError(
                    "shared runtime transport is not configured"
                )
            if not getattr(self._transport, "_started", False):
                await self._transport.start()
            result = await self._transport.request(
                "initialize",
                {
                    "protocolVersion": _PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                },
            )
            self.initialize_count += 1
            if not isinstance(result, dict) or result.get("protocolVersion") != (
                _PROTOCOL_VERSION
            ):
                raise DshAcpSessionError(
                    "shared runtime did not negotiate ACP protocol version "
                    f"{_PROTOCOL_VERSION}"
                )
            self._started = True
            if self._candidate_snapshot is not None:
                self._active_snapshot = _project_snapshot(
                    self._candidate_snapshot, "active runtime configuration"
                )
                self._active_preflight_proven = (
                    self._candidate_preflight_proven
                )
                self._generation += 1

    def configuration_report(
        self, desired: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """Return a read-only deep copy of the active/desired configuration.

        The active snapshot is whatever the first transport recorded at the
        last successful runtime start; ``desired`` is supplied by the caller
        (for example from ``DerivedBudget.safe_report()``) and never mutates
        it. Both are projected onto the fixed safe-report whitelist, so only
        known budget/compaction/computed/provenance fields appear. A differing
        desired snapshot is ``pending-next-runtime`` because this runtime
        never restarts or hot-patches itself. A started runtime without a
        recorded snapshot reports ``snapshot-unavailable``, never
        ``not-started``.
        """
        active = (
            None
            if self._active_snapshot is None
            else _project_snapshot(
                self._active_snapshot, "active runtime configuration"
            )
        )
        desired_snapshot = (
            None
            if desired is None
            else _project_snapshot(desired, "desired configuration")
        )
        differences: dict[str, dict[str, Any]] = {}
        if desired_snapshot is not None:
            _snapshot_differences(active, desired_snapshot, "", differences)
        if active is None:
            state = "not-started" if not self._started else "snapshot-unavailable"
        elif desired_snapshot is not None and differences:
            state = "pending-next-runtime"
        else:
            state = "active"
        return {
            "runtimeLifetime": self._runtime_lifetime,
            "generation": self._generation,
            "state": state,
            "active": active,
            "desired": desired_snapshot,
            "differences": differences,
            "compaction": _compaction_state(
                active,
                active is not None and self._active_preflight_proven,
            ),
            "preflightApplied": bool(
                self._active_snapshot is not None
                and self._active_preflight_proven
            ),
        }

    async def open_session(self, cwd: str | Path) -> str:
        """Create one ACP session without spawning another runtime."""
        await self.start()
        try:
            result = await self._transport.request(
                "session/new", build_acp_session_params(cwd)
            )
        except DshAcpError as exc:
            raise DshAcpSessionError(f"session/new failed: {exc}") from exc
        self.session_new_count += 1
        session_id = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not session_id.strip():
            raise DshAcpSessionError("session/new did not return a sessionId")
        self._sessions[session_id] = Path(cwd)
        return session_id

    async def resume_session(self, session_id: str, cwd: str | Path) -> None:
        """Resume one saved session on this same runtime."""
        await self.start()
        params = build_acp_session_params(cwd)
        params["sessionId"] = session_id
        try:
            await self._transport.request("session/resume", params)
        except DshAcpError as exc:
            raise DshAcpSessionError(
                f"failed to resume ACP session {session_id!r}: {exc}"
            ) from exc
        self.session_resume_count += 1
        self._sessions[session_id] = Path(cwd)

    async def recover(self, resume_failures: set[str] | None = None) -> dict[str, str]:
        """Restart the child once and resume each saved session independently.

        A session named in ``resume_failures`` reports its existing resume
        error and does not remove or replace sessions that resume.
        """
        failures = resume_failures or set()
        saved = dict(self._sessions)
        await self._transport.close()
        self._started = False
        # A restarted child is a new process. The preflight evidence gathered
        # for the previous child no longer describes it, so clearing it keeps
        # the next ``start`` from re-promoting stale proof and from reporting a
        # compaction setting this process was never verified to run with.
        self._candidate_preflight_proven = False
        self._active_preflight_proven = False
        await self.start()
        results: dict[str, str] = {}
        for session_id, cwd in saved.items():
            if session_id in failures:
                results[session_id] = "resume-unavailable"
                continue
            await self.resume_session(session_id, cwd)
            results[session_id] = "resumed"
        return results

    async def request(self, method: str, params: Any = None, timeout: float | None = None) -> Any:
        await self.start()
        return await self._transport.request(method, params, timeout=timeout)

    async def prompt(
        self,
        session_id: str,
        text: str,
        timeout: float | None = None,
    ) -> Any:
        """Run one prompt. Another prompt on the same session is rejected."""
        if not isinstance(session_id, str) or not session_id:
            raise DshAcpSessionError("session_id must be a non-empty string")
        async with self._prompt_lock:
            if session_id in self._active_prompts:
                raise DshAcpSessionError(
                    "another prompt is already active; concurrent prompts are rejected"
                )
            self._active_prompts.add(session_id)
        try:
            return await self.request(
                "session/prompt",
                {
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": text}],
                },
                timeout=timeout,
            )
        finally:
            async with self._prompt_lock:
                self._active_prompts.discard(session_id)

    async def cancel_session(self, session_id: str) -> None:
        """Cancel one session's prompt without stopping the shared runtime."""
        if not isinstance(session_id, str) or not session_id:
            raise DshAcpSessionError("session_id must be a non-empty string")
        await self.notify("session/cancel", {"sessionId": session_id})

    async def close_session(self, session_id: str) -> None:
        """Close one ACP session. The shared process stays running."""
        if not isinstance(session_id, str) or not session_id:
            raise DshAcpSessionError("session_id must be a non-empty string")
        await self.request("session/close", {"sessionId": session_id})
        self.unsubscribe(session_id)
        self._attachments.pop(session_id, None)

    async def shutdown_workspace(self, session_id: str) -> None:
        """Explicit workspace shutdown: cancel, then close only that session."""
        if self.prompt_running(session_id):
            await self.cancel_session(session_id)
        await self.close_session(session_id)

    async def notify(self, method: str, params: Any = None) -> None:
        await self.start()
        await self._transport.notify(method, params)

    def subscribe(self, session_id: str, callback: NotificationCallback) -> None:
        """Deliver only notifications whose ACP ``sessionId`` matches."""
        if not isinstance(session_id, str) or not session_id:
            raise DshAcpSessionError("session_id must be a non-empty string")
        if not callable(callback):
            raise DshAcpSessionError("notification callback must be callable")
        self._subscribers[session_id] = callback

    def unsubscribe(self, session_id: str) -> None:
        self._subscribers.pop(session_id, None)

    def remember_snapshot(self, session_id: str, snapshot: dict[str, Any]) -> None:
        """Keep the latest detached progress for the same session id."""
        self._snapshots[session_id] = dict(snapshot)

    def reattach(
        self, session_id: str, sink: Callable[[dict[str, Any]], None]
    ) -> dict[str, Any]:
        """Attach and return the saved snapshot before live events resume."""
        self.attach(session_id, sink)
        snapshot = dict(self._snapshots.get(session_id, {}))
        snapshot["sessionId"] = session_id
        return snapshot

    def attach(self, session_id: str, sink: Callable[[dict[str, Any]], None]) -> None:
        """Attach one browser sink. A second live sink is rejected."""
        if session_id in self._attachments:
            raise DshAcpSessionError(
                "another browser is already attached to this session"
            )
        if not callable(sink):
            raise DshAcpSessionError("attachment sink must be callable")
        self._attachments[session_id] = sink

    def detach(self, session_id: str) -> None:
        """Remove the browser sink. Do not cancel or close the session."""
        self._attachments.pop(session_id, None)

    def attached(self, session_id: str) -> bool:
        return session_id in self._attachments

    def start_prompt(self, session_id: str, text: str) -> asyncio.Task[Any]:
        """Track a prompt so browser detach cannot cancel it."""
        if session_id in self._running_prompts:
            raise DshAcpSessionError(
                "another prompt is already active; concurrent prompts are rejected"
            )
        task = asyncio.create_task(self.prompt(session_id, text))
        self._running_prompts[session_id] = task

        def _clear(done: asyncio.Task[Any]) -> None:
            if self._running_prompts.get(session_id) is done:
                self._running_prompts.pop(session_id, None)

        task.add_done_callback(_clear)
        return task

    def prompt_running(self, session_id: str) -> bool:
        task = self._running_prompts.get(session_id)
        return task is not None and not task.done()

    async def _route_notification(self, message: dict[str, Any]) -> None:
        params = message.get("params") if isinstance(message, dict) else None
        session_id = params.get("sessionId") if isinstance(params, dict) else None
        if not isinstance(session_id, str):
            return
        callback = self._subscribers.get(session_id)
        if callback is None:
            return
        outcome = callback(message)
        if asyncio.iscoroutine(outcome):
            await outcome

    async def close(self) -> None:
        """Stop the shared child. Individual session close uses ACP instead."""
        await self._transport.close()
        self._started = False
