## Purpose

Provide shell-style Command cell history that is isolated to each workspace tab
so users can quickly recall and reuse commands without mixing work from other
tabs.

## ADDED Requirements

### Requirement: Command history is isolated by workspace tab

Each open workspace tab SHALL maintain its own Command cell history. A history
entry created in one tab SHALL NOT be available for navigation in another tab.
History SHALL be limited to the lifetime of the open workspace tab and SHALL
NOT be serialized into the workspace document.

#### Scenario: Different tabs have independent histories

- **WHEN** a command is submitted in one workspace tab and a new Command cell
  input is opened in another workspace tab
- **THEN** pressing `ArrowUp` in the second tab does not recall the first tab's
  command

#### Scenario: A workspace is saved and reopened

- **WHEN** a workspace with Command history is saved, closed, and reopened
- **THEN** its previous session history is not restored

### Requirement: Submitted commands are recorded for recall

The workspace SHALL add every accepted, non-empty Command cell submission to
the current tab's history at submission time, including commands that are
queued, fail, or are interrupted. AI cell submissions SHALL NOT be added.
Whitespace-only submissions and consecutive duplicate commands SHALL NOT create
new history entries.

#### Scenario: A queued command is recorded before execution

- **WHEN** a Command cell is accepted while another request is running
- **THEN** its source is available in history immediately
- **AND** it remains available if the queued command later fails or is
  interrupted

#### Scenario: Duplicate commands are submitted consecutively

- **WHEN** the same non-empty command is submitted twice without another
  command between them
- **THEN** history contains one entry for that command

#### Scenario: An AI submission is not command history

- **WHEN** an AI cell is submitted
- **THEN** it is not added to the Command cell history

### Requirement: Editable Command inputs navigate history with arrow keys

An editable Command cell input SHALL use unmodified `ArrowUp` to move toward
older entries and `ArrowDown` to move toward newer entries while history
navigation is active. Navigation SHALL begin with `ArrowUp` when the caret is
on the first line and no text is selected, preserving the current input as a
draft. Moving down past the newest entry SHALL restore that draft and end
history navigation.

#### Scenario: Up recalls the newest command

- **WHEN** a Command cell input is empty and the tab has command history
- **THEN** pressing `ArrowUp` shows the most recently submitted command

#### Scenario: Repeated Up navigates to older commands

- **WHEN** history navigation is active
- **THEN** repeated `ArrowUp` presses move through entries from newest to
  oldest without changing the stored order

#### Scenario: Down returns to the draft

- **WHEN** history navigation is active
- **THEN** `ArrowDown` moves toward newer entries
- **AND** pressing `ArrowDown` after the newest entry restores the draft that
  was present when navigation began

#### Scenario: The oldest and newest boundaries are stable

- **WHEN** navigation reaches the oldest entry and `ArrowUp` is pressed again
- **THEN** the oldest entry remains visible
- **AND** when navigation reaches the draft and `ArrowDown` is pressed again
- **THEN** the draft remains visible

### Requirement: Normal text editing remains available

History navigation SHALL affect only editable Command cell inputs. AI cell
inputs, read-only cells, modified arrow-key commands, text selections, and
caret movement within multiline Command text SHALL retain normal editor
behavior. Editing a recalled command SHALL end history navigation, and the
edited text SHALL become the new draft.

#### Scenario: Arrow keys in an AI cell retain normal behavior

- **WHEN** the user presses unmodified `ArrowUp` or `ArrowDown` in an AI cell
- **THEN** the input does not change to a Command history entry

#### Scenario: Up inside multiline Command text moves the caret

- **WHEN** the caret is not on the first line of an editable Command cell
- **THEN** `ArrowUp` retains normal multiline caret movement

#### Scenario: A recalled command is edited

- **WHEN** the user edits text after recalling a history entry
- **THEN** history navigation ends
- **AND** subsequent ordinary arrow navigation follows normal editor behavior
