"""Asynchronous ACP v1 JSON-RPC transport over a DSH runtime's stdio.

This module owns exactly one concern: moving JSON-RPC frames to and from a
DeepSeek Harness runtime process. It does not compose provider/profile patches,
project events into product events, or manage ACP sessions. Those layers sit
above it and drive it through :meth:`DshAcpTransport.request`,
:meth:`DshAcpTransport.notify`, and :meth:`DshAcpTransport.response`.

Protocol shape implemented here:

* One JSON object per LF-terminated UTF-8 line on stdin/stdout.
* Client requests get monotonically increasing integer ids and are correlated
  with exactly one pending future. Responses with unknown ids are ignored; an
  error response wakes the matching request by raising :class:`DshAcpError`.
* stdout and stderr are read concurrently. stdout responses resolve futures
  directly, so they never wait behind notification or server-request handlers.
* Server-initiated requests (``method`` plus ``id``) are dispatched as their own
  asyncio task. A permission/approval handler may wait for the user without
  blocking the stdout reader; it either returns a result payload or calls
  :meth:`DshAcpTransport.response` itself and returns ``None``. If no handler is
  installed the server request gets a JSON-RPC method-not-found error instead of
  leaving the runtime waiting forever.
* Notifications are delivered by one ordered queue consumer, so notification
  callbacks observe runtime order without blocking the reader.
* Malformed stdout JSON, malformed responses, and process exit fail all pending
  requests with :class:`DshAcpError`; a caller can never wait forever on a
  transport that is gone or no longer speaking the protocol.

The child argv is controlled: ``<runtime> --profile acp --patch <absolute
patch>``. No token or free-form argument is ever placed in argv. ``env`` is
used as the *complete* child environment (this module does not copy
``os.environ``); callers are explicitly responsible for supplying everything the
runtime needs, including ``PATH``/``HOME``/``DSH_HOME``.

Closing the transport is not an ACP session cancel. It cancels local pending
requests, shuts stdin, then terminates and if necessary kills the runtime
process with bounded waits. It is idempotent and safe to call while a prompt is
in flight.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any

__all__ = [
    "ACP_PROFILE",
    "DshAcpError",
    "DshAcpTransport",
    "resolve_runtime_path",
]

ACP_PROFILE = "acp"
_STDIO_LIMIT = 8 * 1024 * 1024
_SECRET_KEY_MARKERS = ("TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")
_SECRET_VALUE_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b")
_UNSET = object()
_QUEUE_STOP = object()

NotificationHandler = Callable[[dict[str, Any]], Awaitable[None] | None]
ServerRequestHandler = Callable[
    [dict[str, Any]], Awaitable[Any] | Any
]


class DshAcpError(RuntimeError):
    """The single error type raised by this transport.

    ``code``/``data`` carry a JSON-RPC error object verbatim when the failure
    came from the runtime; they stay ``None`` for local transport failures such
    as timeouts, invalid JSON, or process exit.
    """

    def __init__(
        self, message: str, *, code: int | None = None, data: Any = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


def resolve_runtime_path() -> Path:
    """Resolve the packaged DSH runtime executable via its public Python API.

    The import is lazy so this module (and its unit tests) work without the
    runtime package installed. Missing package or a missing platform executable
    is reported as :class:`DshAcpError` with the underlying reason preserved.
    """
    try:
        import deepseek_harness_runtime
    except ImportError as exc:  # pragma: no cover - deployment dependent
        raise DshAcpError(
            "deepseek_harness_runtime is not installed; install the "
            "deepseek-harness-runtime-bin wheel to use the DSH ACP transport."
        ) from exc
    try:
        return Path(deepseek_harness_runtime.bundled_runtime_path())
    except Exception as exc:  # pragma: no cover - deployment dependent
        raise DshAcpError(
            f"cannot resolve the packaged DSH runtime executable: {exc}"
        ) from exc


class DshAcpTransport:
    """One ACP v1 JSON-RPC connection to one runtime subprocess."""

    def __init__(
        self,
        *,
        runtime_path: str | Path | None = None,
        patch_path: str | Path,
        cwd: str | Path,
        env: Mapping[str, str],
        profile: str = ACP_PROFILE,
        on_notification: NotificationHandler | None = None,
        on_server_request: ServerRequestHandler | None = None,
        default_request_timeout: float = 30.0,
        startup_timeout: float = 10.0,
        close_timeout: float = 5.0,
        stderr_limit: int = 200,
    ) -> None:
        if profile != ACP_PROFILE:
            raise DshAcpError(
                f"unsupported ACP profile {profile!r}; only {ACP_PROFILE!r} is allowed"
            )
        if not isinstance(env, Mapping):
            raise DshAcpError("env must be an explicit mapping of strings")
        child_env: dict[str, str] = {}
        for key, value in env.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise DshAcpError("env keys and values must be strings")
            if "\x00" in key or "\x00" in value:
                raise DshAcpError("env keys and values must not contain NUL")
            child_env[key] = value
        self._env = child_env
        self._patch_path = self._absolute_path("patch_path", patch_path)
        self._cwd = self._absolute_path("cwd", cwd)
        self._runtime_path = (
            self._absolute_path("runtime_path", runtime_path)
            if runtime_path is not None
            else None
        )
        self._profile = profile
        self._on_notification = on_notification
        self._on_server_request = on_server_request
        self._listeners: dict[str, tuple[NotificationHandler | None, ServerRequestHandler | None]] = {}
        self._default_request_timeout = self._positive(
            "default_request_timeout", default_request_timeout
        )
        self._startup_timeout = self._positive("startup_timeout", startup_timeout)
        self._close_timeout = self._positive("close_timeout", close_timeout)
        if not isinstance(stderr_limit, int) or stderr_limit <= 0:
            raise DshAcpError("stderr_limit must be a positive integer")

        self._stderr: deque[str] = deque(maxlen=stderr_limit)
        self._protocol_errors: deque[str] = deque(maxlen=50)
        self._secrets = self._secret_values(child_env)

        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[int | str, asyncio.Future[Any]] = {}
        self._next_id = 1
        self._write_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
        self._start_lock = asyncio.Lock()
        self._notify_queue: asyncio.Queue[Any] = asyncio.Queue()
        self._notification_task: asyncio.Task[None] | None = None
        self._reader_tasks: list[asyncio.Task[None]] = []
        self._server_tasks: set[asyncio.Task[None]] = set()
        self._cleanup_tasks: set[asyncio.Task[None]] = set()
        self._answered_server_ids: set[int | str] = set()
        self._started = False
        self._closed = False
        self._exited = False
        self.unmatched_responses = 0

    # -- construction helpers -------------------------------------------------

    @staticmethod
    def _positive(name: str, value: float) -> float:
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise DshAcpError(f"{name} must be a positive number")
        return float(value)

    @staticmethod
    def _absolute_path(name: str, value: str | Path) -> Path:
        if not isinstance(value, (str, Path)):
            raise DshAcpError(f"{name} must be a path")
        path = Path(value)
        if not path.is_absolute():
            raise DshAcpError(f"{name} must be an absolute path, got {path}")
        return path

    @staticmethod
    def _secret_values(env: Mapping[str, str]) -> tuple[str, ...]:
        values = {
            value
            for key, value in env.items()
            if value and any(marker in key.upper() for marker in _SECRET_KEY_MARKERS)
        }
        # Longest first so overlapping secrets are fully replaced.
        return tuple(sorted(values, key=len, reverse=True))

    def _redact(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "[redacted]")
        return _SECRET_VALUE_PATTERN.sub("[redacted]", text)

    @property
    def argv(self) -> tuple[str, ...]:
        """The exact controlled child argv; never contains a token."""
        runtime = self._runtime_path or resolve_runtime_path()
        return (
            str(runtime),
            "--profile",
            self._profile,
            "--patch",
            str(self._patch_path),
        )

    @property
    def protocol_errors(self) -> list[str]:
        """Bounded, redacted stdout protocol problems observed so far."""
        return list(self._protocol_errors)

    def stderr_tail(self, limit: int = 50) -> list[str]:
        """Bounded, redacted stderr lines, newest last."""
        if limit <= 0:
            return []
        return list(self._stderr)[-limit:]

    # -- lifecycle ------------------------------------------------------------

    async def start(self) -> None:
        """Spawn the runtime and begin reading stdout/stderr.

        Serialized by ``_start_lock`` so concurrent callers cannot spawn two
        runtimes. A spawn that only completes after cancellation/timeout is
        reaped rather than leaked, and a spawn that completes after ``close()``
        is terminated instead of resurrecting the transport.
        """
        async with self._start_lock:
            if self._started:
                raise DshAcpError("ACP transport already started")
            if self._closed:
                raise DshAcpError("ACP transport is closed")
            runtime = self._runtime_path or resolve_runtime_path()
            if not runtime.is_file():
                raise DshAcpError(f"DSH runtime executable not found at {runtime}")
            if not os.access(runtime, os.X_OK):
                raise DshAcpError(f"DSH runtime is not executable: {runtime}")
            if not self._patch_path.is_file():
                raise DshAcpError(f"ACP patch file not found at {self._patch_path}")
            if not self._cwd.is_dir():
                raise DshAcpError(f"ACP cwd is not a directory: {self._cwd}")

            # Shield the spawn so a timeout/cancel cannot orphan a process that
            # execs after the await has already given up waiting for it.
            spawn = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    *self.argv,
                    cwd=str(self._cwd),
                    env=dict(self._env),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=_STDIO_LIMIT,
                )
            )
            try:
                proc = await asyncio.wait_for(
                    asyncio.shield(spawn), timeout=self._startup_timeout
                )
            except asyncio.TimeoutError as exc:
                spawn.add_done_callback(self._reap_spawn_result)
                raise DshAcpError(
                    f"timed out after {self._startup_timeout}s starting the DSH runtime"
                ) from exc
            except asyncio.CancelledError:
                spawn.add_done_callback(self._reap_spawn_result)
                raise
            except OSError as exc:
                raise DshAcpError(f"failed to start the DSH runtime: {exc}") from exc

            if self._closed:
                # close() ran while spawn was in flight; it saw no process.
                await self._terminate_process(proc)
                raise DshAcpError("ACP transport is closed")

            self._proc = proc
            self._started = True
        assert self._proc.stdout is not None and self._proc.stderr is not None
        self._reader_tasks = [
            asyncio.create_task(self._read_stdout(self._proc.stdout)),
            asyncio.create_task(self._read_stderr(self._proc.stderr)),
        ]
        self._notification_task = asyncio.create_task(self._drain_notifications())

    def _reap_spawn_result(self, spawn: asyncio.Task[Any]) -> None:
        """Terminate a spawn that completed after start() stopped waiting."""
        if spawn.cancelled():
            return
        if spawn.exception() is not None:
            return
        proc = spawn.result()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - loop already closing
            return
        task = loop.create_task(self._terminate_process(proc))
        self._cleanup_tasks.add(task)
        task.add_done_callback(self._cleanup_tasks.discard)

    async def _terminate_process(self, proc: asyncio.subprocess.Process) -> None:
        """Close stdin, terminate, and if needed kill one unmanaged process."""
        stdin = proc.stdin
        if stdin is not None:
            try:
                stdin.close()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        if proc.returncode is not None:
            return
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), self._close_timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), self._close_timeout)
            except asyncio.TimeoutError:
                pass

    async def close(self) -> None:
        """Idempotently tear down the transport; never an ACP session cancel."""
        async with self._close_lock:
            if self._closed:
                return
            self._closed = True
            self._fail_pending(DshAcpError("ACP transport closed"))

            for task in self._server_tasks:
                task.cancel()
            self._server_tasks.clear()
            if self._notification_task is not None:
                self._notification_task.cancel()
                self._notification_task = None

            proc = self._proc
            if proc is not None:
                stdin = proc.stdin
                if stdin is not None:
                    try:
                        stdin.close()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        pass
                if proc.returncode is None:
                    try:
                        proc.terminate()
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(proc.wait(), self._close_timeout)
                    except asyncio.TimeoutError:
                        try:
                            proc.kill()
                        except ProcessLookupError:
                            pass
                        try:
                            await asyncio.wait_for(proc.wait(), self._close_timeout)
                        except asyncio.TimeoutError:
                            pass

            tasks = [*self._reader_tasks]
            for task in tasks:
                task.cancel()
            if tasks or self._cleanup_tasks:
                await asyncio.wait(
                    [*tasks, *self._cleanup_tasks], timeout=self._close_timeout
                )
            self._reader_tasks = []
            self._proc = None

    # -- client-originated frames --------------------------------------------

    async def request(
        self,
        method: str,
        params: Any = None,
        timeout: float | None = None,
    ) -> Any:
        """Send one request and wait for its correlated result or error."""
        self._require_running()
        if not isinstance(method, str) or not method:
            raise DshAcpError("request method must be a non-empty string")
        effective_timeout = (
            self._default_request_timeout
            if timeout is None
            else self._positive("timeout", timeout)
        )
        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[request_id] = future
        frame: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        try:
            await self._send(frame)
        except BaseException:
            self._pending.pop(request_id, None)
            raise
        try:
            return await asyncio.wait_for(future, effective_timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise DshAcpError(
                f"ACP request {method!r} (id={request_id}) timed out after "
                f"{effective_timeout}s"
            ) from exc
        except asyncio.CancelledError:
            self._pending.pop(request_id, None)
            raise

    def add_listener(
        self,
        session_id: str,
        *,
        on_notification: NotificationHandler | None = None,
        on_server_request: ServerRequestHandler | None = None,
    ) -> None:
        """Register one ACP session on this shared runtime connection."""
        self._listeners[session_id] = (on_notification, on_server_request)

    def remove_listener(self, session_id: str | None) -> None:
        if isinstance(session_id, str):
            self._listeners.pop(session_id, None)

    async def notify(self, method: str, params: Any = None) -> None:
        """Send one JSON-RPC notification (no id, no response expected)."""
        self._require_running()
        if not isinstance(method, str) or not method:
            raise DshAcpError("notify method must be a non-empty string")
        frame: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        await self._send(frame)

    async def response(
        self,
        request_id: int | str,
        *,
        result: Any = _UNSET,
        error: Any = _UNSET,
    ) -> None:
        """Answer one server-initiated request with exactly one of result/error."""
        self._require_running()
        if not isinstance(request_id, (int, str)) or isinstance(request_id, bool):
            raise DshAcpError("response request_id must be an int or string")
        if (result is _UNSET) == (error is _UNSET):
            raise DshAcpError("response requires exactly one of result or error")
        frame: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        if result is not _UNSET:
            frame["result"] = result
        else:
            frame["error"] = error
        await self._send(frame)
        self._answered_server_ids.add(request_id)

    # -- writes ---------------------------------------------------------------

    async def _send(self, frame: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or self._closed or self._exited:
            raise DshAcpError("ACP transport is not running")
        data = (
            json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        async with self._write_lock:
            try:
                proc.stdin.write(data)
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                raise DshAcpError(f"failed to write to the DSH runtime: {exc}") from exc

    def _require_running(self) -> None:
        if not self._started:
            raise DshAcpError("ACP transport is not started")
        if self._closed:
            raise DshAcpError("ACP transport is closed")
        if self._exited:
            raise DshAcpError("DSH runtime process has exited")

    # -- stdout reader --------------------------------------------------------

    async def _read_stdout(self, stream: asyncio.StreamReader) -> None:
        try:
            while True:
                try:
                    raw = await stream.readline()
                except ValueError as exc:
                    self._record_protocol_error(f"stdout frame too large: {exc}")
                    self._fail_pending(
                        DshAcpError(f"invalid stdout framing from DSH runtime: {exc}")
                    )
                    break
                if not raw:
                    break
                if not raw.endswith(b"\n"):
                    self._record_protocol_error(
                        "stdout contained an unterminated final frame"
                    )
                    break
                line = raw[:-1]
                if line.endswith(b"\r"):
                    line = line[:-1]
                text = line.decode("utf-8", "replace")
                self._handle_stdout_line(text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            self._record_protocol_error(
                f"stdout reader failed: {type(exc).__name__}: {exc}"
            )
            self._fail_pending(DshAcpError(f"stdout reader failed: {exc}"))
        finally:
            self._exited = True
            self._fail_pending(
                DshAcpError("DSH runtime stdout closed; process exited")
            )
            if self._notification_task is not None:
                self._notify_queue.put_nowait(_QUEUE_STOP)

    def _handle_stdout_line(self, text: str) -> None:
        if not text.strip():
            return
        try:
            message = json.loads(text)
        except json.JSONDecodeError as exc:
            self._record_protocol_error(
                f"invalid JSON on stdout: {exc}: {text[:300]}"
            )
            # A broken stream cannot be trusted to correlate future frames.
            self._fail_pending(
                DshAcpError(f"invalid JSON from DSH runtime stdout: {exc}")
            )
            return
        if not isinstance(message, dict):
            self._record_protocol_error(
                f"stdout JSON was not an object: {text[:300]}"
            )
            self._fail_pending(
                DshAcpError("DSH runtime sent a non-object JSON-RPC frame")
            )
            return
        self._dispatch_message(message)

    def _dispatch_message(self, message: dict[str, Any]) -> None:
        has_method = "method" in message
        has_id = "id" in message
        if not has_method:
            if has_id and ("result" in message or "error" in message):
                self._resolve_response(message)
            else:
                self._record_protocol_error(
                    "malformed frame without method/result/error: "
                    f"{json.dumps(message, ensure_ascii=False)[:300]}"
                )
                self._fail_pending(
                    DshAcpError("DSH runtime sent a malformed JSON-RPC frame")
                )
            return
        if has_id:
            task = asyncio.create_task(self._handle_server_request(message))
            self._server_tasks.add(task)
            task.add_done_callback(self._server_tasks.discard)
            return
        self._notify_queue.put_nowait(message)

    def _resolve_response(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if not isinstance(request_id, (int, str)) or isinstance(request_id, bool):
            self._record_protocol_error("response id was not an int or string")
            return
        future = self._pending.pop(request_id, None)
        if future is None:
            # Unknown/late responses are ignored, never applied to another id.
            self.unmatched_responses += 1
            return
        if future.done():
            return
        if "error" in message:
            error = message.get("error")
            future.set_exception(self._error_from_response(request_id, error))
            return
        future.set_result(message.get("result"))

    @staticmethod
    def _error_from_response(request_id: int | str, error: Any) -> DshAcpError:
        if not isinstance(error, dict):
            return DshAcpError(
                f"ACP request id={request_id} failed with malformed error: {error!r}"
            )
        code = error.get("code")
        message = error.get("message")
        text = (
            f"ACP request id={request_id} failed: "
            f"{message if isinstance(message, str) else error!r}"
        )
        return DshAcpError(
            text,
            code=code if isinstance(code, int) else None,
            data=error.get("data"),
        )

    def _fail_pending(self, error: DshAcpError) -> None:
        pending = self._pending
        self._pending = {}
        for future in pending.values():
            if not future.done():
                future.set_exception(error)

    def _record_protocol_error(self, detail: str) -> None:
        self._protocol_errors.append(self._redact(detail))

    # -- callbacks ------------------------------------------------------------

    async def _drain_notifications(self) -> None:
        try:
            while True:
                message = await self._notify_queue.get()
                if message is _QUEUE_STOP:
                    return
                session_id = None
                params = message.get("params") if isinstance(message, dict) else None
                if isinstance(params, dict):
                    candidate = params.get("sessionId")
                    if isinstance(candidate, str):
                        session_id = candidate
                handlers = []
                if session_id is not None:
                    listener = self._listeners.get(session_id)
                    if listener is not None and listener[0] is not None:
                        handlers.append(listener[0])
                if not handlers and self._on_notification is not None:
                    handlers.append(self._on_notification)
                if not handlers:
                    handlers = [
                        listener[0]
                        for listener in self._listeners.values()
                        if listener[0] is not None
                    ]
                if not handlers:
                    continue
                for handler in handlers:
                    try:
                        outcome = handler(message)
                        if inspect.isawaitable(outcome):
                            await outcome
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # callback errors never kill the reader
                        self._record_protocol_error(
                            f"notification handler failed: {type(exc).__name__}: {exc}"
                        )
        except asyncio.CancelledError:
            raise

    def _server_request_handler(self, message: dict[str, Any]) -> ServerRequestHandler | None:
        params = message.get("params") if isinstance(message, dict) else None
        session_id = params.get("sessionId") if isinstance(params, dict) else None
        if isinstance(session_id, str):
            listener = self._listeners.get(session_id)
            if listener is not None and listener[1] is not None:
                return listener[1]
        return self._on_server_request

    async def _handle_server_request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        tracked = isinstance(request_id, (int, str)) and not isinstance(
            request_id, bool
        )
        try:
            handler = self._server_request_handler(message)
            if handler is None:
                await self._respond_safely(
                    request_id,
                    error={
                        "code": -32601,
                        "message": f"no client handler for {message.get('method')!r}",
                    },
                )
                return
            try:
                outcome = handler(message)
                if inspect.isawaitable(outcome):
                    outcome = await outcome
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._respond_safely(
                    request_id,
                    error={"code": -32603, "message": str(exc)},
                )
                return
            if outcome is None:
                # The handler answered explicitly through response().
                if tracked and request_id not in self._answered_server_ids:
                    self._record_protocol_error(
                        f"server request id={request_id!r} was not answered"
                    )
                return
            if tracked and request_id in self._answered_server_ids:
                # An explicit response() plus a returned payload must not send
                # a second response for the same id.
                self._record_protocol_error(
                    f"server request id={request_id!r} answered twice; "
                    "ignoring returned payload"
                )
                return
            await self._respond_safely(request_id, result=outcome)
        finally:
            if tracked:
                self._answered_server_ids.discard(request_id)

    async def _respond_safely(self, request_id: Any, **kwargs: Any) -> None:
        try:
            await self.response(request_id, **kwargs)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # The runtime may already be gone; never leak a task exception.
            self._record_protocol_error(
                f"failed to answer server request: {type(exc).__name__}: {exc}"
            )

    # -- stderr reader --------------------------------------------------------

    async def _read_stderr(self, stream: asyncio.StreamReader) -> None:
        try:
            while True:
                try:
                    raw = await stream.readline()
                except ValueError:
                    self._stderr.append("[stderr frame exceeded the line limit]")
                    break
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                self._stderr.append(self._redact(line[:2000]))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            self._stderr.append(
                self._redact(f"[stderr reader failed: {type(exc).__name__}: {exc}]")
            )
