from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from jupyter_core.paths import jupyter_config_dir, jupyter_data_dir

from .dsh_acp_events import DshAcpEventProjector
from .dsh_acp_session import DshAcpSession, DshAcpSessionError
from .pi_client import PiProcessError
from .settings import AgentConfigError, load_dsh_settings

Emit = Callable[[dict[str, Any]], Awaitable[None]]

# Legacy tool names for backward compatibility with existing tests/references
ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
SYSTEM_PROMPT_APPEND = (
    "After a tool finishes, do not summarize, restate, reformat, or "
    "explain the tool output unless the user explicitly asked for a "
    "summary, explanation, or analysis. If they pasted a command or "
    "asked you to run something, execute it and stop. Do not add "
    "tables, recaps, or conclusions after Bash output."
)
CLI_PATH_PREFIX = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    str(Path.home() / ".local" / "bin"),
)
STRIP_INHERITED_ENV = ("ANTHROPIC_AUTH_TOKEN",)
NOT_CONNECTED_MESSAGE = "Not connected. Call connect() first."


# Legacy names kept importable for old tests. Production connect never uses them.
ClaudeAgentOptions = None  # type: ignore[assignment]
ClaudeSDKClient = None  # type: ignore[assignment]
HookMatcher = None  # type: ignore[assignment]


def _is_not_connected_error(exc: BaseException) -> bool:
    if type(exc).__name__ == "CLIConnectionError":
        return str(exc).strip() == NOT_CONNECTED_MESSAGE
    if isinstance(exc, PiProcessError) or type(exc).__name__ == "PiProcessError":
        msg = str(exc).strip()
        return msg == NOT_CONNECTED_MESSAGE or "not running" in msg
    return False


def normalize_session_id(value: object) -> str | None:
    if not isinstance(value, str) or len(value) != 36:
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


class AgentSession:
    """Legacy WebSocket session facade over one DSH ACP session.

    Construction and ``start`` never install or spawn Pi/Claude; the only
    runtime is the reviewed :class:`~jupyter_aiterminal.dsh_acp_session.DshAcpSession`.
    The old Pi/Claude helper functions below stay importable for compatibility,
    but production never calls them.
    """

    def __init__(self, cwd: str, emit: Emit, resume_session_id: str | None = None):
        self.cwd = cwd
        self.emit = emit
        self.session_id: str | None = None
        self.runtime_id: str | None = None
        self.model = ""
        self.storage_root = dsh_storage_root()
        self._resume_requested = resume_session_id is not None
        self._resume_session_id = resume_session_id
        self._acp: DshAcpSession | None = None
        self._config: Any | None = None
        self._token = ""
        self._start_lock = asyncio.Lock()
        self._emit_tasks: set[asyncio.Task[None]] = set()
        self._closed = False
        self._running = False
        self._active_turn_id: str | None = None
        self._projector: DshAcpEventProjector | None = None
        self._legacy_text: dict[str, str] = {}
        self._tool_names: dict[str, str] = {}
        # Pending approval scopes keyed by the ACP request id, so a future
        # handler can route a decision without reconstructing runtime identity.
        self._permission_scopes: dict[str, dict[str, str]] = {}

    async def start(self) -> None:
        await self._ensure_session()

    async def _ensure_session(self) -> DshAcpSession | None:
        # The lock serialises concurrent starts so only one ACP session is
        # created; every failure below emits an error and leaves ``_acp`` unset
        # so a later call can retry (e.g. after fixing Settings).
        async with self._start_lock:
            if self._acp is not None:
                return self._acp
            if self._closed:
                return None
            try:
                config = load_dsh_settings()
            except AgentConfigError as exc:
                await self._emit_event(
                    {"type": "error", "code": "config", "message": str(exc)}
                )
                return None
            except Exception:  # noqa: BLE001 - never echo raw settings payloads
                await self._emit_event(
                    {
                        "type": "error",
                        "code": "config",
                        "message": (
                            "AI Terminal provider settings could not be loaded."
                        ),
                    }
                )
                return None

            self._config = config
            self.model = config.model
            self._token = config.token
            root = self.storage_root
            try:
                root.mkdir(parents=True, exist_ok=True, mode=0o700)
                # Refuse a symlinked storage root before chmod follows it.
                if root.is_symlink():
                    raise OSError(
                        "agent storage directory must not be a symbolic link"
                    )
                os.chmod(root, 0o700)
            except OSError as exc:
                await self._emit_event(
                    {
                        "type": "error",
                        "code": "runtime",
                        "message": f"Agent storage directory is not usable: {exc}",
                    }
                )
                return None

            acp: DshAcpSession | None = None
            try:
                acp = DshAcpSession(
                    config=config,
                    cwd=self.cwd,
                    storage_root=root,
                    emit=self._on_acp_event,
                    on_notification=self._handle_notification,
                    resume_session_id=self._resume_session_id,
                )
                await acp.start()
            except DshAcpSessionError as exc:
                if acp is not None:
                    await self._close_quietly(acp)
                message = self._safe_message(exc)
                if self._resume_requested:
                    resume_error: dict[str, Any] = {
                        "type": "error",
                        "code": "resume",
                        "message": (
                            "Saved Agent context is unavailable; start a "
                            f"new context. ({message})"
                        ),
                    }
                    if self._resume_session_id:
                        # Keep the durable identity visible so a client never
                        # mistakes this failure for a fresh, silently replaced
                        # session.
                        resume_error["sessionId"] = self._resume_session_id
                    await self._emit_event(resume_error)
                else:
                    await self._emit_event(
                        {"type": "error", "code": "runtime", "message": message}
                    )
                return None
            except Exception as exc:  # noqa: BLE001 - surface safely
                if acp is not None:
                    await self._close_quietly(acp)
                await self._emit_event(
                    {
                        "type": "error",
                        "code": "runtime",
                        "message": self._safe_message(exc),
                    }
                )
                return None

            if self._closed:
                await self._close_quietly(acp)
                return None

            self._acp = acp
            self.session_id = acp.session_id
            self.runtime_id = acp.runtime_id
            await self._emit_event(
                {
                    "type": "ready",
                    "sessionId": self.session_id,
                    "contextState": "resumed" if self._resume_requested else "new",
                    "model": self.model,
                    "cwd": self.cwd,
                }
            )
            return acp

    # -- ACP event adapters --------------------------------------------------

    def _on_acp_event(self, event: dict[str, Any]) -> None:
        """Sync ACP emit callback: track permissions and schedule websocket emit."""
        event_type = event.get("type")
        if event_type == "dsh/v1/session":
            runtime_id = event.get("runtimeId")
            previous_runtime = self.runtime_id
            if (
                isinstance(runtime_id, str)
                and runtime_id
                and previous_runtime is not None
                and runtime_id != previous_runtime
            ):
                # Same websocket, new runtime generation (e.g. resuming after a
                # failed turn). The client only retires the old runtime on a
                # connection event and rejects a session handshake from a
                # different runtime, so this must be emitted first or every
                # later event for the new generation is dropped.
                self._schedule_emit(
                    {
                        "type": "dsh/v1/connection",
                        "runtimeId": runtime_id,
                        "phase": "reconnecting",
                    }
                )
        if event_type == "dsh/v1/interaction.requested":
            request_id = event.get("requestId")
            if isinstance(request_id, str) and request_id:
                self._permission_scopes[request_id] = {
                    "sessionId": str(event.get("sessionId", "")),
                    "runtimeId": str(event.get("runtimeId", "")),
                }
        elif event_type in {
            "dsh/v1/interaction.resolved",
            "dsh/v1/interaction.cancelled",
        }:
            request_id = event.get("requestId")
            if isinstance(request_id, str):
                self._permission_scopes.pop(request_id, None)
        self._schedule_emit(event)

    def _schedule_emit(self, event: dict[str, Any]) -> None:
        loop = asyncio.get_running_loop()
        task = loop.create_task(self._emit_event(event))
        self._emit_tasks.add(task)
        task.add_done_callback(self._on_emit_task_done)

    async def _handle_notification(self, message: dict[str, Any]) -> None:
        projector = self._projector
        if projector is None or not isinstance(message, dict):
            return
        for event in projector.project_notification(
            message.get("method"), message.get("params")
        ):
            await self._emit_product_event(event)

    async def _emit_product_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type in {"dsh/v1/text.snapshot", "dsh/v1/text.delta"}:
            message_id = str(event.get("messageId", ""))
            if event_type.endswith("snapshot"):
                text = str(event.get("text", ""))
            else:
                text = self._legacy_text.get(message_id, "") + str(
                    event.get("delta", "")
                )
            self._legacy_text[message_id] = text
            await self._emit_event(event)
            await self._emit_event(
                {"type": "text", "text": text, "messageId": message_id}
            )
            return
        if event_type == "dsh/v1/activity":
            activity_id = str(event.get("activityId", ""))
            if event.get("label") == "thinking":
                # Thinking shares the activity envelope but projects onto the
                # legacy thinking event so the transcript can render it
                # alongside text instead of as a tool card. The projector's
                # phase drives the legacy state: started/updated stream as
                # ``started`` (Thinking/Running) and finished as ``finished``
                # (Thought/Completed).
                phase = event.get("phase")
                state = "finished" if phase == "finished" else "started"
                await self._emit_event(event)
                await self._emit_event(
                    {
                        "type": "thinking",
                        "id": activity_id,
                        "state": state,
                        "text": str(event.get("outputSummary") or ""),
                    }
                )
                return
            tool_name = event.get("toolName")
            if isinstance(tool_name, str) and tool_name:
                self._tool_names[activity_id] = tool_name
            await self._emit_event(event)
            phase = event.get("phase")
            if phase == "started":
                raw_input = event.get("rawInput")
                await self._emit_event(
                    {
                        "type": "tool_start",
                        "id": activity_id,
                        "name": self._tool_names.get(activity_id, ""),
                        "input": raw_input if raw_input is not None else {},
                        "startedAt": round(time.time() * 1000),
                    }
                )
            elif phase == "finished":
                output = str(event.get("outputSummary") or "")
                await self._emit_event(
                    {
                        "type": "tool_end",
                        "id": activity_id,
                        "name": self._tool_names.get(activity_id, ""),
                        "output": output,
                        "isError": event.get("status") == "error",
                        "lineCount": _line_count(output),
                        "byteCount": len(output.encode("utf-8")),
                    }
                )
            return
        await self._emit_event(event)

    # -- prompt and cancel ---------------------------------------------------

    async def query(self, text: str, turn_id: str | None = None) -> None:
        prompt = text.strip()
        if not prompt:
            return
        if self._running:
            await self._emit_event(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "The agent is already running a turn.",
                }
            )
            return

        acp = await self._ensure_session()
        if acp is None:
            return
        session_id = acp.session_id
        runtime_id = acp.runtime_id
        if not session_id or not runtime_id:
            await self._emit_event(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "Agent runtime did not report a session identity.",
                }
            )
            return

        self._running = True
        self._active_turn_id = turn_id
        run_id = turn_id or f"turn-{uuid.uuid4().hex}"
        projector = DshAcpEventProjector(session_id, runtime_id, run_id)
        self._projector = projector
        self._legacy_text = {}
        self._tool_names = {}
        try:
            await self._emit_event({"type": "accepted", "sessionId": session_id})
            for event in projector.begin():
                await self._emit_product_event(event)
            result = await acp.prompt(prompt, run_id)
            terminal = projector.finish(result)
            for event in terminal:
                await self._emit_product_event(event)
            status = terminal[0].get("status") if terminal else "failed"
            await self._emit_event(
                {
                    "type": "result",
                    "text": "",
                    "isError": status != "completed",
                    "sessionId": session_id,
                }
            )
        except asyncio.CancelledError:
            for event in projector.finish_error(None):
                await self._emit_product_event(event)
            raise
        except DshAcpSessionError as exc:
            for event in projector.finish_error(exc):
                await self._emit_product_event(event)
            await self._emit_event(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": self._safe_message(exc),
                }
            )
            await self._discard_session(acp)
        except Exception as exc:  # noqa: BLE001 - surface safely
            for event in projector.finish_error(exc):
                await self._emit_product_event(event)
            await self._emit_event(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": self._safe_message(exc),
                }
            )
            await self._discard_session(acp)
        finally:
            self._running = False
            self._active_turn_id = None
            self._projector = None
            self._legacy_text = {}
            self._tool_names = {}

    async def interrupt(self) -> None:
        acp = self._acp
        if acp is None:
            return
        try:
            await acp.cancel()
        except Exception as exc:  # noqa: BLE001 - transport errors must reach user
            message = self._safe_message(exc)
            if "not running" in message:
                return
            await self._emit_event(
                {"type": "error", "code": "runtime", "message": message}
            )

    async def resolve_permission(
        self,
        request_id: str,
        decision: str,
        scope: dict[str, str] | None = None,
    ) -> bool:
        """Route a pending approval to the ACP session. Never approves by default."""
        acp = self._acp
        if acp is None:
            raise DshAcpSessionError("ACP session is not running")
        resolved_scope = scope or self._permission_scopes.get(request_id)
        if resolved_scope is None:
            raise DshAcpSessionError(
                f"no pending permission request {request_id!r}"
            )
        return await acp.resolve_permission(request_id, decision, resolved_scope)

    async def close(self) -> None:
        self._closed = True
        acp = self._acp
        self._acp = None
        if acp is not None:
            await acp.close()
        for task in list(self._emit_tasks):
            task.cancel()
        self._emit_tasks.clear()

    # -- helpers -------------------------------------------------------------

    def _safe_message(self, exc: BaseException) -> str:
        message = str(exc).strip() or type(exc).__name__
        if self._token:
            message = message.replace(self._token, "[redacted]")
        return message

    async def _close_quietly(self, acp: DshAcpSession) -> None:
        try:
            await acp.close()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass

    async def _discard_session(self, acp: DshAcpSession) -> None:
        if self._acp is acp:
            self._acp = None
        session_id = acp.session_id
        if session_id:
            # Preserve the durable identity across a failed turn. The next
            # turn must resume this session on a fresh runtime; silently
            # opening a new session would be rejected by the browser (which
            # refuses session/runtime changes) and would orphan approvals.
            self._resume_session_id = session_id
            self._resume_requested = True
        await self._close_quietly(acp)
        if not session_id:
            # Nothing durable survived this runtime: say so explicitly instead
            # of letting the next turn open a new session unannounced.
            await self._emit_event(
                {
                    "type": "error",
                    "code": "resume",
                    "message": (
                        "Agent context could not be preserved; start a new "
                        "context before continuing."
                    ),
                }
            )

    def _on_emit_task_done(self, task: asyncio.Task[None]) -> None:
        self._emit_tasks.discard(task)
        if not task.cancelled():
            task.exception()  # consume so a dead websocket never leaks a warning

    async def _emit_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type", ""))
        if (
            self._active_turn_id
            and event_type != "ready"
            and not event_type.startswith("dsh/")
        ):
            event = {**event, "turnId": self._active_turn_id}
        await self.emit(event)


def dsh_storage_root() -> Path:
    """Server-owned private ACP storage root; clients cannot choose it."""
    override = os.environ.get("JUPYTER_DATA_DIR")
    if override:
        base = Path(override).expanduser()
    else:
        base = Path(jupyter_data_dir())
    if not base.is_absolute():
        base = Path(os.path.abspath(base))
    return base / "aiterminal" / "dsh"


def claude_home_dir() -> str:
    override = os.environ.get("AITERMINAL_CLAUDE_HOME")
    if override:
        return override
    return str(Path(jupyter_config_dir()) / "jupyter-aiterminal" / "claude-home")


def resolve_cli_path() -> str | None:
    found = shutil.which("claude")
    if found:
        return found
    for directory in CLI_PATH_PREFIX:
        candidate = os.path.join(directory, "claude")
        if os.path.isfile(candidate):
            return candidate
    return None


def sdk_environment(config: dict[str, str]) -> dict[str, str]:
    env = {**os.environ, **config}
    for key in STRIP_INHERITED_ENV:
        env.pop(key, None)
    env["IS_SANDBOX"] = "1"
    env["CLAUDE_CODE_DISABLE_TERMINAL_TITLE"] = "1"
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    home = claude_home_dir()
    os.makedirs(home, exist_ok=True)
    env["CLAUDE_CONFIG_DIR"] = home
    path_parts = [part for part in env.get("PATH", "").split(":") if part]
    for extra in reversed(CLI_PATH_PREFIX):
        if extra not in path_parts:
            path_parts.insert(0, extra)
    env["PATH"] = ":".join(path_parts)
    return env


def sdk_client_kwargs(
    config: dict[str, str],
    cwd: str,
    pre_tool_use,
    stderr_lines: list[str] | None = None,
    *,
    session_id: str | None = None,
    resume: str | None = None,
) -> dict[str, Any]:
    """Legacy unused helper. Production connect does not build Claude options."""
    kwargs: dict[str, Any] = {
        "allowed_tools": ALLOWED_TOOLS,
        "system_prompt": {
            "type": "preset",
            "preset": "claude_code",
            "append": SYSTEM_PROMPT_APPEND,
        },
        "permission_mode": "bypassPermissions",
        "cwd": cwd,
        "model": config["ANTHROPIC_MODEL"],
        "env": sdk_environment(config),
        # Ignore ~/.claude/settings.json so Jupyter Settings are the only source.
        "setting_sources": [],
        "hooks": {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [pre_tool_use]}
            ]
        },
    }
    if resume:
        kwargs["resume"] = resume
    elif session_id:
        kwargs["session_id"] = session_id
    cli_path = resolve_cli_path()
    if cli_path:
        kwargs["cli_path"] = cli_path
    if stderr_lines is not None:
        kwargs["stderr"] = stderr_lines.append
    return kwargs


def format_sdk_error(
    exc: BaseException, extra_stderr: list[str] | None = None
) -> str:
    parts = [str(exc).strip()]
    for attr in ("stderr", "stdout"):
        value = getattr(exc, attr, None)
        if value:
            text = str(value).strip()
            if text and text not in parts:
                parts.append(text)
    if extra_stderr:
        joined = "\n".join(line.strip() for line in extra_stderr if line.strip())
        if joined and joined not in parts:
            parts.append(joined)
    cause = exc.__cause__ or exc.__context__
    if cause:
        nested = format_sdk_error(cause)
        if nested and nested not in parts:
            parts.append(nested)
    return "\n".join(part for part in parts if part) or type(exc).__name__


def _build_options(**kwargs):
    env = kwargs.get("env") or {}
    optional = (
        "extra_args",
        "setting_sources",
        "system_prompt",
        "cli_path",
        "hooks",
        "stderr",
        "env",
    )
    while True:
        try:
            return ClaudeAgentOptions(**kwargs)
        except TypeError:
            dropped = False
            for key in optional:
                if key not in kwargs:
                    continue
                if key == "env":
                    for env_key in (
                        "ANTHROPIC_BASE_URL",
                        "ANTHROPIC_API_KEY",
                        "ANTHROPIC_MODEL",
                        "ANTHROPIC_DEFAULT_SONNET_MODEL",
                        "ANTHROPIC_DEFAULT_OPUS_MODEL",
                        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                        "CLAUDE_CODE_SUBAGENT_MODEL",
                        "CLAUDE_CONFIG_DIR",
                        "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
                        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
                        "IS_SANDBOX",
                        "PATH",
                    ):
                        value = env.get(env_key)
                        if value:
                            os.environ[env_key] = str(value)
                kwargs.pop(key)
                dropped = True
                break
            if not dropped:
                raise


async def _run_install(argv: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await proc.communicate()
    text = output.decode("utf-8", errors="replace")
    if proc.returncode:
        raise RuntimeError(text or f"install failed with code {proc.returncode}")
    return text


def events_from_message(
    message: Any,
    turn_id: str | None = None,
    tool_started_at: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    name = type(message).__name__
    content = getattr(message, "content", None)
    message_id = (
        getattr(message, "message_id", None)
        or getattr(message, "uuid", None)
        or f"{name}:{id(message):x}"
    )
    starts = tool_started_at if tool_started_at is not None else {}
    if isinstance(content, str) and content.strip():
        events.append(
            {
                "type": "text",
                "text": content,
                "messageId": str(message_id),
            }
        )
    for index, block in enumerate(content if isinstance(content, list) else []):
        events.extend(
            _events_from_block(
                block,
                message_id=str(message_id),
                block_index=index,
                tool_started_at=starts,
            )
        )
    result_text = getattr(message, "result", None)
    if name == "ResultMessage" or result_text is not None:
        is_error = bool(getattr(message, "is_error", False))
        text = result_text if isinstance(result_text, str) else ""
        events.append(
            {
                "type": "result",
                "text": text,
                "isError": is_error,
                "durationMs": _optional_int(message, "duration_ms"),
                "apiDurationMs": _optional_int(message, "duration_api_ms"),
                "numTurns": _optional_int(message, "num_turns"),
                "costUsd": _optional_number(message, "total_cost_usd"),
                "usage": _optional_mapping(message, "usage"),
                "errors": _optional_string_list(message, "errors"),
                "permissionDenials": _optional_list(
                    message, "permission_denials"
                ),
                **(
                    {"sessionId": session_id}
                    if (
                        session_id := normalize_session_id(
                            getattr(message, "session_id", None)
                        )
                    )
                    else {}
                ),
            }
        )
    if turn_id:
        return [{**event, "turnId": turn_id} for event in events]
    return events


def _events_from_block(
    block: Any,
    *,
    message_id: str,
    block_index: int,
    tool_started_at: dict[str, float],
) -> list[dict[str, Any]]:
    text = getattr(block, "text", None)
    thinking = getattr(block, "thinking", None)
    block_name = getattr(block, "name", None)
    tool_input = getattr(block, "input", None)
    tool_use_id = getattr(block, "id", None) or getattr(block, "tool_use_id", None)
    if block_name and tool_input is not None:
        tool_id = str(tool_use_id or f"{message_id}:{block_index}")
        tool_started_at[tool_id] = time.perf_counter()
        return [
            {
                "type": "tool_start",
                "id": tool_id,
                "name": str(block_name),
                "input": tool_input,
                "startedAt": round(time.time() * 1000),
            }
        ]
    content = getattr(block, "content", None)
    if tool_use_id and content is not None and block_name is None:
        output = content if isinstance(content, str) else json.dumps(content)
        tool_id = str(tool_use_id)
        started = tool_started_at.pop(tool_id, None)
        return [
            {
                "type": "tool_end",
                "id": tool_id,
                "name": str(getattr(block, "name", "") or ""),
                "output": output,
                "isError": bool(getattr(block, "is_error", False)),
                "lineCount": _line_count(output),
                "byteCount": len(output.encode("utf-8")),
                **(
                    {}
                    if started is None
                    else {"durationMs": round((time.perf_counter() - started) * 1000)}
                ),
            }
        ]
    if isinstance(text, str) and text:
        return [{"type": "text", "text": text, "messageId": message_id}]
    if isinstance(thinking, str):
        return [
            {
                "type": "thinking",
                "id": f"{message_id}:{block_index}",
                "state": "finished",
                "text": thinking,
            }
        ]
    return []


def _optional_int(message: Any, attribute: str) -> int | None:
    value = getattr(message, attribute, None)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _optional_number(message: Any, attribute: str) -> float | None:
    value = getattr(message, attribute, None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _optional_mapping(message: Any, attribute: str) -> dict[str, Any] | None:
    value = getattr(message, attribute, None)
    return value if isinstance(value, dict) else None


def _optional_string_list(message: Any, attribute: str) -> list[str] | None:
    value = getattr(message, attribute, None)
    if not isinstance(value, list):
        return None
    return [item for item in value if isinstance(item, str)]


def _optional_list(message: Any, attribute: str) -> list[Any] | None:
    value = getattr(message, attribute, None)
    return value if isinstance(value, list) else None


def _line_count(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (1 if not text.endswith("\n") else 0)
