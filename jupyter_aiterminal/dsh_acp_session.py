"""ACP v1 session host on top of :class:`DshAcpTransport`.

This layer owns exactly one durable ACP session and one replaceable runtime
connection. It is deliberately above the transport: it composes the reviewed
provider profile patch and isolated child environment, performs the ACP
handshake (``initialize`` then ``session/new`` or ``session/resume``), exposes
prompt/cancel/close, and answers ACP ``session/request_permission`` server
requests automatically. Approval is granted inside the host by selecting the
advertised allow option; no product interaction event is produced and the
frontend must not render or wait on an approval request.

It does not project ordinary session notifications. Raw notification envelopes
are passed unchanged to an injected ``on_notification`` callback so a separate
adapter (``dsh_acp_events``) can own event-body projection.

Security posture:

* ``config``/``cwd``/``storage_root`` are the only host-controlled inputs. The
  ACP profile, patch path, MCP server list and ``session/new`` cwd are fixed by
  reviewed builders; a caller cannot select a profile, patch or MCP server.
* ``storage_root`` is server-controlled. Per-workspace, per-session private
  directories carry ``HOME`` and ``DSH_HOME`` (distinct, ``0700``) and the
  rendered JSON patch (``0600``, never containing the token). The child
  environment is a complete replacement built by ``build_acp_subprocess_env``.
* A resume target is never silently replaced by a new session. A missing or
  failed resume raises, surfacing the runtime's error.
* Permission requests are auto-approved only after validating the live
  session, active run and tool-call id. The selected ``optionId`` is always one
  the server advertised: ``allow_once`` is preferred, ``allow_always`` is used
  when no one-shot allow option exists (e.g. a sandbox escalation). A request
  without any advertised allow option returns the ACP standard ``cancelled``
  outcome, so approval is never invented or taken from an unadvertised id.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
import shutil
import uuid
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any

from .dsh_acp_config import (
    ACP_ROW_APPROVAL,
    ACP_ROW_SANDBOX_POLICY,
    build_acp_session_params,
    build_acp_subprocess_env,
    render_acp_profile_patch,
)
from .dsh_acp_transport import DshAcpError, DshAcpTransport
from .dsh_config import DshProviderConfig

__all__ = ["DshAcpSession", "DshAcpSessionError"]

PRODUCT_EVENT_PREFIX = "dsh/v1/"
_PROTOCOL_VERSION = 1
_STORAGE_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")

# The ACP approval/sandbox posture is only safe on the exact runtime release
# the patch row ids were verified against. Anything else could silently drop
# the overlay and boot with the base profile's default approval policy.
_EXPECTED_RUNTIME_DISTRIBUTION = "deepseek-harness-runtime-bin"
_EXPECTED_RUNTIME_VERSION = "0.2.1rc2"

# Warnings the pinned runtime emits when a patch row does not apply. The
# 0.2.1rc2 format is ``patch: entry "<id>" not found`` (and ``patch insert:
# entry`` / ``name mismatch`` variants); a bare ``not found`` only counts when
# the same line carries patch/runtime context so ordinary config text cannot
# trip the check.
_PATCH_WARNING_MARKERS = (
    "patch: entry",
    "patch insert: entry",
    "name mismatch",
)
_NOT_FOUND_MARKER = "not found"
_PREFLIGHT_OUTPUT_LIMIT = 4 * 1024 * 1024
_PREFLIGHT_STREAM_LIMIT = 64 * 1024

PolicyPreflight = Callable[
    [tuple[str, ...], Path, Mapping[str, str], float],
    Awaitable[tuple[int, str, str]],
]


class DshAcpSessionError(RuntimeError):
    """A session-host failure with a stable, user-facing message."""


def _cancelled_outcome() -> dict[str, Any]:
    return {"outcome": {"outcome": "cancelled"}}


def _selected_outcome(option_id: str) -> dict[str, Any]:
    return {"outcome": {"outcome": "selected", "optionId": option_id}}


def _installed_runtime_version() -> str:
    """Return the installed DSH runtime distribution version.

    Read from package metadata, not from the executable, so a mismatched wheel
    is caught before any subprocess starts.
    """
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(_EXPECTED_RUNTIME_DISTRIBUTION)
    except PackageNotFoundError as exc:
        raise DshAcpSessionError(
            f"the pinned DSH runtime package {_EXPECTED_RUNTIME_DISTRIBUTION} "
            "is not installed"
        ) from exc
    except Exception as exc:
        raise DshAcpSessionError(
            "cannot determine the installed DSH runtime version"
        ) from exc


def _is_patch_warning(line: str) -> bool:
    if any(marker in line for marker in _PATCH_WARNING_MARKERS):
        return True
    lowered = line.lower()
    return _NOT_FOUND_MARKER in lowered and "patch" in lowered


def _patch_failure_lines(lines: list[str]) -> list[str]:
    return [line for line in lines if _is_patch_warning(line)]


def _row_block(dump: str, row_id: str) -> str | None:
    """Return the dumped YAML block for one top-level ``- id: <row>`` row.

    Matching is line-anchored (quoted or bare ids) so a value in an unrelated
    row cannot satisfy the assertion. ``None`` also means the row is absent or
    appears more than once: a duplicate could shadow the checked row.
    """
    wanted = {f"- id: {row_id}", f'- id: "{row_id}"', f"- id: '{row_id}'"}
    lines = dump.splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip() in wanted]
    if len(starts) != 1:
        return None
    start = starts[0]
    block = [lines[start]]
    for line in lines[start + 1 :]:
        if line.lstrip().startswith("- id: "):
            break
        block.append(line)
    return "\n".join(block)


# YAML block scalar headers: optional indentation digit then chomping/keep
# indicator, e.g. ``>-``, ``>``, ``|-``, ``|``, ``>2-``. The real 0.2.1rc2
# dumper uses a folded style once a value (a long workspace path) no longer
# fits its single-line width.
_BLOCK_SCALAR_HEADER = re.compile(r"[>|][1-9]?[+-]?|[>|][+-][1-9]?")


def _yaml_key_pattern(key: str) -> re.Pattern[str]:
    return re.compile(rf"^(?P<indent> *){re.escape(key)}:[ \t]*(?P<value>.*?)[ \t]*$")


def _fold_block_scalar(header: str, lines: list[str]) -> str:
    """Restore one YAML block scalar body from its dedented lines.

    Folded styles join adjacent non-empty lines with a space (so a wrapped
    value reads as one logical line); literal styles keep newlines. Trailing
    newlines added by chomping are dropped: the caller compares a filesystem
    path, which cannot carry a line break.
    """
    if header[0] == "|":
        return "\n".join(lines).rstrip("\n")
    text = ""
    breaks = 0
    for line in lines:
        if line == "":
            breaks += 1
            continue
        if text:
            text += " " if breaks == 0 else "\n" * breaks
        text += line
        breaks = 0
    return text.rstrip("\n")


def _yaml_key_values(block: str, key: str) -> list[str] | None:
    """Return every scalar value bound to ``key`` inside one dumped row.

    Handles plain, quoted and block (``>-``/``>``/``|-``/``|``) scalars. A
    block scalar's indented continuation lines are consumed as its value, so
    injected extra lines cannot pass as a second scalar. ``None`` means the key
    is absent, duplicated, or unparsable: an ambiguous dump cannot prove the
    overlay.
    """
    pattern = _yaml_key_pattern(key)
    lines = block.splitlines()
    values: list[str] = []
    index = 0
    while index < len(lines):
        match = pattern.match(lines[index])
        if match is None:
            index += 1
            continue
        inline = match.group("value")
        if not _BLOCK_SCALAR_HEADER.fullmatch(inline):
            values.append(inline.strip().strip("\"'").strip())
            index += 1
            continue
        key_indent = len(match.group("indent"))
        body: list[str] = []
        body_indent: int | None = None
        cursor = index + 1
        while cursor < len(lines):
            line = lines[cursor]
            if not line.strip():
                body.append("")
                cursor += 1
                continue
            line_indent = len(line) - len(line.lstrip(" "))
            if line_indent <= key_indent:
                break
            if body_indent is None:
                body_indent = line_indent
            body.append(line[body_indent:])
            cursor += 1
        values.append(_fold_block_scalar(inline, body))
        index = cursor
    if not values:
        return None
    if len(values) > 1:
        return None
    return values


def _block_has_scalar(block: str, key: str, expected: set[str]) -> bool:
    values = _yaml_key_values(block, key)
    return values is not None and values[0] in expected


async def _stop_preflight_process(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=5.0)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass


async def _run_policy_preflight(
    argv: tuple[str, ...],
    cwd: Path,
    env: Mapping[str, str],
    timeout: float,
) -> tuple[int, str, str]:
    """Run the runtime's ``--dump-config`` in its own process.

    This is the authoritative policy check: the process exits after writing the
    fully patched config, so every patch warning has already been emitted and
    the parsed output is complete instead of racing a live ACP server's
    asynchronous stderr. The same argv/env/cwd as the real child are used.

    Output is streamed with a hard total cap, and a timeout, cancellation, or
    oversized output always kills the child before raising. The kill path is
    shielded and bounded so it cannot itself be cancelled into an orphan.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        "--dump-config",
        cwd=str(cwd),
        env=dict(env),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=_PREFLIGHT_STREAM_LIMIT,
    )
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    total = [0]

    async def _consume(stream: asyncio.StreamReader, sink: list[bytes]) -> None:
        while True:
            chunk = await stream.read(_PREFLIGHT_STREAM_LIMIT)
            if not chunk:
                return
            total[0] += len(chunk)
            if total[0] > _PREFLIGHT_OUTPUT_LIMIT:
                raise DshAcpSessionError(
                    "DSH runtime policy preflight output exceeded the size limit; "
                    "refusing to start"
                )
            sink.append(chunk)

    try:
        assert proc.stdout is not None and proc.stderr is not None
        await asyncio.wait_for(
            asyncio.gather(
                _consume(proc.stdout, stdout_chunks),
                _consume(proc.stderr, stderr_chunks),
                proc.wait(),
            ),
            timeout=timeout,
        )
    except (asyncio.TimeoutError, TimeoutError):
        raise DshAcpSessionError(
            "DSH runtime policy preflight timed out; refusing to start"
        )
    finally:
        await _stop_preflight_process(proc)
    return (
        proc.returncode if proc.returncode is not None else -1,
        b"".join(stdout_chunks).decode("utf-8", errors="replace"),
        b"".join(stderr_chunks).decode("utf-8", errors="replace"),
    )


def _non_empty_text(name: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DshAcpSessionError(f"{name} must be a non-empty string")
    return value


def _positive(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise DshAcpSessionError(f"{name} must be a positive number")
    return float(value)


def _tool_call_id(tool_call: Any) -> str | None:
    if not isinstance(tool_call, Mapping):
        return None
    for key in ("toolCallId", "id"):
        value = tool_call.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _allow_option_id(options: Any) -> str | None:
    """Return an advertised allow option id, preferring ``allow_once``.

    ACP permission options carry a ``kind`` discriminator. Only ids present in
    this request's option list are eligible, so an approval can never invent an
    option id. ``allow_always`` is selected only when the server advertised no
    one-shot allow option, e.g. a persistent sandbox escalation grant.
    """
    if not isinstance(options, list):
        return None
    allow_once: str | None = None
    allow_always: str | None = None
    for option in options:
        if not isinstance(option, Mapping):
            continue
        option_id = option.get("optionId")
        if not isinstance(option_id, str) or not option_id:
            continue
        kind = option.get("kind")
        if kind == "allow_once" and allow_once is None:
            allow_once = option_id
        elif kind == "allow_always" and allow_always is None:
            allow_always = option_id
    return allow_once if allow_once is not None else allow_always


class DshAcpSession:
    """One durable ACP session backed by an owned, replaceable runtime."""

    def __init__(
        self,
        *,
        config: DshProviderConfig,
        cwd: str | Path,
        storage_root: str | Path,
        emit: Callable[[dict[str, Any]], None] | None,
        resume_session_id: str | None = None,
        on_notification: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
        request_timeout: float = 30.0,
        prompt_timeout: float = 600.0,
        permission_timeout: float = 300.0,
        cancel_settle_timeout: float = 10.0,
        startup_timeout: float = 10.0,
        preflight_timeout: float = 30.0,
        close_timeout: float = 5.0,
        runtime_version: Callable[[], str] | None = None,
        policy_preflight: PolicyPreflight | None = None,
    ) -> None:
        if not isinstance(config, DshProviderConfig):
            raise DshAcpSessionError("config must be a DshProviderConfig instance")
        if emit is not None and not callable(emit):
            raise DshAcpSessionError("emit must be callable or None")
        if on_notification is not None and not callable(on_notification):
            raise DshAcpSessionError("on_notification must be callable or None")
        if runtime_version is not None and not callable(runtime_version):
            raise DshAcpSessionError("runtime_version must be callable or None")
        if policy_preflight is not None and not callable(policy_preflight):
            raise DshAcpSessionError("policy_preflight must be callable or None")
        self._config = config
        self._cwd = self._absolute_directory("cwd", cwd)
        self._storage_root = self._absolute_path("storage_root", storage_root)
        self._emit_callback = emit
        self._on_notification = on_notification
        self._request_timeout = _positive("request_timeout", request_timeout)
        self._prompt_timeout = _positive("prompt_timeout", prompt_timeout)
        self._permission_timeout = _positive("permission_timeout", permission_timeout)
        self._cancel_settle_timeout = _positive(
            "cancel_settle_timeout", cancel_settle_timeout
        )
        self._startup_timeout = _positive("startup_timeout", startup_timeout)
        self._preflight_timeout = _positive("preflight_timeout", preflight_timeout)
        self._close_timeout = _positive("close_timeout", close_timeout)
        self._runtime_version = runtime_version or _installed_runtime_version
        self._policy_preflight = policy_preflight or _run_policy_preflight

        if resume_session_id is not None:
            resume_session_id = _non_empty_text("resume_session_id", resume_session_id)
        self._resume = resume_session_id is not None
        self._session_id: str | None = resume_session_id
        self._runtime_id: str | None = None

        self._transport: DshAcpTransport | None = None
        self._started = False
        self._starting = False
        self._closed = False
        self._close_lock = asyncio.Lock()
        self._close_task: asyncio.Task[None] | None = None
        self._run_lock = asyncio.Lock()
        self._active_run_id: str | None = None
        self._prompt_done: asyncio.Future[None] | None = None

        self._workspace_dir: Path | None = None
        self._session_root: Path | None = None
        self._home: Path | None = None
        self._dsh_home: Path | None = None
        self._patch_path: Path | None = None
        self._created_session_root = False

    # -- construction helpers ------------------------------------------------

    @staticmethod
    def _absolute_path(name: str, value: str | Path) -> Path:
        if not isinstance(value, (str, Path)):
            raise DshAcpSessionError(f"{name} must be a path")
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise DshAcpSessionError(f"{name} must be an absolute path, got {path}")
        return path

    @classmethod
    def _absolute_directory(cls, name: str, value: str | Path) -> Path:
        path = cls._absolute_path(name, value)
        if path.is_symlink() or not path.is_dir():
            raise DshAcpSessionError(f"{name} must be an existing directory: {path}")
        return path

    # -- public identity -----------------------------------------------------

    @property
    def session_id(self) -> str | None:
        """Durable ACP session id; survives a runtime process restart."""
        return self._session_id

    @property
    def runtime_id(self) -> str | None:
        """Current runtime connection generation, or ``None`` before start."""
        return self._runtime_id

    @property
    def cwd(self) -> Path:
        return self._cwd

    @property
    def storage_root(self) -> Path:
        return self._storage_root

    @property
    def home(self) -> Path | None:
        return self._home

    @property
    def dsh_home(self) -> Path | None:
        return self._dsh_home

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        if self._closed:
            raise DshAcpSessionError("cannot start a closed ACP session")
        if self._started:
            return
        if self._starting:
            raise DshAcpSessionError("ACP session is already starting")
        self._starting = True
        self._runtime_id = f"runtime-{uuid.uuid4().hex}"
        try:
            self._assert_pinned_runtime()
            await self._prepare_storage()
            env = build_acp_subprocess_env(
                os.environ,
                home=self._home,
                dsh_home=self._dsh_home,
                config=self._config,
            )
            self._transport = DshAcpTransport(
                patch_path=self._patch_path,
                cwd=self._cwd,
                env=env,
                on_notification=self._handle_notification,
                on_server_request=self._handle_server_request,
                default_request_timeout=self._request_timeout,
                startup_timeout=self._startup_timeout,
                close_timeout=self._close_timeout,
            )
            await self._verify_policy_overlay(env)
            await self._transport.start()
            await self._initialize()
            self._assert_policy_stderr_clean()
            if self._resume:
                await self._resume_session()
            else:
                await self._new_session()
            self._started = True
        except asyncio.CancelledError:
            await self._cleanup_start_failure()
            raise
        except DshAcpSessionError:
            await self._cleanup_start_failure()
            raise
        except Exception as exc:
            await self._cleanup_start_failure()
            raise DshAcpSessionError(f"failed to start ACP session: {exc}") from exc
        finally:
            self._starting = False

        self._emit(
            {
                "type": f"{PRODUCT_EVENT_PREFIX}session",
                "sessionId": self._session_id,
                "runtimeId": self._runtime_id,
                "phase": "resumed" if self._resume else "attached",
            }
        )
        self._emit(
            {
                "type": f"{PRODUCT_EVENT_PREFIX}capabilities",
                "runtimeId": self._runtime_id,
                "capabilities": self._capabilities(),
            }
        )

    def _capabilities(self) -> dict[str, dict[str, str]]:
        # Only handshake-verified capabilities are declared. Cancellation is
        # always available. Approval is resolved automatically inside the host,
        # so no frontend interaction channel exists and none is advertised.
        return {
            "cancel": {"status": "available"},
            "approval": {
                "status": "unavailable",
                "reason": "approval is handled automatically by the runtime host",
            },
        }

    def _assert_pinned_runtime(self) -> None:
        try:
            installed = self._runtime_version()
        except DshAcpSessionError:
            raise
        except Exception as exc:
            raise DshAcpSessionError(
                "cannot determine the installed DSH runtime version"
            ) from exc
        if installed != _EXPECTED_RUNTIME_VERSION:
            raise DshAcpSessionError(
                "DSH runtime version must be "
                f"{_EXPECTED_RUNTIME_VERSION}; refusing to start"
            )

    async def _verify_policy_overlay(self, env: Mapping[str, str]) -> None:
        """Fail closed unless a standalone dump proves the overlay applied.

        The patch sets ``approval.policy: ask`` and the workspace sandbox root.
        Both are asserted from the dumped config; a runtime that ignores a
        patch row either prints a ``not found`` warning or omits the value.
        """
        transport = self._transport
        assert transport is not None
        try:
            code, stdout, stderr = await self._policy_preflight(
                transport.argv, self._cwd, env, self._preflight_timeout
            )
        except DshAcpSessionError:
            raise
        except Exception as exc:
            raise DshAcpSessionError(
                "DSH runtime policy preflight failed; refusing to start"
            ) from exc
        if code != 0 or _patch_failure_lines(
            stdout.splitlines() + stderr.splitlines()
        ):
            raise DshAcpSessionError(
                "DSH runtime did not apply the ACP policy overlay; refusing to start"
            )
        approval = _row_block(stdout, ACP_ROW_APPROVAL)
        sandbox = _row_block(stdout, ACP_ROW_SANDBOX_POLICY)
        roots = {os.fspath(self._cwd), os.fspath(self._cwd.resolve())}
        approval_ask = approval is not None and _block_has_scalar(
            approval, "policy", {"ask"}
        )
        root_pinned = sandbox is not None and _block_has_scalar(
            sandbox, "workspaceRoot", roots
        )
        if not approval_ask or not root_pinned:
            raise DshAcpSessionError(
                "DSH runtime did not apply the ACP policy overlay; refusing to start"
            )

    def _assert_policy_stderr_clean(self) -> None:
        # Defence in depth behind the preflight. ACP stderr is asynchronous, so
        # an empty tail here is not proof; the completed preflight is.
        transport = self._transport
        if transport is None:
            return
        if _patch_failure_lines(transport.stderr_tail()):
            raise DshAcpSessionError(
                "DSH runtime did not apply the ACP policy overlay; refusing to start"
            )

    async def _initialize(self) -> None:
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
        if not isinstance(result, dict):
            raise DshAcpSessionError("initialize returned a non-object result")
        if result.get("protocolVersion") != _PROTOCOL_VERSION:
            raise DshAcpSessionError(
                "runtime did not negotiate ACP protocol version "
                f"{_PROTOCOL_VERSION}: {result.get('protocolVersion')!r}"
            )

    async def _new_session(self) -> None:
        # Fixed params: host cwd, empty MCP server list. Callers cannot widen
        # the tool surface through this API.
        params = build_acp_session_params(self._cwd)
        try:
            result = await self._transport.request("session/new", params)
        except DshAcpError as exc:
            raise DshAcpSessionError(f"session/new failed: {exc}") from exc
        session_id = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not session_id.strip():
            raise DshAcpSessionError("session/new did not return a sessionId")
        self._session_id = session_id
        self._write_index()

    async def _resume_session(self) -> None:
        session_id = self._session_id
        assert session_id is not None
        params = build_acp_session_params(self._cwd)
        params["sessionId"] = session_id
        try:
            await self._transport.request("session/resume", params)
        except DshAcpError as exc:
            # Never fall back to session/new when the requested session cannot
            # be resumed; that would silently replace durable identity.
            raise DshAcpSessionError(
                f"failed to resume ACP session {session_id!r}: {exc}"
            ) from exc
        self._write_index()

    async def close(self) -> None:
        """Release the session and runtime within a bounded time. Idempotent.

        The actual transport release runs in a shared shielded task, so an
        outer cancellation of one caller cannot skip runtime shutdown; a later
        ``close()`` awaits (and thereby observes the completion of) the same
        cleanup instead of returning early with a live child process.
        """
        async with self._close_lock:
            if self._close_task is None:
                self._closed = True
                self._close_task = asyncio.create_task(self._close_transport())
            task = self._close_task
        await asyncio.shield(task)

    async def _close_transport(self) -> None:
        transport = self._transport
        try:
            if (
                transport is not None
                and self._started
                and self._session_id is not None
            ):
                try:
                    await transport.request(
                        "session/close",
                        {"sessionId": self._session_id},
                        timeout=self._close_timeout,
                    )
                except Exception:
                    # The runtime may already be gone or busy; transport
                    # shutdown below is still the authoritative release.
                    pass
        finally:
            if transport is not None:
                try:
                    await transport.close()
                except Exception:
                    pass
            self._transport = None
            self._started = False

    async def _cleanup_start_failure(self) -> None:
        transport = self._transport
        self._transport = None
        if transport is not None:
            if self._session_id is not None:
                try:
                    await transport.request(
                        "session/close",
                        {"sessionId": self._session_id},
                        timeout=self._close_timeout,
                    )
                except Exception:
                    pass
            try:
                await transport.close()
            except Exception:
                pass
        if self._created_session_root and self._session_root is not None:
            shutil.rmtree(self._session_root, ignore_errors=True)

    # -- prompt and cancel ---------------------------------------------------

    async def prompt(self, text: str, run_id: str) -> Any:
        """Run one prompt. A second concurrent prompt is rejected."""
        if not self._started or self._closed:
            raise DshAcpSessionError("ACP session is not running")
        prompt = _non_empty_text("text", text)
        run = _non_empty_text("run_id", run_id)
        if self._run_lock.locked() or self._prompt_done is not None:
            raise DshAcpSessionError(
                "another prompt is already active; concurrent prompts are rejected"
            )
        async with self._run_lock:
            if not self._started or self._closed:
                raise DshAcpSessionError("ACP session is not running")
            if self._session_id is None:
                raise DshAcpSessionError("ACP session has no sessionId")
            loop = asyncio.get_running_loop()
            done: asyncio.Future[None] = loop.create_future()
            self._prompt_done = done
            self._active_run_id = run
            try:
                return await self._transport.request(
                    "session/prompt",
                    {
                        "sessionId": self._session_id,
                        "prompt": [{"type": "text", "text": prompt}],
                    },
                    timeout=self._prompt_timeout,
                )
            finally:
                self._active_run_id = None
                if not done.done():
                    done.set_result(None)
                if self._prompt_done is done:
                    self._prompt_done = None

    async def cancel(self) -> bool:
        """Send ACP ``session/cancel`` and wait for the prompt to settle.

        The session itself stays open; a later prompt on the same session is
        legal. Returns ``True`` when a prompt was in flight, ``False`` when
        there was nothing to cancel.
        """
        if not self._started or self._closed:
            raise DshAcpSessionError("ACP session is not running")
        done = self._prompt_done
        if done is None or self._session_id is None:
            return False
        await self._transport.notify(
            "session/cancel", {"sessionId": self._session_id}
        )
        try:
            await asyncio.wait_for(
                asyncio.shield(done), self._cancel_settle_timeout
            )
        except asyncio.TimeoutError as exc:
            raise DshAcpSessionError(
                "prompt did not settle after session/cancel within "
                f"{self._cancel_settle_timeout}s"
            ) from exc
        return True

    # -- permissions ---------------------------------------------------------

    async def _handle_server_request(self, message: dict[str, Any]) -> Any:
        method = message.get("method")
        if method != "session/request_permission":
            raise DshAcpSessionError(
                f"unsupported ACP server request {method!r}"
            )
        if not self._started or self._closed:
            return _cancelled_outcome()
        params = message.get("params")
        if not isinstance(params, Mapping):
            return _cancelled_outcome()
        if params.get("sessionId") != self._session_id:
            return _cancelled_outcome()
        if self._active_run_id is None:
            # No prompt is in flight: an approval would authorize a tool call
            # the product cannot attribute to a run. Cancel it, fail-closed.
            return _cancelled_outcome()
        tool_call_id = _tool_call_id(params.get("toolCall"))
        if tool_call_id is None:
            return _cancelled_outcome()
        option_id = _allow_option_id(params.get("options"))
        if option_id is None:
            # No advertised allow option: fail closed instead of inventing an
            # option id the server never offered.
            return _cancelled_outcome()
        # Auto-approve this single request with the advertised allow option.
        # The runtime still owns its own sandbox/escalation semantics; this
        # host only answers the ACP permission prompt and never bypasses the
        # tool implementation.
        return _selected_outcome(option_id)

    async def resolve_permission(
        self,
        request_id: str,
        decision: str,
        scope: Mapping[str, str],
    ) -> bool:
        """Compatibility entry point; new requests never become pending.

        Approval is answered inside :meth:`_handle_server_request`, so a UI
        decision can no longer race, extend, or override a permission request.
        The method stays callable for older handlers and fails closed for every
        id, matching the previous unknown-request behavior.
        """
        if not self._started or self._closed:
            raise DshAcpSessionError("ACP session is not running")
        if not isinstance(request_id, str) or not request_id:
            raise DshAcpSessionError("request_id must be a non-empty string")
        raise DshAcpSessionError(f"no pending permission request {request_id!r}")

    # -- notification adapter interface -------------------------------------

    async def _handle_notification(self, message: dict[str, Any]) -> None:
        callback = self._on_notification
        if callback is None:
            return
        try:
            outcome = callback(message)
            if inspect.isawaitable(outcome):
                await outcome
        except asyncio.CancelledError:
            raise
        except Exception:
            # An adapter failure must not corrupt transport ordering.
            return

    # -- storage -------------------------------------------------------------

    def _workspace_key(self) -> str:
        return hashlib.sha256(os.fspath(self._cwd).encode("utf-8")).hexdigest()[:32]

    def _ensure_private_dir(self, path: Path) -> Path:
        if path.exists() or path.is_symlink():
            if path.is_symlink() or not path.is_dir():
                raise DshAcpSessionError(
                    f"private storage path must be a directory: {path}"
                )
        else:
            path.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path, 0o700)
        except OSError as exc:
            raise DshAcpSessionError(
                f"cannot secure private storage directory {path}: {exc}"
            ) from exc
        return path

    async def _prepare_storage(self) -> None:
        root = self._ensure_private_dir(self._storage_root)
        workspaces = self._ensure_private_dir(root / "workspaces")
        workspace = self._ensure_private_dir(workspaces / self._workspace_key())
        index = self._ensure_private_dir(workspace / "index")
        sessions = self._ensure_private_dir(workspace / "sessions")

        if self._resume:
            session_id = self._session_id
            assert session_id is not None
            storage_key = self._read_storage_key(index, session_id)
            if storage_key is None:
                storage_key = "resume-" + hashlib.sha256(
                    session_id.encode("utf-8")
                ).hexdigest()[:32]
        else:
            storage_key = f"session-{uuid.uuid4().hex}"

        session_root = sessions / storage_key
        self._created_session_root = not session_root.exists()
        self._session_root = self._ensure_private_dir(session_root)
        self._home = self._ensure_private_dir(session_root / "home")
        self._dsh_home = self._ensure_private_dir(session_root / "dsh")
        self._workspace_dir = workspace
        self._patch_path = session_root / "patch.json"
        self._write_patch()

    def _write_patch(self) -> None:
        patch_path = self._patch_path
        assert patch_path is not None
        text = render_acp_profile_patch(
            self._config, workspace_root=self._cwd
        )
        if self._config.token in text:  # defensive: the builder never emits it
            raise DshAcpSessionError(
                "rendered ACP profile patch must not contain the API token"
            )
        try:
            patch_path.write_text(text, encoding="utf-8")
            os.chmod(patch_path, 0o600)
        except OSError as exc:
            raise DshAcpSessionError(
                f"cannot write private ACP patch {patch_path}: {exc}"
            ) from exc

    def _index_path(self, index_dir: Path, session_id: str) -> Path:
        digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        return index_dir / f"{digest}.json"

    def _read_storage_key(self, index_dir: Path, session_id: str) -> str | None:
        path = self._index_path(index_dir, session_id)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        key = raw.get("storageKey") if isinstance(raw, Mapping) else None
        if not isinstance(key, str) or not _STORAGE_KEY_PATTERN.match(key):
            return None
        if key in (".", ".."):
            # Never let a poisoned index escape the controlled session tree.
            return None
        return key

    def _write_index(self) -> None:
        if self._workspace_dir is None or self._session_root is None:
            return
        session_id = self._session_id
        if session_id is None:
            return
        index_dir = self._ensure_private_dir(self._workspace_dir / "index")
        path = self._index_path(index_dir, session_id)
        payload = {
            "storageKey": self._session_root.name,
            "workspace": os.fspath(self._cwd),
        }
        try:
            path.write_text(
                json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            os.chmod(path, 0o600)
        except OSError as exc:
            raise DshAcpSessionError(
                f"cannot write ACP session storage index {path}: {exc}"
            ) from exc

    # -- emit ----------------------------------------------------------------

    def _emit(self, event: dict[str, Any]) -> bool:
        callback = self._emit_callback
        if callback is None:
            return False
        try:
            callback(event)
        except Exception:
            return False
        return True
