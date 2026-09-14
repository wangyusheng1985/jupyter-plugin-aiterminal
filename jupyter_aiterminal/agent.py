from __future__ import annotations

import asyncio
import json
import os
import shutil
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


try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, HookMatcher
except ImportError:  # pragma: no cover - exercised when the extra is missing
    ClaudeAgentOptions = None  # type: ignore[assignment]
    ClaudeSDKClient = None  # type: ignore[assignment]
    HookMatcher = None  # type: ignore[assignment]


class AgentSession:
    def __init__(self, cwd: str, emit: Emit):
        self.cwd = cwd
        self.emit = emit
        self.client = None
        self.model = ""
        self._running = False
        self._cli_stderr: list[str] = []

    async def start(self) -> None:
        try:
            config = load_agent_settings()
        except AgentConfigError as exc:
            await self.emit({"type": "error", "code": "config", "message": str(exc)})
            return
        if ClaudeSDKClient is None:
            await self.emit(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "claude-agent-sdk is not installed on this Jupyter server.",
                }
            )
            return
        self.model = config["ANTHROPIC_MODEL"]
        self._cli_stderr = []
        options = _build_options(
            **sdk_client_kwargs(
                config, self.cwd, self._pre_tool_use, self._cli_stderr
            )
        )
        try:
            self.client = ClaudeSDKClient(options)
            await self.client.connect()
        except Exception as exc:  # noqa: BLE001 - relay/CLI failures stay visible
            self.client = None
            await self.emit(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": format_sdk_error(exc, self._cli_stderr),
                }
            )
            return
        await self.emit(
            {
                "type": "ready",
                "sessionId": "default",
                "model": self.model,
                "cwd": self.cwd,
            }
        )

    async def query(self, text: str) -> None:
        prompt = text.strip()
        if not prompt:
            return
        if self.client is None:
            await self.start()
            if self.client is None:
                return
        if self._running:
            await self.emit(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "The agent is already running a turn.",
                }
            )
            return
        self._running = True
        try:
            await self.client.query(prompt)
            async for message in self.client.receive_response():
                for event in events_from_message(message):
                    await self.emit(event)
        except Exception as exc:  # noqa: BLE001 - surface SDK/relay failures
            await self.emit(
                {
                    "type": "error",
                    "code": "runtime",
                    "message": format_sdk_error(exc, self._cli_stderr),
                }
            )
        finally:
            self._running = False

    async def interrupt(self) -> None:
        if self.client is None:
            return
        interrupt = getattr(self.client, "interrupt", None)
        if interrupt is not None:
            await interrupt()

    async def close(self) -> None:
        client = self.client
        self.client = None
        if client is None:
            return
        disconnect = getattr(client, "disconnect", None)
        if disconnect is not None:
            await disconnect()

    async def _pre_tool_use(self, input_data, tool_use_id, context):
        del tool_use_id, context
        if input_data.get("tool_name") != "Bash":
            return {}
        command = str(input_data.get("tool_input", {}).get("command", ""))
        reason = forbidden_reason(command)
        if reason:
            await self.emit(
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
            await self.emit(
                {"type": "install", "command": display, "status": "started"}
            )
            try:
                detail = await _run_install(argv)
            except Exception as exc:  # noqa: BLE001
                await self.emit(
                    {
                        "type": "install",
                        "command": display,
                        "status": "failed",
                        "detail": str(exc),
                    }
                )
            else:
                await self.emit(
                    {
                        "type": "install",
                        "command": display,
                        "status": "ok",
                        "detail": detail,
                    }
                )
        return {}


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
        "extra_args": {"no-session-persistence": None},
        "hooks": {
            "PreToolUse": [HookMatcher(matcher="Bash", hooks=[pre_tool_use])]
            if HookMatcher is not None
            else []
        },
    }
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


def events_from_message(message: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    name = type(message).__name__
    content = getattr(message, "content", None)
    if isinstance(content, str) and content.strip():
        events.append({"type": "text", "text": content})
    for block in content if isinstance(content, list) else []:
        events.extend(_events_from_block(block))
    result_text = getattr(message, "result", None)
    if name == "ResultMessage" or result_text is not None:
        is_error = bool(getattr(message, "is_error", False))
        text = result_text if is_error and isinstance(result_text, str) else ""
        events.append(
            {
                "type": "result",
                "text": text,
                "isError": is_error,
            }
        )
    return events


def _events_from_block(block: Any) -> list[dict[str, Any]]:
    text = getattr(block, "text", None)
    block_name = getattr(block, "name", None)
    tool_input = getattr(block, "input", None)
    tool_use_id = getattr(block, "id", None) or getattr(block, "tool_use_id", None)
    if block_name and tool_input is not None:
        return [
            {
                "type": "tool_start",
                "id": str(tool_use_id or block_name),
                "name": str(block_name),
                "input": tool_input,
            }
        ]
    content = getattr(block, "content", None)
    if tool_use_id and content is not None and block_name is None:
        output = content if isinstance(content, str) else json.dumps(content)
        return [
            {
                "type": "tool_end",
                "id": str(tool_use_id),
                "name": str(getattr(block, "name", "") or ""),
                "output": output,
                "isError": bool(getattr(block, "is_error", False)),
            }
        ]
    if isinstance(text, str) and text:
        return [{"type": "text", "text": text}]
    return []
