# workspace-save-reliability Specification

## Purpose

Make every visible AI Terminal workspace mutation durably and truthfully saved, with recoverable failure feedback instead of silent console-only data-loss risk.

## Requirements

### Requirement: Workspace saves are single-flight and latest-state preserving

The workspace SHALL run at most one document save at a time. Mutations received while a save is pending or running SHALL be coalesced into a follow-up save of the latest complete workspace snapshot, without dropping Cell, Turn, Agent-context, navigation, or presentation state.

#### Scenario: Rapid mutations arrive before the debounce expires
- **WHEN** multiple workspace mutations occur within the save debounce interval
- **THEN** the workspace performs one save using the latest complete snapshot

#### Scenario: A mutation arrives during an in-flight save
- **WHEN** the document changes after a save starts but before that save resolves
- **THEN** no parallel save is started
- **AND** a follow-up save persists the newest snapshot after the in-flight save settles

#### Scenario: Nothing changed after the last successful save
- **WHEN** persistence is requested without a newer workspace revision
- **THEN** no redundant document save is performed

### Requirement: Save truth is continuously visible and accessible

The workspace SHALL expose saved, pending/saving, and failed persistence states in its existing status region. The state SHALL use explicit text and semantics rather than color alone, SHALL reflow without horizontal page scrolling, and SHALL update through one atomic polite status announcement without stealing keyboard focus.

#### Scenario: A local mutation is awaiting persistence
- **WHEN** the workspace changes before or during a save
- **THEN** the status stops claiming the document is saved and communicates that saving is pending or active

#### Scenario: The newest revision is durably saved
- **WHEN** the save covering the newest workspace revision resolves successfully
- **THEN** the status communicates Saved

#### Scenario: Saving fails
- **WHEN** the document save rejects
- **THEN** a persistent Not saved state remains visible
- **AND** a keyboard-accessible Retry save action is available
- **AND** Agent or Command execution state is not replaced or hidden by the save error

#### Scenario: Save state changes while another control is focused
- **WHEN** saving begins, succeeds, or fails while the user is editing or navigating
- **THEN** the current keyboard focus remains unchanged
- **AND** assistive technology receives one meaningful contextual status update

### Requirement: Save failures are recoverable without duplicate writes

A failed save SHALL retain the newest unsaved revision. Activating Retry save or making a later workspace mutation SHALL be able to start a new single-flight attempt, and successful recovery SHALL clear the failed state only after the newest revision is durably saved.

#### Scenario: User retries a failed save
- **WHEN** the user activates Retry save after a failure
- **THEN** exactly one new save attempt starts with the latest snapshot
- **AND** the retry action cannot create overlapping attempts

#### Scenario: Workspace changes after a failed save
- **WHEN** a new mutation occurs while Not saved is displayed
- **THEN** the new revision remains dirty
- **AND** the normal debounce may start one recovery attempt covering both the failed and new changes

#### Scenario: Retry fails again
- **WHEN** a recovery save also rejects
- **THEN** Not saved and Retry save remain available
- **AND** no revision is falsely reported as saved

### Requirement: Workspace shutdown flushes pending persistence

The workspace SHALL cancel its debounce and start saving the latest snapshot when shutdown begins. It SHALL wait for any in-flight save and required follow-up save in its asynchronous shutdown path before disconnecting the Agent session, while preserving the existing single-flight shutdown behavior.

#### Scenario: Workspace closes during the debounce window
- **WHEN** shutdown begins with a dirty snapshot that has not started saving
- **THEN** the latest snapshot is submitted for save immediately

#### Scenario: Workspace closes during an in-flight save
- **WHEN** shutdown begins while an older revision is saving and a newer revision is dirty
- **THEN** the workspace waits for the current save and one coalesced latest-state save
- **AND** the Agent session closes after the persistence drain settles

#### Scenario: Shutdown save fails
- **WHEN** the final save rejects during shutdown
- **THEN** shutdown still releases the Agent session
- **AND** the failure is recorded through the same save-error reporting path rather than becoming an unhandled rejection

### Requirement: Save coordination does not change document compatibility

Save phase, error text, retry state, revision counters, and debounce state SHALL remain runtime-only. The serialized `.agentnb` schema and restored workspace content SHALL remain unchanged for an equivalent notebook state.

#### Scenario: Workspace is saved successfully
- **WHEN** the save coordinator persists a workspace
- **THEN** the `.agentnb` contains only the existing versioned workspace snapshot
- **AND** it contains no save-state metadata or error details

#### Scenario: Existing workspace is reopened
- **WHEN** a compatible `.agentnb` created before this capability is opened
- **THEN** its Cells, Turns, context linkage, execution counts, and presentation choices restore without migration loss
- **AND** its runtime save state begins as Saved after document readiness
