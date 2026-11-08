## Why

AI cells can currently execute while the server-side Agent SDK is still connecting, causing the raw SDK error `Not connected. Call connect() first.` to appear intermittently. The agent should treat connection as a prerequisite of execution and establish or restore it automatically instead of exposing that internal SDK state to the user.

## What Changes

- Ensure an AI-cell query waits for an in-progress SDK connection and starts one automatically when no usable connection exists.
- Serialize connection attempts so concurrent execution cannot create competing SDK clients.
- Detect a connection that has become unusable, reconnect once, and retry the query without exposing the SDK's `Not connected. Call connect() first.` error.
- Preserve actionable configuration and runtime errors when automatic connection cannot succeed.

## Capabilities

### New Capabilities

- `agent-session-lifecycle`: Defines automatic connection, single-flight startup, transparent query-time reconnection, and error behavior for the server-side Agent session.

### Modified Capabilities

<!-- No existing capability requirements are changing. -->

## Impact

- Server-side Agent session startup and query orchestration in `jupyter_aiterminal/agent.py`.
- Python tests that exercise connection races, failed startup, and disconnected-client retry behavior.
- No WebSocket protocol, user setting, or browser UI contract changes are required.
