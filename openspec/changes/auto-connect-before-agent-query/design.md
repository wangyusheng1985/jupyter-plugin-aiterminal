## Context

See `proposal.md` for the motivation. The current server-side `AgentSession` starts connecting asynchronously when the WebSocket opens, but assigns `self.client` before `await client.connect()` finishes. A `user` message can therefore reach `query()` while the SDK client object exists but its transport is not ready. The SDK then raises `CLIConnectionError("Not connected. Call connect() first.")`.

The WebSocket protocol and browser session already queue or reconnect transport messages. This change is limited to server-side Agent SDK readiness and does not require a protocol or UI change.

## Goals / Non-Goals

**Goals:**

- Guarantee that every SDK query runs on a fully connected client.
- Coalesce concurrent connection attempts into one SDK client.
- Recover once from a stale client without exposing the SDK's internal state error.
- Preserve the current configuration and runtime error messages and events.

**Non-Goals:**

- Adding a user-facing connect/reconnect control.
- Changing WebSocket message shapes, settings, or AI-cell behavior.
- Changing persistent Agent session semantics or adding session persistence.
- Replacing the Claude Agent SDK.

## Decisions

### Make connection readiness an explicit invariant

Use a single asynchronous connect lock around client creation and connection. Publish the client to the session state only after `connect()` succeeds. During startup, `query()` waits on the same lock and reuses the connected client rather than observing a partially initialized client.

Alternative considered: add a delay or let the SDK error be retried by the browser. Timing delays are unreliable, and browser retries obscure where the connection failure occurred.

Alternative considered: expose connection state to the frontend and disable Run. This adds protocol and UI complexity while leaving other callers vulnerable to the same race.

### Retry only the known stale-connection failure

If a query encounters the SDK not-connected error, invalidate that client, reconnect through the same single-flight path, and retry the prompt exactly once. Other SDK failures continue through the existing formatted runtime-error path.

Alternative considered: inspect the SDK client's private `_transport` or `_query` attributes before every prompt. That couples the extension to SDK internals and is more brittle than handling the documented public failure.

Alternative considered: reconnect before every prompt. This would add latency and unnecessarily discard an otherwise healthy conversation connection.

### Preserve error ownership

Connection startup remains responsible for emitting `config` or `runtime` errors. A query that finds the client unavailable returns after that connection attempt instead of issuing another query or duplicating the startup error. This keeps the existing settings guidance intact and ensures `Not connected. Call connect() first.` never becomes the final visible error.

## Risks / Trade-offs

- A retried prompt could produce a duplicate turn if a transport reports not-connected after accepting input. The SDK raises that error before writing when its transport is absent, so the retry is limited to the pre-write failure and occurs at most once.
- Serializing connection startup could delay an early request while the SDK starts. This is preferable to failing the request and is bounded by the existing connection attempt.
- Holding a lock during subprocess connection could block an immediate close. The implementation must keep `close()` safe and invalidate any client that cannot be published to a closing session.
- Detecting the stale-connection case by the SDK error text is version-sensitive. Tests will isolate the predicate, and the fallback still emits a formatted runtime error rather than crashing.

## Migration Plan

No data or protocol migration is required. Deploy the server-side change with the extension; existing tabs establish a new WebSocket and use the new readiness path. Rollback is limited to restoring the previous `AgentSession` implementation.

## Open Questions

None.
