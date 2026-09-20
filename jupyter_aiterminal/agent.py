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

from jupyter_core.paths import jupyter_config_dir

from .policy import forbidden_reason, install_argv, missing_binary
from .settings import AgentConfigError, load_agent_settings

Emit = Callable[[dict[str, Any]], Awaitable[None]]
ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
SYSTEM_PROMPT_APPEND = (
    "After a tool finishes, do not summarize, restate, reformat, or "
    "explain the tool output unless the user explicitly asked for a "
    "summary, explanation, or analysis. If they pasted a command or "
    "asked you to run something, execute it and stop. Do not add "
    "tables, recaps, or conclusions after Bash output."
)
CLI_PATH_PREFIX = (
    "/usr/local/bin",
    str(Path.home() / ".local" / "bin"),
)
STRIP_INHERITED_ENV = ("ANTHROPIC_AUTH_TOKEN",)
NOT_CONNECTED_MESSAGE = "Not connected. Call connect() first."


try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, HookMatcher
except ImportError:  # pragma: no cover - exercised when the extra is missing
    ClaudeAgentOptions = None  # type: ignore[assignment]
    ClaudeSDKClient = None  # type: ignore[assignment]
    HookMatcher = None  # type: ignore[assignment]


def _is_not_connected_error(exc: BaseException) -> bool:
    return (
        type(exc).__name__ == "CLIConnectionError"
        and str(exc).strip() == NOT_CONNECTED_MESSAGE
    )


def normalize_session_id(value: object) -> str | None:
    if not isinstance(value, str) or len(value) != 36:
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


class AgentSession:
    def __init__(self, cwd: str, emit: Emit, resume_session_id: str | None = None):
        self.cwd = cwd
        self.emit = emit
        self.session_id = resume_session_id or str(uuid.uuid4())
        self._resume_requested = resume_session_id is not None
        self.client: Any | None = None
        self.model = ""
        self._running = False
        self._cli_stderr: list[str] = []
        self._connect_lock = asyncio.Lock()
        self._closing = False
        self._active_turn_id: str | None = None
        self._tool_started_at: dict[str, float] = {}

    async def start(self) -> None:
        await self._ensure_client()

    async def _ensure_client(self):
        async with self._connect_lock:
            if self.client is not None:
                return self.client
            if self._closing:
                return None
            return await self._connect_unlocked()

    async def _connect_unlocked(self):
        try:
            config = load_agent_settings()
        except AgentConfigError as exc:
            await self._emit_event(
                {"type": "error", "code": "config", "message": str(exc)}
            )
            return None
        if ClaudeSDKClient is None:
            await self._emit_event(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "claude-agent-sdk is not installed on this Jupyter server.",
                }
            )
            return None
        self.model = config["ANTHROPIC_MODEL"]
        self._cli_stderr = []
        options = _build_options(
            **sdk_client_kwargs(
                config,
                self.cwd,
                self._pre_tool_use,
                self._cli_stderr,
                session_id=self.session_id,
                resume=self.session_id if self._resume_requested else None,
            )
        )
        client = None
        try:
            client = ClaudeSDKClient(options)
            await client.connect()
        except Exception as exc:  # noqa: BLE001 - relay/CLI failures stay visible
            await self._emit_event(
                {
                    "type": "error",
                    "code": "resume" if self._resume_requested else "runtime",
                    "message": format_sdk_error(exc, self._cli_stderr),
                }
            )
            return None
        if self._closing:
            disconnect = getattr(client, "disconnect", None)
            if disconnect is not None:
                await disconnect()
            return None
        self.client = client
        await self._emit_event(
            {
                "type": "ready",
                "sessionId": self.session_id,
                "contextState": "resumed" if self._resume_requested else "new",
                "model": self.model,
                "cwd": self.cwd,
            }
        )
        return client

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
        self._running = True
        self._active_turn_id = turn_id
        self._tool_started_at = {}
        try:
            client = await self._ensure_client()
            if client is None:
                return
            stale = False
            try:
                await client.query(prompt)
            except Exception as exc:  # noqa: BLE001 - retry only a stale client
                if not _is_not_connected_error(exc):
                    raise
                stale = True
            if stale:
                await self._discard_client(client)
                client = await self._ensure_client()
                if client is None:
                    return
                await client.query(prompt)
            await self._emit_event(
                {"type": "accepted", "sessionId": self.session_id}
            )
            async for message in client.receive_response():
                reported_session_id = normalize_session_id(
                    getattr(message, "session_id", None)
                )
                if reported_session_id:
                    self.session_id = reported_session_id
                    self._resume_requested = True
                for event in events_from_message(
                    message,
                    turn_id=turn_id,
                    tool_started_at=self._tool_started_at,
                ):
                    await self._emit_event(event)
        except Exception as exc:  # noqa: BLE001 - surface SDK/relay failures
            message = (
                "Agent connection is not available after reconnecting."
                if _is_not_connected_error(exc)
                else format_sdk_error(exc, self._cli_stderr)
            )
            await self._emit_event(
                {
                    "type": "error",
                    "code": "resume" if self._resume_requested else "runtime",
                    "message": message,
                }
            )
        finally:
            self._running = False
            self._active_turn_id = None
            self._tool_started_at = {}

    async def interrupt(self) -> None:
        if self.client is None:
            return
        interrupt = getattr(self.client, "interrupt", None)
        if interrupt is not None:
            await interrupt()

    async def close(self) -> None:
        self._closing = True
        async with self._connect_lock:
            client = self.client
            self.client = None
        if client is not None:
            disconnect = getattr(client, "disconnect", None)
            if disconnect is not None:
                await disconnect()

    async def _discard_client(self, client: Any) -> None:
        async with self._connect_lock:
            if self.client is client:
                self.client = None
        disconnect = getattr(client, "disconnect", None)
        if disconnect is not None:
            try:
                await disconnect()
            except Exception:  # noqa: BLE001 - stale clients are already unusable
                pass

    async def _pre_tool_use(self, input_data, tool_use_id, context):
        del tool_use_id, context
        if input_data.get("tool_name") != "Bash":
            return {}
        command = str(input_data.get("tool_input", {}).get("command", ""))
        reason = forbidden_reason(command)
        if reason:
            await self._emit_event(
                {"type": "denied", "command": command, "reason": reason}
            )
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        binary = missing_binary(command)
        argv = install_argv(binary) if binary else None
        if argv:
            display = " ".join(argv)
            await self._emit_event(
                {"type": "install", "command": display, "status": "started"}
            )
            try:
                detail = await _run_install(argv)
            except Exception as exc:  # noqa: BLE001
                await self._emit_event(
                    {
                        "type": "install",
                        "command": display,
                        "status": "failed",
                        "detail": str(exc),
                    }
                )
            else:
                await self._emit_event(
                    {
                        "type": "install",
                        "command": display,
                        "status": "ok",
                        "detail": detail,
                    }
                )
        return {}

    async def _emit_event(self, event: dict[str, Any]) -> None:
        if self._active_turn_id and event.get("type") != "ready":
            event = {**event, "turnId": self._active_turn_id}
        await self.emit(event)


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
            "PreToolUse": [HookMatcher(matcher="Bash", hooks=[pre_tool_use])]
            if HookMatcher is not None
            else []
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
    return len(text.splitlines())
