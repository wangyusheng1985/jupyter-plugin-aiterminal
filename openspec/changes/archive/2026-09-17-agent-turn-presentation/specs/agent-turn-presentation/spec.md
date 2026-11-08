## Purpose

Organize each AI execution into a summary-first Turn that keeps the final
outcome, actionable diagnostics, and file changes prominent while exposing
compact activity summaries and complete evidence on demand.

## ADDED Requirements

### Requirement: AI runs are presented as turns

Each AI cell execution SHALL be represented as one Turn containing the
assistant Outcome, an ordered Activity trace, Diagnostics, file Changes, and
execution Metrics. A new execution SHALL replace the cell's previous Turn
presentation while preserving the notebook's existing execution-count and
queued-run behavior.

#### Scenario: An AI cell completes a multi-step task

- **WHEN** an AI cell finishes an execution that contains assistant text and
  one or more tool activities
- **THEN** the cell presents one Turn containing the outcome and an ordered
  activity trace
- **AND** the Turn remains associated with that cell after completion

#### Scenario: An AI cell is run again

- **WHEN** a completed AI cell is executed again
- **THEN** the previous Turn presentation is cleared when the new execution
  starts
- **AND** the new execution creates a new Turn with reset expansion state

### Requirement: Turn outcomes remain the primary result

The workspace SHALL treat the final result reported by the execution runtime as
the canonical Turn Outcome when that result is available. The same final
content SHALL be presented only once, and the Outcome SHALL remain visible by
default unless it exceeds the configured readable preview limit.

#### Scenario: The runtime provides a successful final result

- **WHEN** an AI execution completes successfully and provides a final result
- **THEN** that result is presented as the Turn Outcome
- **AND** it is not duplicated as both a final assistant message and a result

#### Scenario: The runtime does not provide a final result

- **WHEN** an AI execution completes without a runtime-provided final result
  but contains user-facing assistant text
- **THEN** the last user-facing assistant text is presented as the Turn Outcome

#### Scenario: A provider returns only tool output

- **WHEN** an AI execution completes without assistant text or a
  runtime-provided result
- **THEN** the cell presents a concise result from the final meaningful tool
  activity rather than leaving the Outcome area empty

#### Scenario: The final outcome is very long

- **WHEN** a Turn Outcome exceeds the readable preview limit
- **THEN** the Outcome remains visible in a bounded preview
- **AND** the user can expand it to read the complete text

### Requirement: Completed turns default to a focused summary

A completed Turn SHALL default to a focused presentation that keeps the
Outcome, Diagnostics, and file Changes visible while collapsing the detailed
Activity trace into a one-line summary. The summary SHALL communicate useful
turn metadata when available, including activity count, duration, and changed
file count.

#### Scenario: A long completed turn is rendered

- **WHEN** a Turn with many activities completes
- **THEN** its detailed trace is collapsed by default
- **AND** the Outcome remains visible without scrolling through raw tool
  output first
- **AND** the collapsed trace summary communicates that more activity is
  available

#### Scenario: A Turn has no tool activities

- **WHEN** an AI execution completes with only an Outcome
- **THEN** no empty activity trace is displayed
- **AND** the Outcome remains the primary visible content

#### Scenario: A completed turn contains warnings

- **WHEN** a completed Turn contains an error, denied action, failed
  installation, or other actionable diagnostic
- **THEN** the diagnostic remains visible even while the detailed trace is
  collapsed

### Requirement: Running turns prioritize current activity

While a Turn is running, the workspace SHALL keep the current activity and
latest useful output visible while limiting older completed activities to
concise summaries. Running status SHALL remain distinguishable from completed
and queued status.

#### Scenario: A Turn starts running

- **WHEN** an AI cell begins execution
- **THEN** the cell indicates that the Turn is running
- **AND** the running output indicator remains positioned after the newest
  visible activity

#### Scenario: Many activities have already run

- **WHEN** a running Turn has produced more activities than the focused
  activity window
- **THEN** older activities are represented by compact rows
- **AND** the current or most recent activity remains visible without manually
  expanding the trace

#### Scenario: A running Turn completes

- **WHEN** a running Turn transitions to completed
- **THEN** the running indicator is removed
- **AND** an automatically managed trace switches to its completed summary
  state
- **AND** a trace the user explicitly expanded remains expanded

### Requirement: Tool activities provide deterministic summaries

Every tool activity SHALL expose a stable, human-readable primary summary
derived from its tool type, input, result status, and output metadata. The
summary SHALL NOT require an additional model call or alter the stored tool
input or output.

#### Scenario: A file read completes

- **WHEN** a `Read` activity completes
- **THEN** its primary summary identifies the file and communicates available
  line or size information

#### Scenario: A search completes

- **WHEN** a `Glob` or `Grep` activity completes
- **THEN** its primary summary communicates the query and the available match
  or file count

#### Scenario: A shell command completes

- **WHEN** a `Bash` activity completes
- **THEN** its primary summary communicates the command, completion status,
  and available output-size information

#### Scenario: A file mutation completes

- **WHEN** an `Edit` or `Write` activity completes
- **THEN** its primary summary identifies the affected file and communicates
  available change-size information

#### Scenario: An unknown tool completes

- **WHEN** a tool without a specialized presenter completes
- **THEN** the workspace still presents its name, status, and available output
  size without failing to render the Turn

### Requirement: Raw evidence uses progressive disclosure

Tool details SHALL be available through progressive disclosure. Expanding a
step SHALL reveal its input and a bounded output preview, and the user SHALL be
able to reveal the complete raw output without changing the stored evidence.

#### Scenario: A user expands a completed step

- **WHEN** a user expands a tool activity
- **THEN** the workspace reveals the tool input, summary metadata, and a
  bounded output preview
- **AND** the expanded state is visually associated with that step

#### Scenario: A user reveals complete output

- **WHEN** a user requests the complete output of a step
- **THEN** the complete stored output becomes available
- **AND** its presentation remains bounded with internal scrolling

#### Scenario: Raw output is extremely large

- **WHEN** a step contains output far larger than the preview size
- **THEN** the collapsed and preview states do not render the complete output
  at natural height
- **AND** expanding the complete output remains responsive and inspectable

#### Scenario: A user copies evidence

- **WHEN** a user copies text from expanded evidence
- **THEN** the copied text contains the stored content without presentation
  markers or running indicators

### Requirement: Thinking is represented without raw reasoning by default

Model reasoning content SHALL be represented as a thinking activity rather than
ordinary assistant output. The focused presentation SHALL communicate thinking
state without displaying raw reasoning text by default.

#### Scenario: The runtime emits thinking content

- **WHEN** an AI execution emits a thinking block
- **THEN** the Turn represents it as a thinking activity
- **AND** the focused presentation indicates that reasoning occurred without
  exposing the raw reasoning text

#### Scenario: No thinking content is emitted

- **WHEN** an AI execution emits no thinking blocks
- **THEN** the Turn does not display an empty thinking activity

### Requirement: Turn display state is interactive and persistent

The workspace SHALL distinguish automatic, explicitly expanded, and explicitly
collapsed trace states. User expansion choices SHALL override automatic
folding, and supported display state SHALL persist with the workspace.

#### Scenario: A user expands the completed trace

- **WHEN** a user expands the trace of a completed Turn
- **THEN** the trace remains expanded despite automatic completion behavior

#### Scenario: A user collapses a running trace

- **WHEN** a user collapses the trace while a Turn is running
- **THEN** the workspace preserves the user's collapsed choice as new
  activities arrive

#### Scenario: A saved workspace is restored

- **WHEN** a workspace containing Turn display choices is saved and restored
- **THEN** the trace and individually expanded activity states are restored

#### Scenario: The user reruns a cell

- **WHEN** a cell with persisted expansion choices is executed again
- **THEN** the new Turn starts with automatic display state rather than
  inheriting the previous execution's expansion choices

### Requirement: Turn events remain correlated with their cell

Every event belonging to an AI execution SHALL be associated with a stable Turn
identifier. The active cell SHALL receive only events for its active Turn, and
completion of one Turn SHALL not alter the presentation of another cell's Turn.

#### Scenario: An AI cell is active

- **WHEN** assistant, tool, diagnostic, and result events arrive for the active
  Turn
- **THEN** the workspace applies them to the corresponding cell only

#### Scenario: Queued AI cells exist

- **WHEN** one AI Turn is running and other cells are queued
- **THEN** the queued cells remain in their queued presentation state
- **AND** events from the active Turn do not appear in a queued cell

#### Scenario: Turn metrics are available

- **WHEN** the runtime reports duration, turn count, cost, or usage metadata
- **THEN** the workspace retains the metadata with the completed Turn
- **AND** uses available metrics in the Turn summary without inventing missing
  values

### Requirement: Turn snapshots remain compatible across versions

The workspace document SHALL persist the structured Turn representation and
display state in a versioned snapshot. Existing version 1 Agent Workspace
documents SHALL remain readable and SHALL migrate without discarding stored
assistant or tool content.

#### Scenario: A version 2 workspace is saved

- **WHEN** a workspace containing a Turn is saved
- **THEN** the snapshot retains the outcome, activities, diagnostics, changes,
  metrics, and supported display state
- **AND** the complete stored input and output evidence remains available

#### Scenario: A version 1 workspace is opened

- **WHEN** a workspace created with the flat block format is opened
- **THEN** the workspace restores its cells and converts legacy blocks into
  the current Turn presentation
- **AND** no legacy text or tool content is silently discarded

#### Scenario: A running workspace is restored

- **WHEN** a workspace is saved while a Turn is running and then reopened
- **THEN** the cell is restored as interrupted rather than running
- **AND** the persisted partial Turn remains inspectable

### Requirement: Turn presentation preserves notebook behavior and style

The Turn presentation SHALL preserve existing notebook interactions, queue
semantics, output-collapse behavior, JupyterLab visual conventions, and
accessible keyboard operation.

#### Scenario: A queued AI cell is displayed

- **WHEN** an AI cell is waiting in the workspace queue
- **THEN** its prompt displays `[*]`
- **AND** it does not display a running Turn animation before execution starts

#### Scenario: The cell output collapser is used

- **WHEN** the user collapses the output of a cell containing a Turn
- **THEN** the entire cell output remains visible in a bounded, scrollable
  preview
- **AND** expanding the output restores its prior Turn presentation without
  changing stored data

#### Scenario: A user operates the Turn with a keyboard

- **WHEN** a focusable Turn control is selected with a keyboard
- **THEN** the user can expand or collapse the trace and individual activities
  using standard activation keys
- **AND** each control exposes its expanded state to assistive technology

#### Scenario: The workspace uses a JupyterLab theme

- **WHEN** the Turn is displayed under an available JupyterLab theme
- **THEN** surfaces, borders, text, links, focus indicators, and status colors
  use theme tokens and remain distinguishable

#### Scenario: Reduced motion is requested

- **WHEN** the environment requests reduced motion
- **THEN** running and progressive-disclosure states remain understandable
  without continuous animation

#### Scenario: Content is narrow or long

- **WHEN** the cell is displayed in a narrow panel or contains long paths,
  commands, or unbroken output
- **THEN** text and controls remain contained within the cell
- **AND** summary labels do not overlap adjacent controls
