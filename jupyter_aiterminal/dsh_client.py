"""Async DeepSeek Harness client for the Jupyter AI Terminal host.

This is the only module that imports the published ``deepseek_harness`` SDK. The
SDK is synchronous: its runtime subprocess is driven over stdio and reader
threads, and ``Session.run`` blocks until a turn ends. This wrapper keeps the
Tornado/asyncio loop responsive by running every SDK call in a worker thread
(``asyncio.to_thread``), and forwards notifications back onto the loop thread
with ``loop.call_soon_threadsafe`` so the host's ``emit`` callback is always
invoked on the loop thread and in notification order.

Design constraints enforced here:

* One owned session, explicitly created or resumed by id. A missing resume
  target fails the start; this module never calls the SDK's ``continue recent``
  path. The durable ``session_id`` is recorded on the client and survives a
  runtime process restart (a process is *not* a session).
* The runtime is pinned to the ``sdk-minimal`` bundle plus the static
  ``dsh_profile.yml`` overlay and the private provider patch built by
  :mod:`jupyter_aiterminal.dsh_config`. The patch is written to a private
  temporary directory (0700 dir / 0600 file) and never contains the token.
* ``runtime_cwd`` equals the caller's ``cwd`` so the permission boundary and
  the workspace root agree. ``DSH_HOME``/``HOME`` are pinned to the explicit
  controlled home, which must be a dedicated, absolute, non-symlinked directory
  owned by the current user and carry this module's ownership marker. The child
  environment is built from ``os.environ.copy()`` with a small non-secret
  allowlist preserved and every other inherited value blanked; see
  :meth:`DshClient._child_env` for why this is a value scrub, not a strict
  replacement. The host process environment is never mutated.
* ``close`` releases the runtime but leaves the session files in the controlled
  home. It is not an interrupt: there is no cancel/approval capability in the
  pinned runtime, so no such capability is advertised. It is still cleanup that
  must always be able to run: it invalidates the client first, tears the
  transport down even while a run is active, and waits a bounded time for the
  un-interruptible worker threads to return.
* One run at a time. A concurrent run is rejected, and a cancelled run keeps the
  client busy until the SDK call really returns. Notification callbacks capture
  their own run identity, so a late event can never be projected onto a newer
  run.

``start`` emits ``connection``, ``session`` and ``capabilities`` product events
matching ``protocol.ts`` exactly: ``connection.phase``, ``session.phase`` and a
``capabilities`` manifest of ``{status, reason?}`` entries keyed by the
protocol's capability names. Only ``text_stream`` and ``session_resume`` are
marked ``available``; tool use and every other runtime feature stay
``unverified`` until release evidence exists.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import tempfile
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .dsh_config import (
    DSH_API_KEY_ENV,
    DSH_PROVIDER_ID,
    DSH_STATIC_PROFILE_PATH,
    DshProviderConfig,
    build_profile_patches,
)
from .dsh_events import DshEventProjector

# Pinned runtime selection. These are constants, never user input: the host may
# not choose a profile, home or patch path.
DSH_PROFILE = "sdk-minimal"
DSH_EVENT_NAMESPACE = "dsh"
DSH_EVENT_VERSION = 1
_DSH_EVENT_PREFIX = f"{DSH_EVENT_NAMESPACE}/v{DSH_EVENT_VERSION}/"

# Non-secret variables the runtime needs to execute its bundled binary and
# resolve locale/temp paths. Everything else inherited from ``os.environ`` is
# blanked in the child override, never deleted from the host process.
_ENV_PASSTHROUGH = frozenset(
    {
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_CTYPE",
        "LC_MESSAGES",
        "TZ",
        "TERM",
        "SHELL",
    }
)

# Provider/cloud credentials that are always pinned to an empty value, even when
# the host does not currently export them. Combined with the inherited-name
# scrub below this keeps known secret names explicit rather than incidental.
_ALWAYS_BLANKED_ENV = (
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)

# The SDK copies ``os.environ`` and then merges ``HarnessConfig.env``. These
# overrides pin the private home and neutralize inherited credentials/proxies.
_PROXY_ENV_VARS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)

# The controlled home carries a fixed-schema ownership marker. A home without
# it is either brand new (and empty) or not ours; the latter is rejected rather
# than adopted or cleaned.
_HOME_MARKER_NAME = ".jupyter-aiterminal-home.json"
_HOME_MARKER_SCHEMA = "jupyter-aiterminal-dsh-home"
_HOME_MARKER_VERSION = 1
# The marker is written to a temp file and hard-linked into place, so a reader
# never observes a half-written marker. A concurrent initializer can still see
# the temp file, so home validation ignores exactly this reserved prefix.
_HOME_MARKER_TEMP_PREFIX = _HOME_MARKER_NAME + ".tmp-"
# Bounded wait for a marker that another initializer is publishing right now.
_HOME_MARKER_PARSE_RETRIES = 50
_HOME_MARKER_PARSE_DELAY = 0.01
# Entries a controlled home may hold. ``sessions`` is the legal SDK session
# store; the rest are runtime scratch directories. Anything else is rejected at
# startup instead of being scanned or deleted.
_HOME_ALLOWED_ENTRIES = frozenset(
    {_HOME_MARKER_NAME, "sessions", "logs", "cache", "state"}
)
# DSH auto-loads these from ``DSH_HOME``. They are named explicitly so a valid
# marker can never be used to smuggle in a home patch, a custom profile or an
# extension bundle.
_HOME_FORBIDDEN_ENTRIES = (
    "cordis.patch.yml",
    "profiles",
    "extensions",
    "plugins",
    "patch",
)

# How long ``close`` waits for a cancelled-but-still-running worker thread to
# return. ``to_thread`` cannot interrupt the SDK call, so this bound only limits
# the wait; the runtime transport is already torn down when the wait starts.
_CLOSE_WAIT_SECONDS = 3.0


class DshClientError(RuntimeError):
    """Raised for configuration, SDK, and lifecycle failures."""


@dataclass(frozen=True)
class DshRunResult:
    """The terminal result of one run, scoped to the durable session."""

    session_id: str
    run_id: str
    final_response: str
    finish_reason: str | None
    events: list[dict[str, Any]] = field(default_factory=list)


def _import_sdk() -> tuple[type[Any], type[Any]]:
    """Import the published SDK lazily so the module imports without it.

    Returns ``(DeepSeekHarnessConfig, DeepSeekHarness)``. Tests inject a fake
    pair by monkeypatching this function; the production dependency is only
    required when :meth:`DshClient.start` actually runs.
    """
    try:
        from deepseek_harness.api import DeepSeekHarness, DeepSeekHarnessConfig
    except ImportError as exc:  # pragma: no cover - depends on the deployment
        raise DshClientError(
            "The DeepSeek Harness Python SDK is not installed; install "
            "deepseek-harness-sdk to enable the DSH runtime."
        ) from exc
    return DeepSeekHarnessConfig, DeepSeekHarness


def _non_empty_text(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _assert_no_symlink(path: Path) -> None:
    """Reject a home whose own path or any parent component is a symlink.

    ``Path.resolve`` would silently follow the link, so the raw spelling is
    checked first: a link could redirect the whole controlled home elsewhere.
    """
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise DshClientError(
                "controlled home must not traverse a symbolic link: "
                f"{candidate} (from {path})"
            )


def _assert_owned_directory(path: Path) -> None:
    st = path.stat()
    if not stat.S_ISDIR(st.st_mode):
        raise DshClientError(f"controlled home is not a directory: {path}")
    geteuid = getattr(os, "geteuid", None)
    if geteuid is not None and st.st_uid != geteuid():
        raise DshClientError(
            f"controlled home is not owned by the current user: {path}"
        )


def _is_transient_marker_entry(name: str) -> bool:
    """True for this module's own in-flight marker temp file.

    The prefix is reserved and only ever created with ``O_EXCL`` 0600 by
    :func:`_create_home_marker`, so a matching entry is our own unpublished
    marker, never foreign content and never auto-loaded by DSH.
    """
    return name.startswith(_HOME_MARKER_TEMP_PREFIX)


def _read_home_marker(marker: Path, *, retries: int = 0) -> dict[str, Any]:
    for attempt in range(retries + 1):
        try:
            text = marker.read_text(encoding="utf-8")
        except OSError as exc:
            if attempt < retries:
                time.sleep(_HOME_MARKER_PARSE_DELAY)
                continue
            raise DshClientError(
                f"controlled home marker is unreadable: {marker}"
            ) from exc
        try:
            payload = json.loads(text)
        except ValueError as exc:
            # A partial marker is only possible while a concurrent initializer
            # is publishing it; retry only inside that bounded window, then
            # fail closed even for non-empty corrupt data.
            if attempt < retries:
                time.sleep(_HOME_MARKER_PARSE_DELAY)
                continue
            raise DshClientError(
                f"controlled home marker is unreadable: {marker}"
            ) from exc
        if (
            not isinstance(payload, dict)
            or payload.get("schema") != _HOME_MARKER_SCHEMA
            or payload.get("version") != _HOME_MARKER_VERSION
            or not isinstance(payload.get("ownerId"), str)
            or not payload["ownerId"]
        ):
            raise DshClientError(
                f"controlled home marker has an invalid schema: {marker}"
            )
        return payload
    raise DshClientError(f"controlled home marker is unreadable: {marker}")


def _create_home_marker(home: Path) -> None:
    marker = home / _HOME_MARKER_NAME
    payload = json.dumps(
        {
            "schema": _HOME_MARKER_SCHEMA,
            "version": _HOME_MARKER_VERSION,
            "ownerId": uuid.uuid4().hex,
        },
        indent=2,
        sort_keys=True,
    )
    temp = home / f"{_HOME_MARKER_TEMP_PREFIX}{uuid.uuid4().hex}"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, payload.encode("utf-8"))
        os.fsync(fd)
    except BaseException:
        # Only ever remove the temp file this call just created.
        temp.unlink(missing_ok=True)
        raise
    finally:
        os.close(fd)
    try:
        # Hard-linking is atomic and refuses to replace an existing marker, so
        # the marker only becomes visible once fully written.
        os.link(temp, marker)
    except FileExistsError:
        # Another client won the creation race; accept only its valid marker.
        _read_home_marker(marker, retries=_HOME_MARKER_PARSE_RETRIES)
    finally:
        temp.unlink(missing_ok=True)


def _prepare_home_dir(home: Path) -> Path:
    """Validate and initialize the controlled DSH home.

    A new or empty directory is adopted by atomically creating the ownership
    marker (``O_EXCL``). An existing non-empty home without that marker is not
    ours and is rejected; it is never chmod-ed, scanned recursively or cleaned.
    """
    if home.exists():
        _assert_owned_directory(home)
    else:
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(home, 0o700)
    marker = home / _HOME_MARKER_NAME
    if marker.is_file():
        _read_home_marker(marker)
    elif marker.exists() or marker.is_symlink():
        raise DshClientError(
            f"controlled home marker is not a regular file: {marker}"
        )
    elif any(
        entry != _HOME_MARKER_NAME and not _is_transient_marker_entry(entry)
        for entry in os.listdir(home)
    ):
        raise DshClientError(
            "controlled home is not empty and has no "
            f"{_HOME_MARKER_SCHEMA} marker; refusing to adopt it: {home}"
        )
    else:
        _create_home_marker(home)
    for name in _HOME_FORBIDDEN_ENTRIES:
        candidate = home / name
        if candidate.exists() or candidate.is_symlink():
            raise DshClientError(
                "controlled DSH home must not contain auto-loaded "
                f"configuration: {candidate}"
            )
    unexpected = sorted(
        entry
        for entry in os.listdir(home)
        if entry not in _HOME_ALLOWED_ENTRIES
        and not _is_transient_marker_entry(entry)
    )
    if unexpected:
        raise DshClientError(
            "controlled DSH home contains entries outside the allowlist "
            f"{sorted(_HOME_ALLOWED_ENTRIES)}: {unexpected}"
        )
    return home


class DshClient:
    """One durable DSH session backed by an owned, replaceable runtime process."""

    def __init__(
        self,
        *,
        config: DshProviderConfig,
        cwd: str | Path,
        home: str | Path,
        emit: Callable[[dict[str, Any]], None],
        resume_session_id: str | None = None,
        dsh_bin: str | Path | None = None,
    ) -> None:
        if not isinstance(config, DshProviderConfig):
            raise DshClientError("config must be a DshProviderConfig instance")
        if not callable(emit):
            raise DshClientError("emit must be callable")
        cwd_path = Path(cwd).expanduser()
        if not cwd_path.is_absolute():
            cwd_path = cwd_path.resolve()
        if not cwd_path.is_dir():
            raise DshClientError(f"cwd must be an existing directory: {cwd_path}")
        home_text = _non_empty_text(str(home))
        if home_text is None:
            raise DshClientError("home must be a non-empty directory path")
        home_path = Path(home_text).expanduser()
        if not home_path.is_absolute():
            raise DshClientError(f"home must be an absolute path: {home_path}")
        _assert_no_symlink(home_path)
        home_path = home_path.resolve()
        try:
            user_home: Path | None = Path.home().resolve()
        except (RuntimeError, OSError):  # pragma: no cover - no home passwd entry
            user_home = None
        if user_home is not None and home_path == user_home:
            raise DshClientError(
                "home must be a dedicated directory, not the user's HOME"
            )
        if resume_session_id is not None and _non_empty_text(resume_session_id) is None:
            raise DshClientError(
                "resume_session_id must be a non-empty string when provided"
            )

        self._config = config
        self._cwd = cwd_path
        self._home = home_path
        self._emit_callback = emit
        self._dsh_bin = None if dsh_bin is None else str(dsh_bin)
        self._resume = resume_session_id is not None
        self._session_id = (
            resume_session_id
            if resume_session_id is not None
            else f"session-{uuid.uuid4().hex}"
        )

        self._loop: asyncio.AbstractEventLoop | None = None
        self._generation = 0
        self._runtime_id: str | None = None
        self._started = False
        self._starting = False
        self._closed = False
        self._active_run_id: str | None = None
        self._active_projector: DshEventProjector | None = None
        self._run_lock = asyncio.Lock()
        # Futures resolved only when the worker thread really returns. Awaiting
        # a cancelled ``to_thread`` returns while the thread keeps running, so
        # these track the true end of the SDK call and keep the client busy.
        self._run_worker: asyncio.Future[Any] | None = None
        self._start_worker_task: asyncio.Future[Any] | None = None
        self._harness: Any = None
        self._session: Any = None
        self._patch_dir: Path | None = None
        self._patch_path: Path | None = None

    @property
    def session_id(self) -> str:
        """The durable session id; this identity outlives any runtime process."""
        return self._session_id

    @property
    def runtime_id(self) -> str | None:
        """The current connection generation, or ``None`` before start."""
        return self._runtime_id

    @property
    def cwd(self) -> Path:
        return self._cwd

    @property
    def home(self) -> Path:
        return self._home

    async def start(self) -> None:
        if self._closed:
            raise DshClientError("cannot start a closed DSH client")
        if self._started:
            return
        if self._starting:
            raise DshClientError(
                "DSH client is already starting; concurrent starts are rejected"
            )
        self._loop = asyncio.get_running_loop()
        self._generation += 1
        generation = self._generation
        self._starting = True
        worker = self._spawn_worker(self._start_sync)
        self._start_worker_task = worker
        try:
            await asyncio.shield(worker)
        except asyncio.CancelledError:
            # The worker thread keeps running; if it hands back a live harness
            # nobody owns it anymore, so reclaim it when it finishes.
            self._starting = False
            self._reclaim_late_start(worker, generation)
            raise
        except DshClientError:
            self._starting = False
            self._start_worker_task = None
            self._discard_patch_dir()
            raise
        except Exception as exc:
            self._starting = False
            self._start_worker_task = None
            self._discard_patch_dir()
            raise DshClientError(f"failed to start the DSH runtime: {exc}") from exc
        self._starting = False
        self._start_worker_task = None
        if self._closed or generation != self._generation:
            # A close landed while the runtime was starting; release it now.
            await self._close_runtime()
            self._discard_patch_dir()
            raise DshClientError("DSH client was closed while starting")
        self._started = True
        self._emit_event(
            {
                "type": f"{_DSH_EVENT_PREFIX}connection",
                "runtimeId": self._runtime_id,
                "phase": "connected",
            }
        )
        self._emit_event(
            {
                "type": f"{_DSH_EVENT_PREFIX}session",
                "sessionId": self._session_id,
                "runtimeId": self._runtime_id,
                "phase": "resumed" if self._resume else "attached",
            }
        )
        self._emit_event(
            {
                "type": f"{_DSH_EVENT_PREFIX}capabilities",
                "runtimeId": self._runtime_id,
                "capabilities": self._capabilities(),
            }
        )

    async def run(self, text: str) -> DshRunResult:
        if self._closed:
            raise DshClientError("cannot run on a closed DSH client")
        if not self._started:
            raise DshClientError("DSH client is not started; call start() first")
        prompt = _non_empty_text(text)
        if prompt is None:
            raise DshClientError("run input must be a non-empty string")
        if self._run_lock.locked() or self._run_worker is not None:
            raise DshClientError(
                "another DSH run is already active; concurrent runs are rejected"
            )
        async with self._run_lock:
            if self._closed:
                raise DshClientError("DSH client was closed before the run started")
            run_id = f"run-{uuid.uuid4().hex}"
            projector = DshEventProjector(
                session_id=self._session_id,
                runtime_id=self._runtime_id or "",
                run_id=run_id,
            )
            self._active_run_id = run_id
            self._active_projector = projector
            worker = self._spawn_worker(
                lambda: self._run_sync(prompt, run_id, projector)
            )
            self._run_worker = worker
            try:
                result = await asyncio.shield(worker)
            except asyncio.CancelledError:
                # ``to_thread`` cannot stop the SDK call, so the client stays
                # busy until the worker thread actually returns. The active run
                # identity is cleared here, which drops any late notification by
                # identity instead of letting it reach a newer run.
                self._reclaim_late_run(worker)
                await self._flush_notifications()
                self._active_run_id = None
                self._active_projector = None
                raise
            except BaseException:
                if self._run_worker is worker:
                    self._run_worker = None
                await self._flush_notifications()
                self._active_run_id = None
                self._active_projector = None
                raise
            if self._run_worker is worker:
                self._run_worker = None
            # The worker returns after the SDK has stopped delivering; this
            # barrier guarantees every notification it scheduled is projected
            # and emitted before the run is reported finished.
            await self._flush_notifications()
            self._active_run_id = None
            self._active_projector = None
            if self._closed:
                raise DshClientError("DSH client was closed during the run")
            return DshRunResult(
                session_id=self._session_id,
                run_id=run_id,
                final_response=str(getattr(result, "final_response", "") or ""),
                finish_reason=getattr(result, "finish_reason", None),
                events=list(getattr(result, "events", []) or []),
            )

    async def close(self) -> None:
        """Release the runtime, keeping the durable session files in ``home``.

        This is cleanup, not an interrupt: there is no cancel capability to
        advertise. It invalidates the client first (so no late notification can
        be projected onto a dead run), tears down the runtime transport even
        while a run is active, then waits a bounded time for the worker threads
        that ``to_thread`` cannot interrupt.
        """
        if self._closed:
            return
        self._closed = True
        self._started = False
        self._generation += 1
        self._active_run_id = None
        self._active_projector = None
        # A start worker may still be creating the harness; let it finish (or
        # give up after the bound) so a late harness is reclaimed, not leaked.
        await self._wait_start_worker_exit()
        await self._close_runtime()
        await self._wait_run_worker_exit()
        self._discard_patch_dir()

    async def _wait_start_worker_exit(self) -> None:
        worker = self._start_worker_task
        if worker is None or worker.done():
            return
        try:
            await asyncio.wait_for(asyncio.shield(worker), _CLOSE_WAIT_SECONDS)
        except Exception:
            return

    async def _wait_run_worker_exit(self) -> None:
        worker = self._run_worker
        if worker is None or worker.done():
            self._run_worker = None
            return
        try:
            await asyncio.wait_for(asyncio.shield(worker), _CLOSE_WAIT_SECONDS)
        except Exception:
            return
        if self._run_worker is worker:
            self._run_worker = None

    def _spawn_worker(self, fn: Callable[[], Any]) -> asyncio.Future[Any]:
        """Run ``fn`` in a worker thread behind a non-cancellable future.

        ``run_in_executor``'s future is cancelled when its awaiter is cancelled
        even though the thread keeps running. This wrapper future is resolved
        only by the thread finishing, so the caller can stay busy for the real
        duration of the SDK call.
        """
        loop = asyncio.get_running_loop()
        result: asyncio.Future[Any] = loop.create_future()
        executor_future = loop.run_in_executor(None, fn)

        def _transfer(exec_fut: asyncio.Future[Any]) -> None:
            if result.done():
                return
            if exec_fut.cancelled():
                result.cancel()
            elif exec_fut.exception() is not None:
                result.set_exception(exec_fut.exception())
            else:
                result.set_result(exec_fut.result())

        def _retrieve(fut: asyncio.Future[Any]) -> None:
            # Mark the outcome retrieved so an abandoned worker cannot emit an
            # "exception was never retrieved" warning.
            if not fut.cancelled():
                fut.exception()

        executor_future.add_done_callback(_transfer)
        result.add_done_callback(_retrieve)
        return result

    def _reclaim_late_run(self, worker: asyncio.Future[Any]) -> None:
        """Keep the client busy until a cancelled run's thread really ends."""

        def _done(fut: asyncio.Future[Any]) -> None:
            if self._run_worker is fut:
                self._run_worker = None

        worker.add_done_callback(_done)

    def _reclaim_late_start(
        self, worker: asyncio.Future[Any], generation: int
    ) -> None:
        """Reclaim a harness created by a start() whose awaiter was cancelled."""

        def _done(fut: asyncio.Future[Any]) -> None:
            if self._start_worker_task is fut:
                self._start_worker_task = None
            if self._started and generation == self._generation:
                return
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._reclaim_runtime(generation))
            )

        worker.add_done_callback(_done)

    async def _reclaim_runtime(self, generation: int) -> None:
        if self._started and generation == self._generation:
            # A later start owns the live runtime; nothing to reclaim.
            return
        await self._close_runtime()
        self._discard_patch_dir()

    # ------------------------------------------------------------------ sync

    def _start_sync(self) -> None:
        config_cls, harness_cls = _import_sdk()
        _prepare_home_dir(self._home)
        self._write_patch()
        self._runtime_id = f"runtime-{uuid.uuid4().hex}"
        kwargs: dict[str, Any] = {
            "provider": DSH_PROVIDER_ID,
            "model": self._config.model,
            "cwd": str(self._cwd),
            "runtime_cwd": str(self._cwd),
            "profile": DSH_PROFILE,
            "patches": (str(DSH_STATIC_PROFILE_PATH), str(self._patch_path)),
            "dsh_home": str(self._home),
            "env": self._child_env(),
        }
        if self._dsh_bin is not None:
            kwargs["dsh_bin"] = self._dsh_bin
        harness = harness_cls(config=config_cls(**kwargs))
        try:
            harness.start()
            if self._resume:
                session = harness.resume_session(self._session_id)
            else:
                session = harness.start_session(self._session_id)
        except Exception as exc:
            try:
                harness.close()
            except Exception:
                pass
            mode = "resume" if self._resume else "create"
            raise DshClientError(
                f"failed to {mode} DSH session {self._session_id!r}: {exc}"
            ) from exc
        self._harness = harness
        self._session = session

    def _run_sync(
        self,
        prompt: str,
        run_id: str,
        projector: DshEventProjector,
    ) -> Any:
        session = self._session
        if session is None:
            raise DshClientError("DSH session is not available")

        def on_notification(notification: Any) -> None:
            # Bind this run's identity now: the callback runs on the SDK reader
            # thread and must never resolve the run that happens to be current
            # when the loop finally delivers it.
            self._schedule_notification(notification, run_id, projector)

        try:
            return session.run(prompt, on_notification=on_notification)
        except DshClientError:
            raise
        except BaseException as exc:
            raise DshClientError(f"DSH run failed: {exc}") from exc

    async def _close_runtime(self) -> None:
        harness = self._harness
        self._harness = None
        self._session = None
        self._active_run_id = None
        self._active_projector = None
        if harness is None:
            return
        try:
            await asyncio.to_thread(harness.close)
        except Exception:
            # Close is best-effort cleanup; the runtime is already being
            # abandoned and the durable session files stay on disk.
            pass

    def _child_env(self) -> dict[str, str]:
        """The environment overrides the runtime subprocess receives.

        The real SDK starts from ``os.environ.copy()`` and then updates it with
        ``HarnessConfig.env``. This mapping therefore enumerates every variable
        currently inherited from the host: non-allowlisted names get ``""`` and
        only :data:`_ENV_PASSTHROUGH` keeps its host value. ``HOME``,
        ``DSH_HOME`` and the provider token are then pinned explicitly.

        This is a value scrub, not a strict environment replacement: the SDK's
        merge means a blanked name is still *present* in the child as an empty
        string, so a launcher that checks presence rather than value can still
        observe it. Names introduced into ``os.environ`` after this snapshot
        (and before the SDK's copy) are not covered. The host process
        ``os.environ`` is read-only here; nothing is mutated, so concurrent
        clients cannot race on a shared mapping.
        """
        inherited = os.environ.copy()
        env: dict[str, str] = {}
        for name, value in inherited.items():
            env[name] = value if name.upper() in _ENV_PASSTHROUGH else ""
        env["HOME"] = str(self._home)
        env["DSH_HOME"] = str(self._home)
        env[DSH_API_KEY_ENV] = self._config.token
        for name in _ALWAYS_BLANKED_ENV:
            env[name] = ""
        for name in _PROXY_ENV_VARS:
            env[name] = ""
        return env

    def _write_patch(self) -> None:
        patch_dir = Path(tempfile.mkdtemp(prefix="jupyter-aiterminal-dsh-"))
        # Record the directory before anything can fail, so a mid-way error is
        # still cleaned up by ``_discard_patch_dir`` (and by the ``finally``).
        self._patch_dir = patch_dir
        patch_path = patch_dir / "provider-patch.json"
        self._patch_path = patch_path
        try:
            os.chmod(patch_dir, 0o700)
            text = json.dumps(
                build_profile_patches(self._config),
                ensure_ascii=True,
                indent=2,
                sort_keys=True,
            )
            if self._config.token in text:  # defensive: builder never emits it
                raise DshClientError("provider patch must not contain the API token")
            patch_path.write_text(text, encoding="utf-8")
            os.chmod(patch_path, 0o600)
        except BaseException:
            self._discard_patch_dir()
            raise

    def _discard_patch_dir(self) -> None:
        patch_dir = self._patch_dir
        self._patch_dir = None
        self._patch_path = None
        if patch_dir is not None:
            shutil.rmtree(patch_dir, ignore_errors=True)

    # --------------------------------------------------------------- events

    def _capabilities(self) -> dict[str, dict[str, str]]:
        # Shape and names mirror ``DshCapabilityManifest`` in protocol.ts.
        return {
            # Verified against the released SDK surface exercised by the smoke.
            "text_stream": {"status": "available"},
            "session_resume": {"status": "available"},
            # Tools run under the pinned profile, but the projector's published
            # field contract is unproven, so do not claim availability.
            "tool_events": {
                "status": "unverified",
                "reason": "projector field contract not verified",
            },
            "artifacts": {
                "status": "unverified",
                "reason": "not exercised on the pinned runtime",
            },
            "questions": {
                "status": "unverified",
                "reason": "not exercised on the pinned runtime",
            },
            "jobs": {
                "status": "unverified",
                "reason": "not exercised on the pinned runtime",
            },
            "subagents": {
                "status": "unverified",
                "reason": "not exercised on the pinned runtime",
            },
            # The pinned runtime exposes no approval/cancel channel.
            "approval": {
                "status": "unavailable",
                "reason": "pinned runtime has no approval channel",
            },
            "cancel": {
                "status": "unavailable",
                "reason": "pinned runtime has no cancel channel",
            },
        }

    def _schedule_notification(
        self,
        notification: Any,
        run_id: str,
        projector: DshEventProjector,
    ) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(
                self._deliver_notification, notification, run_id, projector
            )
        except RuntimeError:
            # The loop is already closed; the run is over and the event is dead.
            return

    def _deliver_notification(
        self,
        notification: Any,
        run_id: str,
        projector: DshEventProjector,
    ) -> None:
        # Deliver only to the run that produced the notification. A late event
        # from an earlier run is dropped, never re-scoped onto the current run.
        if (
            self._closed
            or run_id != self._active_run_id
            or projector is not self._active_projector
        ):
            return
        try:
            events = projector.project(notification)
        except Exception:
            return
        for event in events:
            self._emit_event(event)

    def _emit_event(self, event: dict[str, Any]) -> None:
        try:
            self._emit_callback(event)
        except Exception:
            # A host callback failure must not corrupt run cleanup/ordering.
            return

    async def _flush_notifications(self) -> None:
        loop = asyncio.get_running_loop()
        barrier = loop.create_future()

        def _release() -> None:
            if not barrier.done():
                barrier.set_result(None)

        loop.call_soon_threadsafe(_release)
        await barrier
