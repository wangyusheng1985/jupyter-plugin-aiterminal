## Purpose

Share one DSH runtime across the AI sessions of a Jupyter server so each workspace runs in parallel without starting its own runtime process.

## ADDED Requirements

### Requirement: One Jupyter server uses one DSH runtime

The system SHALL run at most one DSH runtime process for all AI sessions owned by one Jupyter server process. Opening another `.agentnb` SHALL create or resume an ACP session on that runtime and SHALL NOT start another DSH runtime process.

#### Scenario: Three workspaces are open

- **WHEN** three `.agentnb` documents are open and each has an AI session
- **THEN** the Jupyter server has exactly one DSH runtime process
- **AND** each document has a distinct ACP session

#### Scenario: A second workspace opens after the runtime exists

- **WHEN** one AI session is already live and another `.agentnb` starts an AI session
- **THEN** the second session is created on the existing runtime
- **AND** the first session remains usable

### Requirement: Sessions run prompts in parallel

The system SHALL allow one active prompt on each ACP session at the same time. A prompt on one session MUST NOT block or cancel a prompt on another session.

#### Scenario: Two workspaces run together

- **WHEN** two different `.agentnb` documents each submit an AI prompt while the other prompt is still running
- **THEN** both prompts execute
- **AND** each prompt's events are delivered only to its own session

#### Scenario: One session receives a second prompt

- **WHEN** an AI prompt is submitted to a session that already has an active prompt
- **THEN** the system rejects the second prompt
- **AND** the active prompt continues

### Requirement: Session boundaries remain isolated

Each ACP session SHALL keep the workspace directory supplied for its `.agentnb`. A session MUST NOT inherit another session's directory, conversation, or turn state.

#### Scenario: Workspaces use different directories

- **WHEN** two sessions are created for different workspace directories
- **THEN** each session reports and uses its own directory
- **AND** neither session's files or events are attributed to the other

### Requirement: Cancellation is limited to one session

An interrupt for one workspace SHALL cancel only that session's active prompt. It MUST NOT stop the shared runtime or any other session.

#### Scenario: One of two running prompts is interrupted

- **WHEN** the user interrupts the active AI turn in one workspace while another workspace is also running
- **THEN** only the interrupted session's prompt is cancelled
- **AND** the other session's prompt continues on the same runtime

### Requirement: Runtime shutdown follows the Jupyter server

The shared runtime SHALL remain available until the Jupyter server shuts down or the runtime itself fails. Closing an individual ACP session MUST NOT terminate the runtime while another session exists or another workspace can still attach.

#### Scenario: One workspace session is closed explicitly

- **WHEN** one workspace explicitly shuts down its AI session and another session is still attached
- **THEN** only that ACP session is closed
- **AND** the shared runtime and the other session remain available

#### Scenario: The Jupyter server shuts down

- **WHEN** the Jupyter server process shuts down
- **THEN** the shared runtime is terminated
- **AND** no detached AI prompt continues after that shutdown
