"""Server-owned AI sessions that outlive their browser sockets.

A WebSocket attaches and detaches. It does not own the ACP session or the DSH
runtime. Explicit workspace shutdown is the only per-workspace close path.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import Any

from .agent import AgentSession


class SessionBusyError(RuntimeError):
    """Retained for backwards-compatible imports.

    Attaching a new browser now takes over the workspace session instead of
    failing, so this error is no longer raised by :meth:`SessionRegistry.attach`.
    """


class SessionRegistry:
    """One registry per Jupyter server process."""

    def __init__(self) -> None:
        self._sessions: dict[str, AgentSession] = {}
        self._attachments: dict[str, Callable[[dict[str, Any]], Any]] = {}
        self._lock = asyncio.Lock()

    def get(self, session_id: str) -> AgentSession | None:
        return self._sessions.get(session_id)

    def remember(self, session: AgentSession) -> None:
        session_id = session.session_id
        if isinstance(session_id, str) and session_id:
            self._sessions[session_id] = session

    def attach(
        self,
        session_id: str,
        sink: Callable[[dict[str, Any]], Any],
    ) -> AgentSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        # The newest browser becomes the authoritative sink. A refresh or a
        # reopened workspace takes over the session instead of leaving the
        # previous connection as an orphan owner.
        self._attachments[session_id] = sink
        session.emit = sink
        return session

    def detach(self, session_id: str, sink: Callable[[dict[str, Any]], Any]) -> None:
        """Drop one browser sink without closing its AI session.

        Bound methods are recreated on each attribute access, so identity is
        the handler instance rather than the temporary method object.
        """
        current = self._attachments.get(session_id)
        same_handler = getattr(current, "__self__", None) is getattr(
            sink, "__self__", object()
        )
        if current is sink or same_handler:
            self._attachments.pop(session_id, None)

    def attached(self, session_id: str) -> bool:
        return session_id in self._attachments

    async def shutdown(self, session_id: str) -> None:
        """Explicitly cancel and close one workspace session."""
        session = self._sessions.pop(session_id, None)
        self._attachments.pop(session_id, None)
        if session is not None:
            await session.close()

    async def close(self) -> None:
        """Jupyter server shutdown: close every surviving AI session."""
        sessions = list(self._sessions.values())
        self._sessions.clear()
        self._attachments.clear()
        for session in sessions:
            await session.close()
