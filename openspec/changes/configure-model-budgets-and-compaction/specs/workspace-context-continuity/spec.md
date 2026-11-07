## ADDED Requirements

### Requirement: Compaction does not break context continuity

When the runtime compacts its working context inside a live ACP session, the workspace SHALL keep its saved session identifier, keep the runtime context state live, and SHALL NOT treat compaction as a reset, a resume failure, or a new context.

#### Scenario: Compaction occurs during a long conversation

- **WHEN** the runtime compacts context while the workspace's session is live
- **THEN** the saved session identifier is unchanged
- **AND** the workspace still reports the context as live
- **AND** subsequent AI turns continue in the same session

#### Scenario: A reopened workspace had been compacted

- **WHEN** a workspace whose session was compacted earlier is reopened and the session resumes
- **THEN** the resume is reported as resumed context
- **AND** the workspace does not present compaction as lost history or as a fresh context

### Requirement: Compaction status is never substituted for a real context transition

The workspace SHALL distinguish an automatic context compaction from an explicit Start new context action and from a resume failure. It MUST NOT reuse compaction status to explain a context that could not be resumed, and MUST NOT reuse a reset or resume-failure state to represent compaction.

#### Scenario: Compaction and reset are both candidates

- **WHEN** the workspace needs to explain why earlier conversation content is no longer in model context
- **THEN** it reports the actual cause it observed
- **AND** does not attribute an automatic compaction to a user reset or a resume failure

#### Scenario: A configuration is pending for the next runtime start

- **WHEN** a budget or compaction configuration is marked `pending-next-runtime`
- **THEN** the workspace keeps reporting the current live context
- **AND** does not present the pending configuration as a context reset, a resume failure, or a new context

#### Scenario: An unobservable compaction state

- **WHEN** the runtime provides no compaction-specific status while the session is live
- **THEN** the workspace keeps reporting normal live context
- **AND** does not display a context-loss or reset warning
