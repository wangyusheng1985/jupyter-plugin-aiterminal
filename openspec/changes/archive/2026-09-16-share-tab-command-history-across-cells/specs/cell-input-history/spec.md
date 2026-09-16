## MODIFIED Requirements

### Requirement: Editable Command inputs navigate history with arrow keys

An editable cell input in the current workspace tab SHALL use unmodified
`ArrowUp` to move toward older commands and `ArrowDown` to move toward newer
commands while history navigation is active. The history SHALL be shared across
all cells in that tab, including AI cells and newly created cells. Navigation
SHALL begin with `ArrowUp` when the caret is on the first line and no text is
selected, preserving the current input as a draft. Moving down past the newest
entry SHALL restore that draft and end history navigation.

#### Scenario: Up recalls the newest command

- **WHEN** a command was submitted in an earlier cell of the current tab
- **THEN** pressing `ArrowUp` in another editable cell recalls that command

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

#### Scenario: A new AI cell uses the same tab history

- **WHEN** a new editable AI cell is created after a command was submitted in
  another cell
- **THEN** pressing `ArrowUp` in the new AI cell recalls the command

### Requirement: Normal text editing remains available

History navigation SHALL affect only editable cell inputs. Read-only cells,
modified arrow-key commands, text selections, and caret movement within
multiline text SHALL retain normal editor behavior. Editing a recalled command
SHALL end history navigation, and the edited text SHALL become the new draft.

#### Scenario: Arrow keys in an AI cell retain normal behavior

- **WHEN** an AI cell has no command history or the caret is not at a history
  navigation boundary
- **THEN** its arrow keys retain normal editor behavior

#### Scenario: Up inside multiline Command text moves the caret

- **WHEN** the caret is not on the first line of an editable cell
- **THEN** `ArrowUp` retains normal multiline caret movement

#### Scenario: A recalled command is edited

- **WHEN** the user edits text after recalling a history entry
- **THEN** history navigation ends
- **AND** subsequent ordinary arrow navigation follows normal editor behavior

#### Scenario: No command history exists

- **WHEN** the current tab has no submitted Command cells
- **THEN** unmodified arrow keys retain normal editor behavior
