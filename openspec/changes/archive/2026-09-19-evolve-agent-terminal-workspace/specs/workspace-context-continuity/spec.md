## Purpose

Keep the visible AI Terminal document and the Agent SDK's actual conversational context aligned across close, reopen, reconnect, copy, and explicit reset operations so users always know what the next AI request will remember.

## ADDED Requirements

### Requirement: Successful AI work establishes a durable context link

After the first successful AI turn in a fresh runtime context, the workspace SHALL persist the opaque Agent session identifier needed to resume that context. It SHALL NOT persist API credentials, SDK transcript contents, or server filesystem locations in the workspace document.

#### Scenario: First AI turn completes successfully
- **WHEN** a workspace without a saved Agent session finishes an AI turn
- **THEN** the actual session identifier reported by the Agent runtime is saved with the workspace
- **AND** the workspace context state becomes live

#### Scenario: Command-only work is executed
- **WHEN** the workspace has only accepted Command-cell runs
- **THEN** it does not invent or persist an Agent session identifier

### Requirement: Reopening a workspace resumes its saved Agent context

The workspace SHALL supply a valid saved Agent session identifier before starting its Agent connection. A successful resume SHALL preserve the prior conversational context and SHALL be visibly identified as resumed rather than fresh.

#### Scenario: A resumable workspace is reopened
- **WHEN** a workspace with a valid saved Agent session is opened on the server that owns that session
- **THEN** the Agent runtime resumes the saved session before accepting the next AI request
- **AND** the workspace communicates that context was resumed

#### Scenario: A fresh workspace is opened
- **WHEN** a workspace has no saved Agent session identifier
- **THEN** it starts a new runtime context
- **AND** the interface does not claim that historical context was resumed

### Requirement: Resume failure never silently becomes fresh context

If a saved Agent session cannot be resumed, the workspace SHALL keep every saved Cell, outcome, and evidence item unchanged, SHALL mark runtime context unavailable, and SHALL NOT send the pending user request through an unrelated fresh context without explicit user action.

#### Scenario: Saved context is unavailable on this server
- **WHEN** a copied, stale, missing, or otherwise unavailable session identifier cannot be resumed
- **THEN** the workspace explains that visible history is not currently in model context
- **AND** the attempted AI turn does not proceed in a fresh session

#### Scenario: A runtime or network error occurs while resuming
- **WHEN** startup of the requested resumed context fails
- **THEN** the error remains actionable and associated with context resumption
- **AND** the saved session identifier is not silently discarded

### Requirement: Users can deliberately start a new runtime context

The workspace SHALL provide an explicit Start new context action. Activating it SHALL disconnect the current Agent runtime, clear the workspace's saved session linkage, and create a fresh context for later AI turns while preserving the complete visible document.

#### Scenario: A live or resumed context is reset
- **WHEN** the user confirms Start new context
- **THEN** subsequent AI work does not use the previous Agent session
- **AND** all existing Cells, outputs, evidence, execution counts, and navigation destinations remain unchanged

#### Scenario: An unavailable context is reset
- **WHEN** the user starts a new context after resume failed
- **THEN** the unavailable state is cleared
- **AND** the next valid AI request can establish a new session link

### Requirement: Older and copied workspaces remain safe and understandable

Workspaces created before context continuity SHALL load without migration loss and SHALL begin with no resumable context. A copied workspace whose saved identifier is not available on the destination server SHALL enter the unavailable flow rather than pretending to continue.

#### Scenario: A version 2 workspace is opened
- **WHEN** the document has no session-link field
- **THEN** all existing Cell and Turn data is restored
- **AND** runtime context is identified as new

#### Scenario: A linked workspace is copied to another server
- **WHEN** the destination cannot resolve the saved Agent session
- **THEN** the copied document remains readable
- **AND** the user can explicitly start a new context without modifying historical evidence
