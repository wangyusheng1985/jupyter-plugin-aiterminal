from __future__ import annotations

import json
import os

from jupyter_core.utils import ensure_async
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web, websocket
from tornado.ioloop import IOLoop

from .agent import AgentSession, normalize_session_id
from .history_bridge import compose_bridged_prompt, validate_history_bridge
from .shell import PersistentShell


class AgentWebSocketHandler(JupyterHandler, websocket.WebSocketHandler):
    auth_resource = "aiterminal_agent"

    def initialize(self, cwd: str = "."):
        self.cwd = cwd
        self.session: AgentSession | None = None
        self.shell: PersistentShell | None = None
        self._exec_running = False

    async def pre_get(self):
        user = self.current_user
        if user is None:
            raise web.HTTPError(403)

    @ws_authenticated
    async def get(self, *args, **kwargs):
        await ensure_async(self.pre_get())
        result = super().get(*args, **kwargs)
        if result is not None:
            await result

    def set_default_headers(self):
        pass

    def open(self, *args, **kwargs):
        requested = self.get_query_argument("cwd", default="")
        requested_session = self.get_query_argument("sessionId", default="")
        cwd = _resolve_workspace_cwd(self.cwd, requested)
        if cwd is None:
            IOLoop.current().spawn_callback(
                self.emit,
                {
                    "type": "error",
                    "code": "denied",
                    "message": "Workspace path is outside the Jupyter server root.",
                },
            )
            return
        try:
            resume_session_id = _parse_resume_session_id(requested_session)
        except ValueError:
            IOLoop.current().spawn_callback(
                self.emit,
                {
                    "type": "error",
                    "code": "resume",
                    "message": "Saved Agent context identifier is invalid.",
                },
            )
            return
        self.session = AgentSession(cwd, self.emit, resume_session_id)
        self.shell = PersistentShell(cwd)
        IOLoop.current().spawn_callback(self.session.start)
        IOLoop.current().spawn_callback(self._start_shell)

    async def emit(self, event: dict) -> None:
        if self.ws_connection is None:
            return
        self.write_message(json.dumps(event))

    def on_message(self, message):
        if isinstance(message, bytes):
            message = message.decode("utf-8")
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            IOLoop.current().spawn_callback(
                self.emit,
                {
                    "type": "error",
                    "code": "runtime",
                    "message": "Invalid agent message.",
                },
            )
            return
        kind = payload.get("type")
        if kind == "user":
            if self.session is None:
                return
            turn_id = str(payload.get("turnId", "")) or None
            prompt = str(payload.get("text", ""))
            if "historyBridge" in payload:
                try:
                    bridge = validate_history_bridge(payload.get("historyBridge"))
                    prompt = compose_bridged_prompt(prompt, bridge)
                except ValueError as exc:
                    event = {
                        "type": "error",
                        "code": "context",
                        "message": str(exc),
                    }
                    if turn_id:
                        event["turnId"] = turn_id
                    IOLoop.current().spawn_callback(self.emit, event)
                    return
            IOLoop.current().spawn_callback(
                self.session.query,
                prompt,
                turn_id,
            )
        elif kind == "interrupt":
            if self.session is None:
                return
            IOLoop.current().spawn_callback(self.session.interrupt)
        elif kind == "exec":
            IOLoop.current().spawn_callback(
                self._exec, str(payload.get("text", ""))
            )
        elif kind == "exec_interrupt":
            IOLoop.current().spawn_callback(self._exec_interrupt)

    async def _start_shell(self) -> None:
        if self.shell is None:
            return
        try:
            await self.shell.start()
        except Exception as exc:  # noqa: BLE001 - first exec can retry
            await self.emit(
                {
                    "type": "exec_error",
                    "message": f"Command shell failed to start: {exc}",
                }
            )

    async def _exec(self, command: str) -> None:
        if self.shell is None:
            await self.emit(
                {
                    "type": "exec_error",
                    "message": "Command shell is not running.",
                }
            )
            return
        if self._exec_running:
            await self.emit(
                {
                    "type": "exec_error",
                    "message": "A command is already running.",
                }
            )
            return
        self._exec_running = True

        async def on_output(text: str) -> None:
            if text:
                await self.emit({"type": "exec_output", "text": text})

        try:
            result = await self.shell.run(command, on_output=on_output)
        except Exception as exc:  # noqa: BLE001 - surface to the cell
            await self.emit({"type": "exec_error", "message": str(exc)})
        else:
            await self.emit({"type": "exec_done", **result})
        finally:
            self._exec_running = False

    async def _exec_interrupt(self) -> None:
        if self.shell is not None:
            await self.shell.interrupt()

    def on_close(self):
        if self.session is not None:
            IOLoop.current().spawn_callback(self.session.close)
            self.session = None
        if self.shell is not None:
            IOLoop.current().spawn_callback(self.shell.close)
            self.shell = None


def setup_handlers(web_app, cwd: str) -> None:
    base_url = web_app.settings["base_url"]
    web_app.add_handlers(
        ".*$",
        [
            (
                url_path_join(base_url, "aiterminal", "agent"),
                AgentWebSocketHandler,
                {"cwd": cwd},
            )
        ],
    )


def _resolve_workspace_cwd(root: str, requested: str) -> str | None:
    """Resolve a client-relative workspace directory without escaping root."""
    root_path = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(root_path, requested or "."))
    try:
        inside_root = os.path.commonpath((root_path, candidate)) == root_path
    except ValueError:
        inside_root = False
    if not inside_root or not os.path.isdir(candidate):
        return None
    return candidate


def _parse_resume_session_id(requested: str) -> str | None:
    if not requested:
        return None
    normalized = normalize_session_id(requested)
    if normalized is None:
        raise ValueError("invalid Agent session identifier")
    return normalized
