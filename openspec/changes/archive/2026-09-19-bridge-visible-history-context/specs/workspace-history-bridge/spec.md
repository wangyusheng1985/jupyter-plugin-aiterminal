## Purpose

Prevent visible `.agentnb` history from silently diverging from the model's real context by requiring an explicit continuity choice and carrying a bounded, read-only history bridge into a fresh Agent session when selected.

## ADDED Requirements

### Requirement: Uncovered visible history blocks silent AI submission

When a workspace contains one or more submitted AI Cells that are not covered by a resumable Agent session, the workspace SHALL stop the next AI submission before any model request is sent and SHALL preserve the current draft unchanged. A workspace without submitted AI history SHALL continue to start normally, and Command execution SHALL remain independent of the unresolved AI-context choice.

#### Scenario: A migrated workspace has visible AI history but no session link
- **WHEN** the user submits an AI draft in a workspace whose saved AI Cells are visible but whose Agent session ID is absent
- **THEN** no model request is sent
- **AND** the draft remains selected and unchanged while the workspace asks how to start context

#### Scenario: A new empty workspace is submitted
- **WHEN** the workspace has no submitted AI Cells and no saved Agent session
- **THEN** the AI draft starts in a new context without a history choice

#### Scenario: A Command is submitted while history choice is unresolved
- **WHEN** visible AI history is uncovered and the user submits a valid Command Cell
- **THEN** the command executes normally
- **AND** no AI history capsule or model request is produced

### Requirement: Users explicitly choose bridged or empty context

The unresolved-history presentation SHALL provide **Continue from visible history** as its primary action and **Start empty context** as a distinct alternative. The choice SHALL explain that bridging sends a bounded read-only representation rather than restoring the original SDK session, SHALL be operable by keyboard, and SHALL not execute through a hover-only or accidental single action outside the focused choice. Escape or dismissal SHALL return focus to the preserved draft without sending it.

#### Scenario: User continues from visible history
- **WHEN** the user attempted to submit an AI draft and activates Continue from visible history
- **THEN** the preserved draft is submitted once with a deterministic history capsule
- **AND** the action becomes unavailable while that submission is being accepted

#### Scenario: User starts empty context
- **WHEN** the user activates Start empty context for the preserved draft
- **THEN** that draft is submitted once without a history capsule
- **AND** all previous Cells remain visible but outside the new model context

#### Scenario: User dismisses the choice
- **WHEN** the choice is open and the user presses Escape or dismisses it
- **THEN** no model request is sent
- **AND** keyboard focus returns to the unchanged draft

#### Scenario: Context choice is displayed in a narrow workspace
- **WHEN** the available panel width cannot show both explanations and actions inline
- **THEN** the choice reflows without horizontal overflow or obscuring the focused action
- **AND** both actions retain visible labels and focus indicators

### Requirement: The history capsule is deterministic and bounded

The workspace SHALL derive the bridge locally from at most the eight most recent submitted AI Cells preceding the current draft and SHALL cap the complete serialized capsule at 12,000 characters. It SHALL include each selected Cell's stable ID, source, completion state, bounded final outcome, and eligible background-task references in chronological order. Selection, truncation, and serialization SHALL require no model request and SHALL produce the same capsule for the same saved document state.

#### Scenario: Fewer than eight AI Turns are available
- **WHEN** the user chooses continuity with fewer than eight eligible AI Cells
- **THEN** every eligible Cell is represented in chronological order within the capsule

#### Scenario: Long history exceeds the bridge limits
- **WHEN** more than eight AI Cells or more than 12,000 serialized characters are available
- **THEN** the bridge retains the newest eligible history within both limits
- **AND** communicates that older or truncated content was omitted

#### Scenario: Only streamed output revisions change
- **WHEN** a saved Cell's source, final outcome, status, and background-task references are unchanged
- **THEN** output-only presentation revisions do not change the capsule

### Requirement: Bridging never replays historical actions

The bridge SHALL treat historical text and task references as quoted, read-only context. It SHALL NOT enqueue old Cells, replay tool inputs, execute saved shell commands, read referenced output files, or make a separate summarization request. The current draft SHALL remain the latest actionable user request, and the document SHALL continue to store the original draft rather than the composed bridge prompt.

#### Scenario: Historical Cells contain destructive commands
- **WHEN** the selected history includes tool inputs that deleted or modified resources
- **THEN** those commands are not serialized as instructions to execute
- **AND** no historical Cell is queued or rerun

#### Scenario: A background-task output path is available
- **WHEN** the selected history contains a saved server-local task output path
- **THEN** the bridge identifies the path as evidence that must be revalidated
- **AND** AI Terminal does not read the file while building or sending the capsule

#### Scenario: A bridged request is persisted
- **WHEN** the bridged AI request is accepted and the workspace is saved
- **THEN** the Cell source contains only the user's original draft
- **AND** the serialized capsule and composed model prompt are not added as visible Cells or raw transcript fields

### Requirement: Saved tool evidence yields durable background-task references

The workspace SHALL derive background-task references only from persisted tool blocks with valid task identifiers and output locations, and SHALL update their last known state from later persisted task-result evidence when available. Malformed or incomplete provider text SHALL be ignored safely. A derived reference SHALL identify its source Cell and remain usable after close, reopen, or frontend reload without claiming that the underlying process is still running.

#### Scenario: A tool starts a background task
- **WHEN** a saved tool result contains a valid background task ID and output location
- **THEN** the history projection exposes a reference associated with that source Cell
- **AND** labels its runtime state as last known rather than live truth

#### Scenario: Later evidence reports task completion or failure
- **WHEN** a later saved task-result block refers to the same task ID
- **THEN** the derived reference reflects the latest saved completion or failure state

#### Scenario: Task metadata is malformed
- **WHEN** provider output lacks a valid task ID or usable output location
- **THEN** no background-task reference is created from that output
- **AND** ordinary Turn evidence remains unchanged

### Requirement: Context boundaries remain durable and truthful

After a bridged or empty-context submission establishes a new Agent session, the workspace SHALL persist the first native Cell in that context and the stable IDs of Cells included by the bridge. Reopening or resuming SHALL preserve the distinction between bridged history, native context, and visible history that was not included. Starting another new context SHALL preserve prior evidence while creating a new boundary rather than rewriting old membership.

#### Scenario: A bridged context succeeds and is reopened
- **WHEN** a bridged first Turn completes successfully, saves its real session ID, and the workspace is reopened
- **THEN** the interface identifies the session as resumed
- **AND** the same Cells remain marked bridged, native, or outside context

#### Scenario: User chooses an empty context
- **WHEN** the first empty-context Turn is accepted
- **THEN** that Cell becomes the first native Cell of the new context
- **AND** every older Cell remains marked outside context

#### Scenario: Accepted work is closed before its final result
- **WHEN** the SDK accepts the first Turn in a context and the workspace closes before a final result arrives
- **THEN** the accepted event provides the real resumable session identifier
- **AND** the workspace persists that identifier together with native and bridged membership before the focused acceptance control is dismissed
- **AND** reopening does not silently continue the accepted Cell in an unrelated fresh context

#### Scenario: An older document has no boundary metadata
- **WHEN** a version 1, 2, or 3 document is restored without context-boundary fields
- **THEN** all Cell content and disclosure state are preserved
- **AND** submitted AI Cells are treated as uncovered unless a valid saved session explicitly covers them

#### Scenario: A version 4 boundary has no resumable session link
- **WHEN** a version 4 document contains current native or bridged membership but its session identifier is missing or invalid
- **THEN** current native Cells and non-empty current bridge membership are treated as uncovered
- **AND** prior-generation boundary evidence and an explicit empty-context policy remain preserved

### Requirement: Context membership is visible and accessible

The workspace SHALL communicate current context membership through explicit text and a non-color navigation cue. Wide layouts SHALL expose the current context state and covered-history count without expanding the rail into a permanent transcript, while narrow layouts SHALL keep the information available through the existing context/history disclosures. Screen-reader names SHALL distinguish bridged, native, and outside-context Cells.

#### Scenario: Bridged and excluded Cells coexist
- **WHEN** only the newest eligible Cells were included in a bounded bridge
- **THEN** navigation exposes a distinct non-color cue for bridged and excluded Cells
- **AND** their accessible names state the relevant membership

#### Scenario: Current context is resumed after bridging
- **WHEN** a bridged session is reopened successfully
- **THEN** the overview communicates both Resumed and the bridged-history count
- **AND** does not imply that excluded visible Cells are in model context

#### Scenario: Reduced motion is requested
- **WHEN** context choice or boundary navigation changes while reduced motion is enabled
- **THEN** the final state appears without animated scrolling or motion-dependent meaning

### Requirement: Resume failure remains fail closed with recovery choices

A failed saved-session resume SHALL continue to block pending AI work and preserve the saved identifier for diagnosis. The workspace MAY offer Continue from visible history or Start empty context only as explicit recovery actions; choosing either SHALL replace the unavailable linkage deliberately and SHALL NOT silently retry the original request against a fresh context.

#### Scenario: Saved context cannot be resumed
- **WHEN** the server reports that the saved Agent session is unavailable
- **THEN** the pending AI draft is not sent through a fresh context
- **AND** the user can inspect the failure before choosing a recovery path

#### Scenario: User bridges after resume failure
- **WHEN** the user explicitly chooses Continue from visible history after inspecting the unavailable state
- **THEN** the stale linkage is replaced by a new context with the bounded history capsule
- **AND** every saved Cell and evidence block remains unchanged
