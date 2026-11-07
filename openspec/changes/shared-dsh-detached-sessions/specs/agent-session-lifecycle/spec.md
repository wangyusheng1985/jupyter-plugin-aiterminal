## MODIFIED Requirements

### Requirement: AI requests wait for a usable connection

Before sending an AI-cell request, the system SHALL ensure that the shared DSH runtime and the workspace's ACP session are usable. If the runtime or session does not exist, the system SHALL start or attach it automatically. If startup is already in progress, the request SHALL wait for that attempt to finish instead of sending through an unready session. A disconnected browser MUST NOT by itself make a live detached session unusable.

#### Scenario: Request arrives during initial connection

- **WHEN** an AI-cell request arrives while the shared runtime or ACP session is still being established
- **THEN** the system waits until the session is ready
- **AND** sends the request only after the session is ready
- **AND** does not display `Not connected. Call connect() first.`

#### Scenario: First request arrives without a connection

- **WHEN** an AI-cell request is submitted and the workspace has no ACP session yet
- **THEN** the system attaches the workspace to the shared runtime
- **AND** executes the request on that session

#### Scenario: Request arrives while the browser is detached

- **WHEN** an AI-cell request is already running and its browser disconnects
- **THEN** the request remains active on the detached session
- **AND** the disconnect does not produce a not-connected failure for that request

### Requirement: Connection startup is single-flight

The system SHALL ensure that concurrent requests for the same workspace cannot create competing ACP sessions or DSH runtimes. Exactly one shared runtime SHALL serve the Jupyter server, and exactly one ACP session SHALL represent each workspace.

#### Scenario: Two requests race during startup

- **WHEN** multiple AI-cell requests for one workspace are received before its first session attachment completes
- **THEN** only one ACP session is created for that workspace
- **AND** no additional DSH runtime is started
- **AND** the system applies its normal already-running behavior after the session is available

#### Scenario: Two workspaces start together

- **WHEN** two workspaces attach for the first time at the same time
- **THEN** both receive their own ACP session
- **AND** both sessions use the same DSH runtime

### Requirement: Stale connections recover transparently

If a request discovers that the shared runtime or ACP transport is no longer usable, the system SHALL replace the stale runtime and resume the same saved ACP session before retrying that request once. The runtime's internal not-connected error SHALL NOT be shown to the user as the final result. Recovery MUST NOT replace the saved session with a new conversation.

#### Scenario: Disconnected client is detected during a request

- **WHEN** an AI-cell request is sent through a runtime that is no longer usable
- **THEN** the system restarts the shared runtime
- **AND** resumes the same saved session
- **AND** retries the request once
- **AND** keeps the internal not-connected message out of the user-visible result

#### Scenario: Reconnection also fails

- **WHEN** restarting the runtime or resuming the session fails after a stale runtime is detected
- **THEN** the system reports the underlying formatted connection or configuration failure
- **AND** does not repeatedly retry the same request

### Requirement: The protocol reports real context identity and state

Agent readiness and result events SHALL report the real opaque session identifier and whether the runtime session is new, resumed, or reattached. The protocol SHALL NOT use a constant placeholder identity for persisted context. Reattaching a browser to a session that continued while detached SHALL report that same session identity.

#### Scenario: A new Agent connection becomes ready

- **WHEN** a fresh ACP session starts
- **THEN** the client receives its real session identifier and new state

#### Scenario: A resumed connection becomes ready

- **WHEN** the runtime resumes a requested session
- **THEN** the client receives the resumed session identifier and resumed state

#### Scenario: A browser reattaches to a detached session

- **WHEN** a workspace reconnects to a session that remained live after disconnect
- **THEN** the client receives the existing session identifier and reattached state
- **AND** the identifier does not change

#### Scenario: A result confirms session identity

- **WHEN** an AI turn produces its final runtime result
- **THEN** the result event includes the runtime-reported session identifier
- **AND** the workspace can persist an updated identifier before saving
