## Purpose

Keep an AI session and its in-flight turn running after the browser disconnects, and make the resulting work visible when the same workspace opens again.

## ADDED Requirements

### Requirement: Browser disconnect does not stop an AI turn

Closing, refreshing, or otherwise disconnecting the browser SHALL detach the workspace from its AI session without cancelling the active prompt or closing the ACP session. Command-cell shell processes remain outside this requirement and MAY stop when their connection closes.

#### Scenario: The browser closes during an AI turn

- **WHEN** an AI prompt is running and the browser tab or WebSocket disconnects
- **THEN** the prompt continues on the server
- **AND** the ACP session remains resumable
- **AND** no interrupt is sent because of the disconnect

#### Scenario: The page refreshes during an AI turn

- **WHEN** the user refreshes JupyterLab while an AI prompt is running
- **THEN** the prompt is not cancelled by the refresh
- **AND** the workspace can attach to the same session again

### Requirement: Detached progress is saved in the workspace document

While no browser is attached, the server SHALL persist the session's turn progress and terminal result into the `.agentnb` that owns the session. While a browser is attached, that browser owns the file and persists the terminal events it receives; the server MUST NOT rewrite the document behind the browser's contents hash. The saved document SHALL be sufficient to show the turn after reopening without replaying a live event stream. A terminal write MUST NOT replace a newer turn or a newer frontend snapshot on the same cell.

#### Scenario: A turn finishes after the browser closes

- **WHEN** an AI prompt completes while its workspace has no attached browser
- **THEN** the server writes the terminal result into that workspace's `.agentnb`
- **AND** the saved cell is no longer marked running

#### Scenario: The browser reopens before the turn finishes

- **WHEN** the workspace is reopened while its detached prompt is still running
- **THEN** the document shows the saved progress
- **AND** the reattach handshake reports the active turn id and owning cell id
- **AND** replayed and later events for that turn carry both identities
- **AND** the page claims that turn instead of treating the cell as interrupted

#### Scenario: The turn finishes after reattach

- **WHEN** a reattached page is open while the same turn reaches a terminal state
- **THEN** the browser persists the terminal result from the events it receives
- **AND** the server does not rewrite the document while that browser is attached
- **AND** the browser save does not overwrite a different newer turn id
- **AND** a frontend snapshot with a strictly newer `updatedAt` remains authoritative

### Requirement: Reopening shows the same session result

Reopening a `.agentnb` SHALL attach to its existing ACP session when that session is still live. The workspace SHALL show the result produced while it was detached and SHALL NOT start a replacement session for that document.

#### Scenario: Reopen after detached completion

- **WHEN** the user reopens a workspace whose AI prompt completed while detached
- **THEN** the completed result is visible in the document
- **AND** the workspace retains the same session identity

#### Scenario: The saved session cannot be resumed

- **WHEN** the user reopens a workspace and its saved session cannot be resumed
- **THEN** the system reports the existing resume-unavailable state
- **AND** does not silently create a replacement session or discard the saved document

### Requirement: Explicit shutdown is distinct from disconnect

The system SHALL close an ACP session only when the user explicitly shuts down that workspace context or the Jupyter server shuts down. A browser disconnect MUST NOT be treated as explicit shutdown.

#### Scenario: The user shuts down the workspace context

- **WHEN** the user explicitly shuts down the workspace AI context
- **THEN** the active prompt is cancelled if one is running
- **AND** that ACP session is closed
- **AND** reopening the document does not attach to the closed session as if it were still running
