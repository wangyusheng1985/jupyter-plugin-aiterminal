# cell-mode-switching Specification

## Purpose

Provide one notebook-like editable input that defaults to an AI instruction
and treats a leading `!` as a shell escape, without exposing a separate
AI/Command mode selector.

## Requirements

### Requirement: One editable input defaults to AI execution

Every editable workspace cell SHALL use the same input behavior. Source that
does not begin with a leading `!` SHALL be submitted as an AI instruction.

#### Scenario: Ordinary text is submitted to the AI path

- **WHEN** an editable cell contains `explain this repository` and is submitted
- **THEN** the workspace submits it as an AI instruction

#### Scenario: A new workspace starts with the unified input

- **WHEN** a workspace is created
- **THEN** its editable cell accepts an AI instruction without requiring a
  mode or cell-type selection

### Requirement: A leading exclamation mark executes the input as a shell command

When an editable input's first non-whitespace character becomes `!`, the
workspace SHALL classify that submission as a shell command. The marker SHALL
remain visible in the editor and SHALL be removed before the source is sent to
the shell.

#### Scenario: Typing a leading exclamation mark selects shell execution

- **WHEN** an editable input becomes `!pwd` and is submitted
- **THEN** the shell receives `pwd`
- **AND** the editor continues to display `!pwd`

#### Scenario: The marker is retained in shared history

- **WHEN** `!pwd` is submitted
- **THEN** shared input history contains `!pwd`
- **AND** recalling it restores the shell-marked input

#### Scenario: A marker without a command is not submitted

- **WHEN** the user attempts to submit only `!` or whitespace after the marker
- **THEN** no shell request is queued
- **AND** no empty command entry is added to input history

### Requirement: Removing the marker restores AI behavior

Removing the leading `!` from an editable input SHALL return that input to the
default AI instruction path without discarding the remaining source.

#### Scenario: Deleting the marker removes shell classification

- **WHEN** an input containing `!pwd` is edited to `pwd`
- **THEN** `pwd` remains in the editor
- **AND** submitting it follows the AI instruction path

### Requirement: AI and Command mode controls are removed

The workspace SHALL NOT display a cell-type selector, a prompt double-click
toggle, or per-cell `AI`/`sh` badges. Execution classification SHALL be derived
from the submitted source instead of a user-selected mode.

#### Scenario: Toolbar has no cell-type selector

- **WHEN** a workspace is opened
- **THEN** its toolbar does not show an AI/Command type selector
- **AND** inserting or running a cell does not require choosing a type

#### Scenario: Input prompt has no mode badge

- **WHEN** an editable input is displayed
- **THEN** its prompt does not show an `AI` or `sh` mode label
- **AND** double-clicking the prompt does not change execution mode

### Requirement: Shell escape execution is temporary

When an input beginning with `!` is submitted with run-and-advance, the
executed cell SHALL retain its result and the next empty input SHALL use the
default AI path.

#### Scenario: Run-and-advance returns to AI input

- **WHEN** `!pwd` is submitted with run-and-advance
- **THEN** the executed cell keeps its shell result and `!pwd` source
- **AND** the next empty input is editable and focused
- **AND** submitting ordinary text there follows the AI instruction path

### Requirement: Legacy Command cells use the unified input behavior

When a workspace with legacy Command cells is restored, those cells SHALL be
normalized into the unified editable input. Their source SHALL gain a visible
`!` marker if it does not already have one so shell execution is preserved.

#### Scenario: A legacy command is restored

- **WHEN** a saved workspace contains a Command cell with source `pwd`
- **THEN** reopening it displays `!pwd` in the unified editor
- **AND** submitting it executes the shell command `pwd`
- **AND** deleting `!` turns the input into an AI instruction

#### Scenario: An already marked legacy command is not duplicated

- **WHEN** a saved workspace contains a Command cell with source `!pwd`
- **THEN** reopening it displays `!pwd`
- **AND** does not add a second marker
