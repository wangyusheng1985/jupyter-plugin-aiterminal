## Purpose

Define how the server-side Agent session guarantees that an AI-cell request has a usable SDK connection before execution, including startup races and stale connections.

## ADDED Requirements

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
