## 1. Connection Readiness

- [x] 1.1 Refactor `AgentSession` startup so client creation and `connect()` are serialized by one lock, and verify concurrent `start()` calls create only one SDK client
- [x] 1.2 Publish the SDK client to session state only after `connect()` succeeds, and verify a failure leaves `client` unset and emits the existing config or formatted runtime error
- [x] 1.3 Add an internal ensure-connected path used by both WebSocket startup and `query()`, and verify a request arriving during startup waits instead of querying the unready client
- [x] 1.4 Keep `close()` safe when startup is in progress or a client cannot be published, and verify closing the session does not leave a connected client attached

## 2. Query Recovery

- [x] 2.1 Add an isolated predicate for the SDK's `Not connected. Call connect() first.` failure and verify it does not classify unrelated runtime errors as reconnectable
- [x] 2.2 Invalidate a stale client, reconnect through the single-flight path, and retry the prompt exactly once, with a test showing the raw SDK message is not emitted
- [x] 2.3 Ensure reconnection is not retried again and connection failures remain actionable, with tests covering a failed reconnect and missing settings

## 3. Regression Verification

- [x] 3.1 Add focused `AgentSession` tests for startup race, concurrent requests, stale-client retry, and failed connection, and verify they pass with `pytest tests/test_agent_session.py`
- [x] 3.2 Run the full Python suite with `pytest` and verify all existing Agent, settings, policy, shell, and event tests remain green
- [x] 3.3 Run `openspec validate "auto-connect-before-agent-query" --type change --strict` and verify the change has no validation errors
