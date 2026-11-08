# cell-execution-queue Specification

## Purpose

Let users submit AI and Command cell runs while another run is active, with
notebook-like FIFO scheduling and clear queued/running feedback in the same
workspace.

## Requirements

### Requirement: Runs use a single workspace FIFO queue

The workspace SHALL accept a valid run request while another AI or Command cell
is executing and SHALL queue it for later execution. At most one cell request
SHALL be sent to the workspace session at a time, and queued requests SHALL
start in submission order.

#### Scenario: A second cell is run while another cell is active

- **WHEN** a cell is running and the user runs a different non-empty cell
- **THEN** the second cell enters the queued state
- **AND** its request does not reach the workspace session until the first
  request has terminated

#### Scenario: Several cells are submitted before the first finishes

- **WHEN** multiple cells are run while the first request is still active
- **THEN** they are retained in submission order
- **AND** they execute one at a time in that same order

#### Scenario: The same cell is submitted more than once

- **WHEN** the user runs a cell while it already has a queued request
- **THEN** another queued request is appended
- **AND** each submission executes independently in FIFO order

### Requirement: A queued run captures its execution input

Each queue entry SHALL retain the submitted cell identity, cell kind, and source
text from the moment the user runs it. Later edits to the visible cell SHALL NOT
change the input of an already queued request.

#### Scenario: Source is edited after queueing

- **WHEN** a user queues a cell and then edits its source before the request
  starts
- **THEN** the request executes the source that was present at submission time

#### Scenario: A queued cell is deleted

- **WHEN** the user deletes a cell that has one or more queued requests
- **THEN** those queued requests are removed
- **AND** the relative order of all other queued requests is preserved

#### Scenario: A queued cell changes kind

- **WHEN** the user changes a queued cell between AI and Command before its
  request starts
- **THEN** the queued request for the previous cell kind is removed

### Requirement: Queue and execution state are visible in notebook prompts

A cell with a queued or actively running request SHALL display `[*]` in its
prompt. A numeric execution count SHALL be assigned only when that request
starts executing, and completed cells SHALL retain that count until they are run
again.

#### Scenario: A run is queued behind another cell

- **WHEN** a cell is waiting in the queue
- **THEN** its prompt displays `[*]`
- **AND** its previous output remains visible until the queued request starts

#### Scenario: A queued request starts

- **WHEN** the preceding request terminates and the queued request starts
- **THEN** the cell changes from queued to running
- **AND** it receives the next numeric execution count
- **AND** its previous output and AI blocks are cleared

#### Scenario: A queued request waits with no previous output

- **WHEN** a previously idle cell enters the queued state
- **THEN** its output prompt displays `[*]`
- **AND** no running animation is shown until that request starts

### Requirement: Queue progression is independent of request outcome

When the active request completes, fails, or is interrupted, the workspace
SHALL release the active slot and start the next queued request if one exists.
An error in one request SHALL NOT discard or reorder later requests.

#### Scenario: The active command fails

- **WHEN** a running Command cell terminates with a failure result
- **THEN** its result and failure status are retained
- **AND** the next queued request starts

#### Scenario: The active AI request returns an error

- **WHEN** an active AI request ends with an error
- **THEN** the error remains associated with that AI cell
- **AND** the next queued request starts

#### Scenario: The queue becomes empty

- **WHEN** the final queued request finishes
- **THEN** no cell remains in the queued or running state

### Requirement: Interrupt affects only the active request

Interrupting execution SHALL target the currently running request and SHALL
leave queued requests pending. After the interrupted request terminates, the
next queued request SHALL start normally.

#### Scenario: Interrupt while requests are queued

- **WHEN** the user interrupts the active request while later requests are
  queued
- **THEN** the active request enters an interrupted state
- **AND** the queued requests remain in their existing order
- **AND** the first queued request starts after the active request terminates

### Requirement: Queue state is ephemeral

Queue membership and queued status SHALL NOT be restored as active work after
the workspace is saved, reloaded, or reopened. A previously queued request
SHALL NOT execute automatically after restoration.

#### Scenario: A document is saved with queued cells

- **WHEN** a workspace containing queued requests is serialized
- **THEN** no queue entry is persisted
- **AND** those cells are restored without a pending request

#### Scenario: A workspace is closed with queued cells

- **WHEN** the workspace closes while requests remain queued
- **THEN** the pending requests are discarded

### Requirement: Run-and-advance remains usable during active execution

Submitting a run-and-advance command SHALL move the selected cell to the next
editable position immediately after enqueueing, without waiting for the queued
request to start.

#### Scenario: Run and advance while another request is active

- **WHEN** the user submits a cell with run-and-advance while another request is
  already running
- **THEN** the submitted request is queued
- **AND** the active cell moves to the next editable position
- **AND** completion of the queued request does not move the user's current
  selection
