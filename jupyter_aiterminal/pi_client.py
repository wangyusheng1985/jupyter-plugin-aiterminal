from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from jupyter_core.paths import jupyter_config_dir

from .policy import FORBIDDEN_REASON
from .settings import AgentConfigError, load_agent_settings

PI_CLI_PATH_PREFIX = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    str(Path.home() / ".local" / "bin"),
)

PI_ALLOWED_TOOLS = "read,bash,edit,write,grep,find,ls"


class PiProcessError(Exception):
    """Raised when the Pi subprocess fails to start or exits unexpectedly."""


def resolve_pi_cli_path() -> str | None:
    found = shutil.which("pi")
    if found:
        return found
    for directory in PI_CLI_PATH_PREFIX:
        candidate = os.path.join(directory, "pi")
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def pi_agent_dir() -> Path:
    override = os.environ.get("PI_CODING_AGENT_DIR")
    if override:
        return Path(override)
    return Path(jupyter_config_dir()) / "jupyter-aiterminal" / "pi-agent"


def pi_sessions_dir() -> Path:
    override = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
    if override:
        return Path(override)
    return pi_agent_dir() / "sessions"


def get_project_session_dir(cwd: str | Path, base_dir: Path | None = None) -> Path:
    """Computes the isolated project session directory for a given cwd according to Pi CLI conventions."""
    resolved_cwd = str(Path(cwd).resolve())
    root_dir = base_dir or pi_agent_dir()
    sanitized_cwd = resolved_cwd.lstrip("/").replace("/", "-").replace("\\", "-").replace(":", "-")
    safe_path = f"--{sanitized_cwd}--"
    return root_dir / "sessions" / safe_path


def find_session_file_for_cwd(session_id: str, cwd: str | Path, base_dir: Path | None = None) -> Path | None:
    """Finds an existing session JSONL file belonging specifically to the given cwd project."""
    import re

    # Session ID must be a valid alphanumeric/hyphen/underscore identifier
    if not session_id or not re.fullmatch(r"[A-Za-z0-9._-]+", session_id):
        return None

    project_dir = get_project_session_dir(cwd, base_dir=base_dir)
    if not project_dir.is_dir():
        return None

    # Search project session files
    for entry in project_dir.glob("*.jsonl"):
        # Pi format is <timestamp>_<session-id>.jsonl or <session-id>.jsonl
        stem = entry.stem
        file_sid = stem.split("_")[-1] if "_" in stem else stem
        if file_sid == session_id:
            return entry
    return None


def ensure_pi_agent_environment(config: dict[str, str]) -> dict[str, str]:
    """Prepares an isolated Pi agent directory with models.json configuring

    the model endpoint from JupyterLab user settings without leaking or inheriting
    host credentials or global extensions.
    """
    agent_dir = pi_agent_dir()
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "extensions").mkdir(parents=True, exist_ok=True)
    (agent_dir / "sessions").mkdir(parents=True, exist_ok=True)

    # Empty or clean settings.json to prevent host-level extension/package loading
    settings_file = agent_dir / "settings.json"
    if not settings_file.is_file():
        settings_file.write_text(json.dumps({"packages": []}, indent=2), encoding="utf-8")

    # Generate isolated models.json pointing to the Anthropic/compatible proxy
    base_url = config.get("ANTHROPIC_BASE_URL", "").rstrip("/")
    model_id = config.get("ANTHROPIC_MODEL", "")
    api_key = config.get("ANTHROPIC_API_KEY", "")

    models_content = {
        "$schema": "https://pi.dev/schemas/models.schema.json",
        "providers": {
            "anthropic": {
                "baseUrl": base_url,
                "api": "anthropic-messages",
                "apiKey": api_key,
                "models": [
                    {
                        "id": model_id,
                        "name": model_id,
                        "input": ["text", "image"],
                    }
                ],
            }
        },
    }
    (agent_dir / "models.json").write_text(json.dumps(models_content, indent=2), encoding="utf-8")

    bridge_ext_path = agent_dir / "extensions" / "bridge_policy.ts"
    write_bridge_policy_extension(bridge_ext_path)

    env = {**os.environ}
    # Isolate Pi configuration & session directories
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    env["PI_CODING_AGENT_SESSION_DIR"] = str(agent_dir / "sessions")
    env["PI_SKIP_VERSION_CHECK"] = "1"
    env["PI_TELEMETRY"] = "0"

    # Add CLI search paths to PATH
    path_parts = [part for part in env.get("PATH", "").split(":") if part]
    for extra in reversed(PI_CLI_PATH_PREFIX):
        if extra not in path_parts:
            path_parts.insert(0, extra)
    env["PATH"] = ":".join(path_parts)

    return env


def bridge_policy_extension_source() -> str:
    """TypeScript extension source: tool_call blocks forbidden bash before execution.

    Mirrors jupyter_aiterminal.policy.forbidden_reason (apt/apt-get/yum/dnf and
    curl|sh / wget|sh). The regex is exercised by tests via Node without a model.
    """
    reason = json.dumps(FORBIDDEN_REASON)
    # [^\n] is written as [^\\n] in the file so the regex stays one source line.
    return f"""
export const forbiddenRegex = /(?:^|[;&|]\\s*|\\s)(?:sudo\\s+)?(?:apt-get|apt|yum|dnf)\\b|curl\\s+[^|\\n]*\\|\\s*(?:ba)?sh|wget\\s+[^|\\n]*\\|\\s*(?:ba)?sh/i;

export function bridgePolicyDecision(toolName: string, input: {{ command?: unknown }} | undefined) {{
  if (toolName !== "bash") return undefined;
  const command = String((input && input.command) || "");
  if (forbiddenRegex.test(command)) {{
    return {{ block: true, reason: {reason} }};
  }}
  return undefined;
}}

export default function (pi: {{ on: (event: string, handler: (event: any) => Promise<unknown>) => void }}) {{
  pi.on("tool_call", async (event) => {{
    return bridgePolicyDecision(event.toolName, event.input);
  }});
}}
""".lstrip()


def write_bridge_policy_extension(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(bridge_policy_extension_source(), encoding="utf-8")


def evaluate_bridge_policy_cases(source: str, cases: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Load the generated extension in Node and run tool_call decisions.

    Uses Node's type-stripping loader (no model, no extra packages). A syntax or
    export failure raises PiProcessError so policy load stays fail-closed.
    """
    import subprocess
    import tempfile

    node = shutil.which("node")
    if not node:
        raise PiProcessError("node is required to validate the bridge policy extension")
    payload = json.dumps(cases)
    runner = f"""
import {{ bridgePolicyDecision }} from "./bridge_policy.ts";
const cases = {payload};
const results = cases.map((item) => ({{
  name: item.name,
  decision: bridgePolicyDecision(item.toolName, {{ command: item.command }}) ?? null,
}}));
process.stdout.write(JSON.stringify(results));
"""
    with tempfile.TemporaryDirectory(prefix="bridge-policy-") as tmp:
        root = Path(tmp)
        (root / "bridge_policy.ts").write_text(source, encoding="utf-8")
        script_path = root / "check-policy.mjs"
        script_path.write_text(runner, encoding="utf-8")
        completed = subprocess.run(
            [node, "--experimental-strip-types", str(script_path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise PiProcessError(f"Bridge policy extension failed to load: {detail}")
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise PiProcessError("Bridge policy extension returned invalid decision output") from exc
    if not isinstance(parsed, list):
        raise PiProcessError("Bridge policy extension returned invalid decision output")
    return parsed


class PiRpcClient:
    """Manages a long-lived `pi --mode rpc` child process via asyncio pipes.

    Framing strictly obeys JSONL (LF delimiter, strip CR, never split on Unicode line separators).
    """

    def __init__(
        self,
        cwd: str,
        env: dict[str, str],
        model: str,
        session_id: str | None = None,
        resume: bool = False,
        append_system_prompt: str | None = None,
        on_event: Callable[[dict[str, Any]], Any] | None = None,
    ):
        self.cwd = cwd
        self.env = env
        self.model = model
        self.session_id = session_id
        self.resume = resume
        self.append_system_prompt = append_system_prompt
        self.on_event = on_event

        self.process: asyncio.subprocess.Process | None = None
        self._pending_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._request_counter = 0
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self.stderr_lines: list[str] = []
        self._closing = False
        self._exit_error: Exception | None = None

    async def start(self) -> None:
        cli_path = resolve_pi_cli_path()
        if not cli_path:
            raise PiProcessError("The 'pi' CLI executable was not found on PATH or standard locations.")

        args = [
            cli_path,
            "--mode",
            "rpc",
            "--provider",
            "anthropic",
            "--model",
            self.model,
            "--tools",
            PI_ALLOWED_TOOLS,
            # Discovery off; explicit -e still loads (pi --help / cli.md).
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
        ]
        if self.session_id:
            import re
            # Prevent path traversal or shell injection in session_id
            if not re.fullmatch(r"[A-Za-z0-9._-]+", self.session_id):
                raise PiProcessError(f"Invalid session id format: {self.session_id!r}")

        bridge_ext = pi_agent_dir() / "extensions" / "bridge_policy.ts"
        # Fail closed: never start RPC without the pre-execution policy extension.
        if not bridge_ext.is_file() or bridge_ext.stat().st_size == 0:
            raise PiProcessError(
                f"Bridge policy extension is missing or empty: {bridge_ext}. Refusing to start without tool_call blocking."
            )
        args.extend(["--extension", str(bridge_ext)])

        if self.append_system_prompt:
            args.extend(["--append-system-prompt", self.append_system_prompt])

        if self.session_id:
            if self.resume:
                # Disallow cross-directory session hijacking or fallback to continueRecent.
                # Must point to an existing session for this exact cwd or resolve to exact session file.
                session_file = find_session_file_for_cwd(self.session_id, self.cwd)
                if not session_file:
                    raise PiProcessError(f"Cannot resume session '{self.session_id}': session does not exist in workspace '{self.cwd}'.")
                args.extend(["--session", str(session_file)])
            else:
                args.extend(["--session-id", self.session_id])
        else:
            args.append("--no-session")

        try:
            self.process = await asyncio.create_subprocess_exec(
                *args,
                cwd=self.cwd,
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as exc:
            raise PiProcessError(f"Failed to spawn pi subprocess: {exc}") from exc

        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

        # Give the process a brief moment to catch immediate startup crashes
        await asyncio.sleep(0.05)
        if self.process.returncode is not None:
            stderr_snippet = "\n".join(self.stderr_lines)
            raise PiProcessError(
                f"Pi subprocess exited immediately with code {self.process.returncode}. Stderr: {stderr_snippet}"
            )

    async def _read_stdout(self) -> None:
        assert self.process is not None
        assert self.process.stdout is not None
        stdout = self.process.stdout

        while not self._closing:
            try:
                line_bytes = await stdout.readline()
            except Exception as exc:
                self._handle_exit(exc)
                break
            if not line_bytes:
                # EOF reached
                self._handle_exit(None)
                break

            # Strip LF and optional CR
            line = line_bytes.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                continue

            try:
                record = json.loads(line)
            except Exception:
                continue

            if not isinstance(record, dict):
                continue

            rec_type = record.get("type")
            rec_id = record.get("id")

            if rec_type == "response" and rec_id and rec_id in self._pending_requests:
                fut = self._pending_requests.pop(rec_id)
                if not fut.done():
                    fut.set_result(record)
                continue

            if self.on_event:
                try:
                    res = self.on_event(record)
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass

    async def _read_stderr(self) -> None:
        assert self.process is not None
        assert self.process.stderr is not None
        stderr = self.process.stderr

        while not self._closing:
            try:
                line_bytes = await stderr.readline()
            except Exception:
                break
            if not line_bytes:
                break
            text = line_bytes.decode("utf-8", errors="replace").rstrip("\r\n")
            if text:
                self.stderr_lines.append(text)
                if len(self.stderr_lines) > 200:
                    self.stderr_lines.pop(0)

    def _handle_exit(self, exc: Exception | None) -> None:
        if self._closing:
            return
        code = self.process.returncode if self.process else None
        stderr_msg = "\n".join(self.stderr_lines[-10:])
        err_msg = f"Pi process terminated (code={code}). Stderr: {stderr_msg}"
        if exc:
            err_msg += f" (Exception: {exc})"
        self._exit_error = PiProcessError(err_msg)

        # Reject all pending requests
        for fut in self._pending_requests.values():
            if not fut.done():
                fut.set_exception(self._exit_error)
        self._pending_requests.clear()

    async def send_command(self, command: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None or self.process.returncode is not None:
            raise PiProcessError("Pi RPC process is not running.")
        if self._exit_error:
            raise self._exit_error

        self._request_counter += 1
        req_id = command.get("id") or f"req_{self._request_counter}"
        payload = {**command, "id": req_id}

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending_requests[req_id] = fut

        line = json.dumps(payload, ensure_ascii=False) + "\n"
        try:
            self.process.stdin.write(line.encode("utf-8"))
            await self.process.stdin.drain()
        except Exception as exc:
            self._pending_requests.pop(req_id, None)
            raise PiProcessError(f"Failed to write command to Pi stdin: {exc}") from exc

        try:
            response = await asyncio.wait_for(fut, timeout=timeout)
            return response
        except asyncio.TimeoutError:
            self._pending_requests.pop(req_id, None)
            raise TimeoutError(f"Timeout waiting for response to {command.get('type')}")

    async def get_state(self) -> dict[str, Any]:
        resp = await self.send_command({"type": "get_state"})
        if not resp.get("success"):
            raise PiProcessError(resp.get("error", "Failed to get state"))
        return resp.get("data", {})

    async def prompt(self, message: str, streaming_behavior: str | None = None) -> dict[str, Any]:
        cmd: dict[str, Any] = {"type": "prompt", "message": message}
        if streaming_behavior:
            cmd["streamingBehavior"] = streaming_behavior
        resp = await self.send_command(cmd)
        if not resp.get("success"):
            raise PiProcessError(resp.get("error", "Prompt failed"))
        return resp.get("data", {})

    async def interrupt(self) -> None:
        if self.process is None or self.process.stdin is None or self.process.returncode is not None:
            return
        try:
            await self.send_command({"type": "abort"}, timeout=10.0)
        except Exception:
            pass

    async def close(self) -> None:
        self._closing = True
        for fut in self._pending_requests.values():
            if not fut.done():
                fut.cancel()
        self._pending_requests.clear()

        if self.process is not None:
            if self.process.stdin is not None and not self.process.stdin.is_closing():
                try:
                    self.process.stdin.close()
                    await self.process.stdin.wait_closed()
                except Exception:
                    pass
            if self.process.returncode is None:
                try:
                    self.process.terminate()
                    await asyncio.wait_for(self.process.wait(), timeout=2.0)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass
            self.process = None

        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None
        if self._stderr_task:
            self._stderr_task.cancel()
            self._stderr_task = None
