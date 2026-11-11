"""The BTW wire protocol must stay identical in Python, TypeScript, and JSON."""

from __future__ import annotations

import json
from pathlib import Path

from jupyter_aiterminal import btw_protocol


def protocol_path() -> Path:
    return Path(__file__).resolve().parents[1] / 'protocol' / 'btw-protocol.json'


def test_shared_json_matches_python_constants():
    document = json.loads(protocol_path().read_text(encoding='utf-8'))
    assert document == btw_protocol.protocol_payload()


def test_routes_are_unique_and_relative():
    routes = btw_protocol.BTW_ROUTES
    assert len(set(routes)) == len(routes)
    for route in routes:
        assert route
        assert not route.startswith('/')
        assert '..' not in route


def test_queue_statuses_cover_every_documented_state():
    assert btw_protocol.BTW_QUEUE_STATUSES == (
        'queued',
        'delivering',
        'delivered',
        'cancelled',
        'failed',
        'unknown',
    )


def test_bounds_are_finite_positive_limits():
    for name in (
        'BTW_MAX_THREADS_PER_NOTEBOOK',
        'BTW_MAX_MESSAGES_PER_THREAD',
        'BTW_MAX_MESSAGE_CHARS',
        'BTW_MAX_SNAPSHOT_CHARS',
        'BTW_MAX_SOURCE_CHARS',
        'BTW_MAX_STATE_BYTES',
        'BTW_MAX_QUEUE_ENTRIES',
        'BTW_MAX_REQUEST_ID_CHARS',
        'BTW_QUEUE_STALE_SECONDS',
    ):
        value = getattr(btw_protocol, name)
        assert isinstance(value, int) and value > 0
    assert btw_protocol.BTW_MAX_SOURCE_CHARS <= btw_protocol.BTW_MAX_SNAPSHOT_CHARS
