"""Shared wire constants for the BTW side-chat.

This module is the Python half of one protocol contract. The same values are
mirrored in ``protocol/btw-protocol.json`` (read by both the Pytest and Jest
suites) and in ``src/agent/btw-protocol.ts``; a drift in either direction fails
a test instead of producing a frontend that silently calls a missing route.
"""

from __future__ import annotations

# Route base under the Jupyter server ``base_url``.
BTW_BASE_PATH = "aiterminal/btw"

BTW_ROUTE_THREAD = "thread"
BTW_ROUTE_MESSAGE = "message"
BTW_ROUTE_CANCEL = "cancel"
BTW_ROUTE_QUEUE = "queue"
BTW_ROUTE_QUEUE_CLAIM = "queue/claim"
BTW_ROUTE_QUEUE_ACK = "queue/ack"
BTW_ROUTE_QUEUE_CANCEL = "queue/cancel"

BTW_ROUTES = (
    BTW_ROUTE_THREAD,
    BTW_ROUTE_MESSAGE,
    BTW_ROUTE_CANCEL,
    BTW_ROUTE_QUEUE,
    BTW_ROUTE_QUEUE_CLAIM,
    BTW_ROUTE_QUEUE_ACK,
    BTW_ROUTE_QUEUE_CANCEL,
)

# A BTW message is either the user's turn or one finished assistant answer.
BTW_MESSAGE_ROLES = ("user", "assistant")

# Terminal state of one stored BTW message. ``cancelled`` keeps the partial
# answer visible while marking that it is incomplete.
BTW_MESSAGE_STATUSES = ("done", "cancelled", "failed")

# Send-back queue states. ``delivering`` means a client claimed the entry and
# is inserting it into a main-session input cell; it is never replayed
# automatically. ``unknown`` means delivery could not be proven (for example a
# page reload while ``delivering``) and requires explicit user confirmation.
BTW_QUEUE_STATUSES = (
    "queued",
    "delivering",
    "delivered",
    "cancelled",
    "failed",
    "unknown",
)

# Snapshot provenance fields shown in the panel header.
BTW_SNAPSHOT_FIELDS = (
    "capturedAt",
    "answerNumber",
    "omittedPairs",
    "truncated",
    "sourceChars",
)

# Hard, server-enforced bounds. They keep one notebook's state file, one
# thread's message list, and the runtime prompt bounded regardless of client
# behaviour.
BTW_MAX_NOTEBOOK_PATH_CHARS = 1024
BTW_MAX_THREADS_PER_NOTEBOOK = 200
BTW_MAX_MESSAGES_PER_THREAD = 200
BTW_MAX_MESSAGE_CHARS = 100_000
BTW_MAX_SNAPSHOT_CHARS = 60_000
BTW_MAX_SOURCE_CHARS = 40_000
BTW_MAX_STATE_BYTES = 8_000_000
BTW_MAX_QUEUE_ENTRIES = 50
BTW_MAX_REQUEST_ID_CHARS = 128
BTW_QUEUE_STALE_SECONDS = 600

# Fixed, user-facing texts. They never echo notebook paths, prompts, or
# credentials.
BTW_ERROR_SNAPSHOT_TOO_LARGE = (
    "The source answer is too large to snapshot for BTW. Shorten that answer "
    "or start BTW from a smaller answer."
)
BTW_ERROR_RESTORE_FAILED = (
    "The saved BTW thread for this notebook could not be restored. It was not "
    "replaced with a new thread."
)
BTW_ERROR_UNKNOWN_NOTEBOOK = (
    "The notebook for this BTW thread is missing or outside the server root."
)


def protocol_payload() -> dict[str, object]:
    """Return the canonical shared protocol document.

    ``tests/test_btw_protocol.py`` and ``src/agent/btw-protocol.spec.ts``
    compare this payload with ``protocol/btw-protocol.json`` so the two
    runtimes cannot drift.
    """
    return {
        "version": 1,
        "basePath": BTW_BASE_PATH,
        "routes": {
            "thread": BTW_ROUTE_THREAD,
            "message": BTW_ROUTE_MESSAGE,
            "cancel": BTW_ROUTE_CANCEL,
            "queue": BTW_ROUTE_QUEUE,
            "queueClaim": BTW_ROUTE_QUEUE_CLAIM,
            "queueAck": BTW_ROUTE_QUEUE_ACK,
            "queueCancel": BTW_ROUTE_QUEUE_CANCEL,
        },
        "messageRoles": list(BTW_MESSAGE_ROLES),
        "messageStatuses": list(BTW_MESSAGE_STATUSES),
        "queueStatuses": list(BTW_QUEUE_STATUSES),
        "snapshotFields": list(BTW_SNAPSHOT_FIELDS),
    }
