from __future__ import annotations

import json
import os
import re

from jupyter_core.utils import ensure_async
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web, websocket
from tornado.ioloop import IOLoop

from .agent import AgentSession
from .history_bridge import compose_bridged_prompt, validate_history_bridge
from .shell import PersistentShell

# DSH session ids are opaque ACP strings. They are never used as filesystem
# paths (the server hashes them for its index), so validation only needs a
# bounded, separator-free printable-ASCII form.
_MAX_SESSION_ID_CHARS = 256
_MAX_REQUEST_ID_CHARS = 256
_IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9._:@-]+\Z")
_PERMISSION_RESOLUTIONS = ("approved", "rejected")
_PERMISSION_SCOPE_KEYS = ("sessionId", "runtimeId", "runId")


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
        requested_dsh_session = self.get_query_argument("dshSessionId", default="")
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
            dsh_session_id = _parse_dsh_session_id(requested_dsh_session)
            _check_legacy_session_id(requested_session, dsh_session_id)
        except ValueError as exc:
            IOLoop.current().spawn_callback(
                self.emit,
                {
                    "type": "error",
                    "code": "resume",
                    "message": str(exc),
                },
            )
            return
        self.session = AgentSession(cwd, self.emit, dsh_session_id)
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
        if not isinstance(payload, dict):
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
        elif kind == "dsh/v1/interaction.resolve":
            self._schedule_interaction_resolution(payload)

    def _schedule_interaction_resolution(self, payload: dict) -> None:
        """Validate a permission decision, then route it to the tracked request.

        The client-supplied scope is checked against the live session but is
        never used as authorization: ``AgentSession.resolve_permission`` reads
        the scope it recorded from the ACP request itself.
        """
        try:
            request_id, resolution, scope = _parse_interaction_resolution(payload)
        except ValueError as exc:
            self._emit_permission_error(str(exc), None)
            return
        if self.session is None:
            self._emit_permission_error("No active agent session.", scope)
            return
        if scope["sessionId"] != self.session.session_id or scope[
            "runtimeId"
        ] != self.session.runtime_id:
            self._emit_permission_error(
                "Permission scope does not match the active session.", scope
            )
            return
        IOLoop.current().spawn_callback(
            self._resolve_permission, request_id, resolution, scope
        )

    async def _resolve_permission(
        self, request_id: str, resolution: str, scope: dict[str, str]
    ) -> None:
        if self.session is None:
            self._emit_permission_error("No active agent session.", scope)
            return
        try:
            resolved = await self.session.resolve_permission(request_id, resolution)
        except Exception:  # noqa: BLE001 - never echo runtime internals/tokens
            self._emit_permission_error(
                "Permission request could not be resolved.", scope
            )
            return
        if not resolved:
            self._emit_permission_error(
                "Permission decision could not be applied.", scope
            )

    def _emit_permission_error(
        self, message: str, scope: dict[str, str] | None
    ) -> None:
        event: dict[str, object] = {"type": "error", "code": "permission"}
        if scope is not None:
            event.update(scope)
        event["message"] = message
        IOLoop.current().spawn_callback(self.emit, event)

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


def _parse_dsh_session_id(requested: str) -> str | None:
    """Validate the independent ``dshSessionId`` query parameter.

    ACP session ids are opaque strings, not necessarily UUIDs, so the check
    bounds length and rejects path/control characters rather than forcing a
    legacy UUID shape. The server hashes the value for its session index, so
    no filesystem path is derived from it.
    """
    if not requested:
        return None
    if len(requested) > _MAX_SESSION_ID_CHARS:
        raise ValueError("Saved DSH session identifier is too long.")
    if requested in (".", "..") or _IDENTIFIER_PATTERN.fullmatch(requested) is None:
        raise ValueError("Saved DSH session identifier is invalid.")
    return requested


def _check_legacy_session_id(
    requested: str, dsh_session_id: str | None
) -> None:
    """Reject legacy Pi ``sessionId`` values instead of passing them to DSH.

    A browser that already holds the current DSH id may repeat it in both
    parameters; that is the same identity and is tolerated. Any other legacy
    value is an old Pi session id: it cannot be migrated or mapped to a DSH
    session, so the user must start a new session explicitly.
    """
    if not requested:
        return
    if dsh_session_id is not None and requested == dsh_session_id:
        return
    raise ValueError(
        "Legacy Pi session IDs cannot be resumed by this server; "
        "start a new Agent session."
    )


def _parse_interaction_resolution(payload: dict) -> tuple[str, str, dict[str, str]]:
    """Parse a ``dsh/v1/interaction.resolve`` message into safe fields."""
    request_id = payload.get("requestId")
    if not _is_safe_identifier(request_id, _MAX_REQUEST_ID_CHARS):
        raise ValueError("Permission request identifier is invalid.")
    resolution = payload.get("resolution")
    if not isinstance(resolution, str) or resolution not in _PERMISSION_RESOLUTIONS:
        raise ValueError(
            "Permission resolution must be 'approved' or 'rejected'."
        )
    raw_scope = payload.get("scope")
    if not isinstance(raw_scope, dict):
        raise ValueError("Permission scope must be a JSON object.")  # noqa: TRY004
    if any(key not in _PERMISSION_SCOPE_KEYS for key in raw_scope):
        raise ValueError("Permission scope has unknown fields.")
    session_id = raw_scope.get("sessionId")
    runtime_id = raw_scope.get("runtimeId")
    run_id = raw_scope.get("runId")
    if not _is_safe_identifier(session_id, _MAX_SESSION_ID_CHARS):
        raise ValueError("Permission scope session identifier is invalid.")
    if not _is_safe_identifier(runtime_id, _MAX_SESSION_ID_CHARS):
        raise ValueError("Permission scope runtime identifier is invalid.")
    scope = {"sessionId": session_id, "runtimeId": runtime_id}
    if run_id is not None:
        if not _is_safe_identifier(run_id, _MAX_REQUEST_ID_CHARS):
            raise ValueError("Permission scope run identifier is invalid.")
        scope["runId"] = run_id
    return request_id, resolution, scope


def _is_safe_identifier(value: object, max_chars: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= max_chars
        and value not in (".", "..")
        and _IDENTIFIER_PATTERN.fullmatch(value) is not None
    )
