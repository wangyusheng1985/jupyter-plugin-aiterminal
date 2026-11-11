"""HTTP endpoints for the BTW side chat.

All routes live under ``<base_url>/aiterminal/btw``. Every request is
authenticated, and the notebook path is resolved under the Jupyter server root
with the same checks the store uses; the client can never name a file outside
the root or select another user's scope (the user key comes from the
authenticated Jupyter user, not from the request).

Errors are returned with a fixed, user-facing message and an HTTP status; raw
exception text, notebook contents, prompts, and credentials are never echoed.
"""

from __future__ import annotations

import json
from typing import Any

from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .btw_protocol import (
    BTW_BASE_PATH,
    BTW_ROUTE_CANCEL,
    BTW_ROUTE_MESSAGE,
    BTW_ROUTE_QUEUE,
    BTW_ROUTE_QUEUE_ACK,
    BTW_ROUTE_QUEUE_CANCEL,
    BTW_ROUTE_QUEUE_CLAIM,
    BTW_ROUTE_THREAD,
)
from .btw_service import BtwService, BtwServiceError
from .btw_store import BtwStorageError

_MAX_BODY_BYTES = 1_000_000
_SETTING_NAME = "aiterminal_btw"


class _BtwHandler(JupyterHandler):
    """Shared plumbing: authenticated JSON in, JSON out, fixed errors."""

    auth_resource = "aiterminal_btw"

    @property
    def service(self) -> BtwService:
        service = self.settings.get(_SETTING_NAME)
        if not isinstance(service, BtwService):
            raise web.HTTPError(503, "BTW is not available on this server.")
        return service

    @property
    def user_key(self) -> str:
        user = self.current_user
        username = getattr(user, "username", None)
        if not isinstance(username, str) or not username:
            # Fail closed: an unauthenticated request must not share the
            # anonymous scope with another anonymous request.
            raise web.HTTPError(403)
        return username

    def write_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload, ensure_ascii=True))

    def read_body(self) -> dict[str, Any]:
        if len(self.request.body) > _MAX_BODY_BYTES:
            raise web.HTTPError(413, "BTW request body is too large.")
        if not self.request.body:
            return {}
        try:
            payload = json.loads(self.request.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise web.HTTPError(400, "BTW request is not valid JSON.") from exc
        if not isinstance(payload, dict):
            raise web.HTTPError(400, "BTW request must be a JSON object.")
        return payload

    def field(self, payload: dict[str, Any], name: str, limit: int = 100_000) -> str:
        value = payload.get(name)
        if not isinstance(value, str) or not value:
            raise web.HTTPError(400, f"BTW request field {name} is required.")
        if len(value) > limit:
            raise web.HTTPError(400, f"BTW request field {name} is too long.")
        return value

    def error(self, exc: Exception) -> None:
        if isinstance(exc, (BtwServiceError, BtwStorageError)):
            self.write_json({"message": str(exc)}, status=400)
            return
        raise exc

    async def run(self, operation) -> None:  # noqa: ANN001 - small dispatcher
        try:
            payload = await operation()
        except web.HTTPError:
            raise
        except (BtwServiceError, BtwStorageError) as exc:
            self.write_json({"message": str(exc)}, status=400)
            return
        except Exception:  # noqa: BLE001 - fixed message, no internals
            self.set_status(500)
            self.set_header("Content-Type", "application/json")
            self.finish(
                json.dumps({"message": "BTW request failed on the server."})
            )
            return
        self.write_json(payload)


class BtwThreadHandler(_BtwHandler):
    @web.authenticated
    async def get(self) -> None:
        async def operation() -> dict[str, Any]:
            notebook = self.get_query_argument("notebook", default="")
            cell_id = self.get_query_argument("cellId", default="")
            if not notebook or not cell_id:
                raise web.HTTPError(
                    400, "BTW restore requires notebook and cellId."
                )
            thread = await self.service.restore_thread(
                self.user_key, notebook, cell_id
            )
            return {"thread": thread, "status": self.service.status()}

        await self.run(operation)

    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            cell_id = self.field(payload, "cellId", limit=1024)
            thread = await self.service.open_thread(
                self.user_key, notebook, cell_id
            )
            return {"thread": thread, "status": self.service.status()}

        await self.run(operation)


class BtwMessageHandler(_BtwHandler):
    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            thread_id = self.field(payload, "threadId", limit=128)
            text = self.field(payload, "text")
            thread = await self.service.send(
                self.user_key, notebook, thread_id, text
            )
            return {"thread": thread, "status": self.service.status()}

        await self.run(operation)


class BtwCancelHandler(_BtwHandler):
    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            thread_id = self.field(payload, "threadId", limit=128)
            thread = await self.service.cancel(
                self.user_key, notebook, thread_id
            )
            return {"thread": thread, "status": self.service.status()}

        await self.run(operation)


class BtwQueueHandler(_BtwHandler):
    @web.authenticated
    async def get(self) -> None:
        async def operation() -> dict[str, Any]:
            notebook = self.get_query_argument("notebook", default="")
            if not notebook:
                raise web.HTTPError(400, "BTW queue requires a notebook.")
            return await self.service.list_queue(self.user_key, notebook)

        await self.run(operation)

    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            thread_id = self.field(payload, "threadId", limit=128)
            request_id = self.field(payload, "requestId", limit=128)
            text = self.field(payload, "text")
            entry = await self.service.enqueue(
                self.user_key, notebook, thread_id, request_id, text
            )
            return {"entry": entry}

        await self.run(operation)


class BtwQueueClaimHandler(_BtwHandler):
    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            return await self.service.claim(self.user_key, notebook)

        await self.run(operation)


class BtwQueueAckHandler(_BtwHandler):
    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            request_id = self.field(payload, "requestId", limit=128)
            claim_id = self.field(payload, "claimId", limit=128)
            outcome = self.field(payload, "outcome", limit=32)
            entry = await self.service.ack(
                self.user_key, notebook, request_id, claim_id, outcome
            )
            return {"entry": entry}

        await self.run(operation)


class BtwQueueCancelHandler(_BtwHandler):
    @web.authenticated
    async def post(self) -> None:
        async def operation() -> dict[str, Any]:
            payload = self.read_body()
            notebook = self.field(payload, "notebook")
            request_id = self.field(payload, "requestId", limit=128)
            raw_claim = payload.get("claimId")
            claim_id = None
            if raw_claim is not None:
                claim_id = self.field(payload, "claimId", limit=128)
            entry = await self.service.cancel_queued(
                self.user_key, notebook, request_id, claim_id
            )
            return {"entry": entry}

        await self.run(operation)


def build_btw_service(root: str) -> BtwService:
    """Create the per-server BTW service rooted at the Jupyter server root."""
    from .agent import dsh_storage_root
    from .btw_store import BtwStore

    storage = dsh_storage_root().parent / "btw-store"
    return BtwService(root=root, store=BtwStore(storage))


def setup_btw_handlers(web_app, root: str) -> None:
    base = url_path_join(web_app.settings["base_url"], BTW_BASE_PATH)
    if _SETTING_NAME not in web_app.settings:
        web_app.settings[_SETTING_NAME] = build_btw_service(root)
    web_app.add_handlers(
        ".*$",
        [
            (url_path_join(base, BTW_ROUTE_THREAD), BtwThreadHandler),
            (url_path_join(base, BTW_ROUTE_MESSAGE), BtwMessageHandler),
            (url_path_join(base, BTW_ROUTE_CANCEL), BtwCancelHandler),
            (url_path_join(base, BTW_ROUTE_QUEUE), BtwQueueHandler),
            (
                url_path_join(base, BTW_ROUTE_QUEUE_CLAIM),
                BtwQueueClaimHandler,
            ),
            (url_path_join(base, BTW_ROUTE_QUEUE_ACK), BtwQueueAckHandler),
            (
                url_path_join(base, BTW_ROUTE_QUEUE_CANCEL),
                BtwQueueCancelHandler,
            ),
        ],
    )
