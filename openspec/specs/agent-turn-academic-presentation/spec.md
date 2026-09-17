# agent-turn-academic-presentation Specification

## Purpose

Presents completed and running Agent Turns as a result-first research record:
the outcome reads as notebook prose, followed by one compact audit summary that
reveals the complete ordered execution and bounded raw evidence on demand.

## Requirements

### Requirement: Turn outcomes read as unframed notebook results

The workspace SHALL present the canonical Turn outcome as the first visible
content of an AI cell without an `Outcome`, `Result`, `Diagnostics`, or
`Changes` section label and without placing the outcome inside a decorative
card. Long outcomes SHALL remain bounded until the user explicitly expands
them.

#### Scenario: A completed Turn has a canonical result

- **WHEN** a completed AI Turn has a runtime result or derived Outcome
- **THEN** the result is the first visible content after the cell input
- **AND** it is rendered as normal Markdown prose without a section label or
  decorative container

#### Scenario: A long Outcome is displayed

- **WHEN** the Outcome exceeds the readable preview limit
- **THEN** the cell displays a bounded preview with a visible expansion control
- **AND** expanding the Outcome does not hide the audit summary

#### Scenario: A Turn has no user-facing Outcome

- **WHEN** a Turn completes without a result, assistant text, or meaningful
  final tool output
- **THEN** the cell does not render an empty result area
- **AND** remaining diagnostics or execution evidence stay available through
  the audit summary

### Requirement: One audit summary replaces top-level diagnostic sections

A Turn SHALL expose one compact audit-summary row after the outcome instead of
separate top-level `Diagnostics`, `Changes`, and `Execution` sections. The row
SHALL disclose the ordered execution record and SHALL communicate available
step count, duration, changed-file count, and failure count while omitting
unavailable values.

#### Scenario: A completed Turn has execution activity

- **WHEN** a completed Turn contains one or more activities
- **THEN** the cell displays one audit-summary row
- **AND** the row communicates the activity count and any available duration
  and changed-file count

#### Scenario: A completed Turn has failures

- **WHEN** the Turn contains one or more failed activities or actionable
  diagnostics
- **THEN** the audit summary displays a failure count adjacent to the record
  disclosure
- **AND** the failure is not presented solely through color

#### Scenario: A Turn has no activities

- **WHEN** a Turn completes without execution activities
- **THEN** the cell does not render an empty audit-summary row

#### Scenario: Diagnostics and changes exist

- **WHEN** the Turn contains diagnostics or file mutations
- **THEN** those details are represented inside the audit summary and the
  corresponding execution step
- **AND** no separate top-level `Diagnostics` or `Changes` heading is rendered

### Requirement: The audit record is chronological and tabular

Expanding the audit summary SHALL reveal one chronological execution record.
Each activity SHALL have a row containing its sequence, action, target or
summary, result or status, and duration when available. Repeated activity
types SHALL remain separate in execution order, and rows SHALL NOT be rendered
as nested decorative cards.

#### Scenario: A user expands a multi-step record

- **WHEN** the user expands the audit summary
- **THEN** the workspace reveals an ordered execution record
- **AND** each row exposes the activity sequence, action, target or summary,
  result or status, and available duration

#### Scenario: A tool activity has deterministic summary metadata

- **WHEN** the Turn contains a supported tool activity
- **THEN** its row uses the deterministic tool summary without an additional
  model call
- **AND** the row does not replace the stored tool input or output

#### Scenario: A file mutation contributes to the summary

- **WHEN** one or more activities modify the same file
- **THEN** the audit summary reports the path-level changed-file count
- **AND** the chronological rows continue to show each mutation activity in
  order

#### Scenario: A diagnostic belongs to an activity

- **WHEN** an activity produces an install failure, denied action, runtime
  error, or failed tool result
- **THEN** the corresponding row identifies the failed outcome
- **AND** the detailed diagnostic remains available with that activity

### Requirement: Failure summaries provide direct navigation

The failure count in the audit summary SHALL be an operable control. Activating
it SHALL open the execution record, reveal the first failed activity and its
diagnostic evidence, and bring that activity into view. This behavior SHALL
also be available by keyboard and SHALL respect reduced-motion preferences.

#### Scenario: A user activates the failure count

- **WHEN** the audit summary displays a failure count and the user activates it
- **THEN** the execution record opens
- **AND** the first failed activity is expanded
- **AND** the failed activity is brought into view

#### Scenario: A user activates the failure count by keyboard

- **WHEN** the failure-count control receives keyboard focus and is activated
  with Enter or Space
- **THEN** the same failure navigation occurs

#### Scenario: Reduced motion is requested

- **WHEN** the environment requests reduced motion
- **THEN** failure navigation reveals the failed activity without animated
  scrolling

### Requirement: Evidence disclosure remains bounded and inspectable

Each execution row SHALL be a disclosure control for its stored input and
output evidence. Evidence SHALL be created only after the row is expanded, and
every raw input or output block SHALL have a bounded scroll area that prevents
large evidence from expanding the cell without limit.

#### Scenario: A user expands an execution row

- **WHEN** the user expands an activity row
- **THEN** the workspace reveals its available input and output evidence
- **AND** the expanded evidence is visually associated with that row

#### Scenario: A row contains a large output

- **WHEN** the activity output exceeds the preview or evidence height limit
- **THEN** the evidence area remains bounded and internally scrollable
- **AND** the user can reveal the complete stored output without changing the
  surrounding cell height

#### Scenario: A collapsed record is rendered

- **WHEN** the audit record is collapsed
- **THEN** raw input and output evidence is not created in the DOM
- **AND** the stored evidence remains available for later disclosure

#### Scenario: Scroll state is updated

- **WHEN** the Turn rerenders while the user is reading an expanded evidence
  block
- **THEN** the evidence scroll position and focused control are preserved

### Requirement: Running Turns retain notebook execution context

While a Turn is running, the workspace SHALL keep the newest useful execution
rows visible, retain `[*]` as the cell prompt, and keep the running indicator
at the output tail. Older rows MAY be compacted, but the audit summary and
current activity SHALL remain directly accessible.

#### Scenario: A Turn is running

- **WHEN** an AI cell begins execution
- **THEN** its prompt displays `[*]`
- **AND** the newest activity remains visible without requiring the user to
  expand the completed audit record

#### Scenario: A running Turn completes

- **WHEN** the Turn completes and its audit record was in automatic state
- **THEN** the record collapses into the compact audit summary
- **AND** a record the user explicitly expanded remains expanded

#### Scenario: A cell is queued

- **WHEN** an AI cell is waiting behind another running cell
- **THEN** its prompt displays `[*]`
- **AND** no running audit activity or animation is displayed before execution
  starts

### Requirement: The presentation follows academic notebook visual rules

The Turn presentation SHALL use a restrained academic notebook visual system
consistent with JupyterLab. Outcome prose SHALL use a readable serif treatment,
controls and labels SHALL use the UI font, evidence SHALL use the code font,
and numeric metrics SHALL use tabular figures. The presentation SHALL NOT use
decorative gradients, ornamental cards, nested cards, or color as the only
means of conveying status.

#### Scenario: A supported JupyterLab theme is active

- **WHEN** the workspace is displayed under a light or dark JupyterLab theme
- **THEN** backgrounds, borders, text, links, focus indicators, and status
  colors use theme tokens with readable contrast

#### Scenario: The cell is displayed in a narrow panel

- **WHEN** the available width is narrow or the content contains long paths,
  commands, or unbroken evidence
- **THEN** the outcome and audit rows reflow without horizontal overflow
- **AND** summary metrics do not overlap row controls

#### Scenario: A user operates the audit record by keyboard

- **WHEN** the audit summary, failure count, or activity row receives keyboard
  focus
- **THEN** the control has a visible focus state and exposes its expanded state
  to assistive technology

### Requirement: The redesign preserves Turn data and disclosure state

The academic presentation SHALL reuse the existing Turn outcome, timeline,
diagnostics, changes, metrics, raw evidence, and supported disclosure state.
It SHALL preserve version 2 workspace compatibility and SHALL NOT require a
new snapshot version merely to change the visible presentation.

#### Scenario: A saved workspace is restored

- **WHEN** a workspace containing a Turn is saved and reopened
- **THEN** the outcome, ordered activities, diagnostics, changes, metrics, and
  complete evidence remain available
- **AND** supported outcome, record, activity, and full-evidence disclosure
  choices are restored

#### Scenario: An existing version 2 workspace is opened

- **WHEN** a version 2 workspace created before this presentation change is
  opened
- **THEN** it renders with the academic presentation without data migration
- **AND** no raw tool input or output is discarded

#### Scenario: A cell is rerun

- **WHEN** a cell containing persisted disclosure choices is executed again
- **THEN** the new Turn begins with automatic record disclosure
- **AND** it does not inherit the previous Turn's expanded activity state
