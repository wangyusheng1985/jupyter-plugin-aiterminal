## ADDED Requirements

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
