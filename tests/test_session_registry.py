import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from jupyter_aiterminal.session_registry import SessionBusyError, SessionRegistry


def _session(session_id: str = "session-1") -> Mock:
    session = Mock()
    session.session_id = session_id
    return session


def test_attach_takes_over_existing_sink():
    registry = SessionRegistry()
    session = _session()
    registry.remember(session)
    first = Mock()
    second = Mock()

    attached = registry.attach("session-1", first)
    assert attached is session
    assert session.emit is first
    assert registry.attached("session-1") is True

    # A refreshed/reopened browser replaces the previous sink instead of the
    # registry raising SessionBusyError.
    attached = registry.attach("session-1", second)
    assert attached is session
    assert session.emit is second
    assert registry.attached("session-1") is True


def test_attach_unknown_session_raises_key_error():
    registry = SessionRegistry()
    with pytest.raises(KeyError):
        registry.attach("missing", Mock())


def test_session_busy_error_is_still_importable():
    assert issubclass(SessionBusyError, RuntimeError)


def test_detach_drops_only_matching_sink():
    registry = SessionRegistry()
    session = _session()
    registry.remember(session)

    class Handler:
        def __init__(self):
            self.events = []

        def emit(self, event):
            self.events.append(event)

    owner = Handler()
    other = Handler()
    registry.attach("session-1", owner.emit)

    # A different handler must not detach the current owner.
    registry.detach("session-1", other.emit)
    assert registry.attached("session-1") is True

    registry.detach("session-1", owner.emit)
    assert registry.attached("session-1") is False


def test_shutdown_closes_session_and_clears_attachment():
    registry = SessionRegistry()
    session = _session()
    session.close = AsyncMock()
    registry.remember(session)
    registry.attach("session-1", Mock())

    asyncio.run(registry.shutdown("session-1"))

    session.close.assert_called_once()
    assert registry.get("session-1") is None
    assert registry.attached("session-1") is False
