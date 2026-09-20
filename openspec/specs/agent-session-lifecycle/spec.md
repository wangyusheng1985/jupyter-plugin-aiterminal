# agent-session-lifecycle Specification

## Purpose

Define how the server-side Agent session guarantees that an AI-cell request has a usable SDK connection before execution, including startup races and stale connections.

## Requirements

### Requirement: AI requests wait for a usable connection

Before sending an AI-cell request, the system SHALL ensure that the Agent SDK client is fully connected. If no connection exists, it SHALL start one automatically. If a connection attempt is already in progress, the request SHALL wait for that attempt to finish instead of sending through an unready client.

#### Scenario: Request arrives during initial connection

- **WHEN** an AI-cell request arrives while the initial SDK connection is still being established
- **THEN** the system waits until the connection succeeds
- **AND** sends the request only after the client is ready
- **AND** does not display `Not connected. Call connect() first.`

#### Scenario: First request arrives without a connection

- **WHEN** an AI-cell request is submitted and no SDK client has been connected
- **THEN** the system establishes the connection automatically
- **AND** executes the request with that connection

### Requirement: Connection startup is single-flight

The system SHALL ensure that concurrent AI-cell requests cannot create competing SDK clients while connection startup is in progress. Exactly one connection attempt SHALL supply the session, after which normal running-turn behavior SHALL apply.

#### Scenario: Two requests race during startup

- **WHEN** multiple AI-cell requests are received before the first connection attempt completes
- **THEN** only one SDK connection is created
- **AND** the requests do not each initiate their own connection
- **AND** the system applies its normal already-running behavior after the connection is available

### Requirement: Stale connections recover transparently

If a request discovers that the SDK client is no longer usable, the system SHALL replace the stale connection and retry that request once. The SDK's internal not-connected error SHALL NOT be shown to the user as the final result.

#### Scenario: Disconnected client is detected during a request

- **WHEN** an AI-cell request is sent to a client that reports `Not connected. Call connect() first.`
- **THEN** the system reconnects automatically
- **AND** retries the request once on the new connection
- **AND** keeps the SDK's internal not-connected message out of the user-visible result

#### Scenario: Reconnection also fails

- **WHEN** automatic reconnection fails after a stale connection is detected
- **THEN** the system reports the underlying formatted connection or configuration failure
- **AND** does not repeatedly retry the same request

### Requirement: Connection failures remain actionable

Automatic connection SHALL preserve the existing distinction between missing configuration and runtime failures. A failed connection SHALL produce an actionable error and SHALL NOT attempt to query the unavailable SDK client.

#### Scenario: Required settings are missing

- **WHEN** an AI-cell request triggers automatic connection and required AI Terminal settings are missing
- **THEN** the system emits the existing configuration error that points to AI Terminal settings
- **AND** does not emit the SDK's not-connected error

#### Scenario: SDK startup fails

- **WHEN** the SDK client cannot connect for a runtime reason
- **THEN** the system emits a formatted runtime error
- **AND** leaves the session available for a later connection attempt

### Requirement: Session startup honors requested document context

Before connecting the Agent SDK, the server SHALL receive and validate the workspace's requested session identifier when one exists. A new workspace SHALL receive a fresh valid session identity, while a linked workspace SHALL request resume without combining mutually exclusive new-session and resume options.

#### Scenario: Startup requests a saved session

- **WHEN** the WebSocket opens with a valid saved session identifier
- **THEN** the SDK client is configured to resume that identifier
- **AND** no new session identifier is forced into the same connection

#### Scenario: Startup has no saved session

- **WHEN** the WebSocket opens without a session identifier
- **THEN** the server creates a valid new session identity
- **AND** configures the SDK to persist that session for later resume

#### Scenario: Startup receives an invalid identifier

- **WHEN** the WebSocket supplies a malformed or overlong session identifier
- **THEN** the server rejects it as a context error
- **AND** does not pass it to the SDK or treat it as a filesystem path

### Requirement: The protocol reports real context identity and state

Agent readiness and result events SHALL report the real opaque session identifier and whether the runtime is new or resumed. The protocol SHALL NOT use a constant placeholder identity for persisted context.

#### Scenario: A new Agent connection becomes ready

- **WHEN** a fresh SDK session starts
- **THEN** the client receives its real session identifier and new state

#### Scenario: A resumed connection becomes ready

- **WHEN** the SDK resumes a requested session
- **THEN** the client receives the resumed session identifier and resumed state

#### Scenario: A result confirms session identity

- **WHEN** an AI turn produces its final SDK result
- **THEN** the result event includes the SDK-reported session identifier
- **AND** the workspace can persist an updated identifier before saving

### Requirement: Resume failures remain distinct and recoverable

Failure to initialize a requested resumed session SHALL emit a distinct resume-context error, leave the saved identifier available for diagnosis or retry, and SHALL NOT automatically retry the request against a fresh SDK session.

#### Scenario: SDK resume initialization fails

- **WHEN** SDK startup with a requested session raises an error
- **THEN** the client receives a resume-context failure with actionable detail
- **AND** no fresh SDK client executes the pending request

#### Scenario: A resumed client later becomes stale

- **WHEN** a previously resumed client reports the SDK not-connected error
- **THEN** automatic reconnection continues to request the same saved context
- **AND** retry-once behavior does not silently change conversation identity
