"""BTW HTTP surface: routes, authentication scope, and fixed error messages."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from tornado import web

from jupyter_aiterminal.btw_handlers import (
    BtwCancelHandler,
    BtwMessageHandler,
    BtwQueueAckHandler,
    BtwQueueCancelHandler,
    BtwQueueClaimHandler,
    BtwQueueHandler,
    BtwThreadHandler,
    _BtwHandler,
    setup_btw_handlers,
)
from jupyter_aiterminal.btw_protocol import BTW_BASE_PATH
from jupyter_aiterminal.btw_service import BtwServiceError


class FakeWebApp:
    def __init__(self):
        self.settings = {'base_url': '/', 'aiterminal_btw': object()}
        self.handlers = []

    def add_handlers(self, pattern, handlers):
        self.handlers.extend(handlers)


def make_handler(
    cls, body=b'', user=SimpleNamespace(username='alice'), settings=None
):
    configured = {'aiterminal_btw': 'service'} if settings is None else settings

    class Harness(cls):
        # ``settings`` is a read-only property on JupyterHandler; the harness
        # overrides it with a fixed mapping instead of touching the base class.
        @property
        def settings(self):
            return configured

    handler = object.__new__(Harness)
    handler.current_user = user
    handler.request = SimpleNamespace(body=body)
    handler.finished = []
    handler.status = 200
    handler.headers = {}
    handler.set_status = lambda status: setattr(handler, 'status', status)
    handler.set_header = lambda key, value: handler.headers.__setitem__(key, value)
    handler.finish = lambda payload: handler.finished.append(payload)
    return handler


def test_setup_registers_every_btw_route(tmp_path):
    app = FakeWebApp()
    setup_btw_handlers(app, str(tmp_path))
    paths = [entry[0] for entry in app.handlers]
    assert f'/{BTW_BASE_PATH}/thread' in paths
    assert f'/{BTW_BASE_PATH}/message' in paths
    assert f'/{BTW_BASE_PATH}/cancel' in paths
    assert f'/{BTW_BASE_PATH}/queue' in paths
    assert f'/{BTW_BASE_PATH}/queue/claim' in paths
    assert f'/{BTW_BASE_PATH}/queue/ack' in paths
    assert f'/{BTW_BASE_PATH}/queue/cancel' in paths
    handlers = [entry[1] for entry in app.handlers]
    assert handlers == [
        BtwThreadHandler,
        BtwMessageHandler,
        BtwCancelHandler,
        BtwQueueHandler,
        BtwQueueClaimHandler,
        BtwQueueAckHandler,
        BtwQueueCancelHandler,
    ]


def test_anonymous_requests_are_refused():
    handler = make_handler(BtwThreadHandler, user=None)
    with pytest.raises(web.HTTPError) as excinfo:
        _ = handler.user_key
    assert excinfo.value.status_code == 403


def test_user_scope_is_the_authenticated_username():
    handler = make_handler(BtwThreadHandler)
    assert handler.user_key == 'alice'


def test_missing_and_oversized_fields_are_rejected():
    handler = make_handler(BtwMessageHandler)
    with pytest.raises(web.HTTPError):
        handler.field({'threadId': 'thread-1'}, 'notebook')
    with pytest.raises(web.HTTPError):
        handler.field({'notebook': 'x' * 10}, 'notebook', limit=5)


def test_invalid_json_body_is_rejected():
    handler = make_handler(BtwMessageHandler, body=b'{nope')
    with pytest.raises(web.HTTPError) as excinfo:
        handler.read_body()
    assert excinfo.value.status_code == 400
    handler = make_handler(BtwMessageHandler, body=b'[]')
    with pytest.raises(web.HTTPError):
        handler.read_body()
    handler = make_handler(BtwMessageHandler, body=b'x' * 1_000_001)
    with pytest.raises(web.HTTPError) as excinfo:
        handler.read_body()
    assert excinfo.value.status_code == 413


def test_service_errors_become_fixed_400_responses():
    async def operation():
        raise BtwServiceError('The notebook for this BTW thread is missing.')

    handler = make_handler(BtwThreadHandler)
    asyncio.run(handler.run(operation))
    assert handler.status == 400
    payload = json.loads(handler.finished[-1])
    assert payload == {'message': 'The notebook for this BTW thread is missing.'}


def test_unexpected_errors_never_echo_internals():
    async def operation():
        raise RuntimeError('token=sk-secret-value')

    handler = make_handler(BtwThreadHandler)
    asyncio.run(handler.run(operation))
    assert handler.status == 500
    payload = json.loads(handler.finished[-1])
    assert payload == {'message': 'BTW request failed on the server.'}
    assert 'sk-secret-value' not in handler.finished[-1]


def test_missing_service_is_unavailable():
    handler = make_handler(BtwThreadHandler, settings={})
    with pytest.raises(web.HTTPError) as excinfo:
        _ = handler.service
    assert excinfo.value.status_code == 503


def test_error_helper_wraps_storage_errors():
    from jupyter_aiterminal.btw_store import BtwStorageError

    handler = make_handler(BtwThreadHandler)
    handler.error(BtwStorageError('saved BTW state is not readable'))
    assert handler.status == 400


def test_base_handler_class_is_shared():
    for cls in (
        BtwThreadHandler,
        BtwMessageHandler,
        BtwCancelHandler,
        BtwQueueHandler,
        BtwQueueClaimHandler,
        BtwQueueAckHandler,
        BtwQueueCancelHandler,
    ):
        assert issubclass(cls, _BtwHandler)
