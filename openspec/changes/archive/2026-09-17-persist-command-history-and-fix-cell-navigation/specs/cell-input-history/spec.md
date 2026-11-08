## MODIFIED Requirements

### Requirement: Command history is isolated by workspace tab

Each workspace document SHALL maintain one shared input history containing
accepted AI and Command submissions. Entries from one workspace document SHALL
NOT be available for navigation in another document. History SHALL persist in
browser storage across browser reloads and JupyterLab restarts and SHALL be
restored when the same workspace document is opened again. History SHALL NOT
be serialized into the workspace document.

#### Scenario: Different tabs have independent histories

- **WHEN** an AI or Command input is submitted in one workspace tab and an
  editable cell is opened in another workspace tab
- **THEN** pressing `ArrowUp` in the second tab does not recall the first tab's
  input

#### Scenario: AI and Command cells share one history

- **WHEN** a Command input and an AI input are submitted in the same workspace
  tab
- **THEN** pressing `ArrowUp` in either cell type recalls both submissions in
  newest-to-oldest order

#### Scenario: A workspace is saved and reopened

- **WHEN** a workspace with AI and Command history is saved, closed, and
  reopened
- **THEN** pressing `ArrowUp` in an editable cell recalls its previous AI and
  Command submissions

#### Scenario: JupyterLab restarts

- **WHEN** JupyterLab restarts and the same workspace is opened again in the
  same browser origin
- **THEN** its shared input history is restored without requiring a new
  submission

### Requirement: Submitted commands are recorded for recall

The workspace SHALL add every accepted, non-empty AI or Command submission to
the current workspace tab's shared history at submission time, including
requests that are queued, fail, or are interrupted. Whitespace-only submissions
and consecutive duplicate inputs SHALL NOT create new history entries. An AI
draft that has not been submitted SHALL NOT be recorded.

#### Scenario: A queued command is recorded before execution

- **WHEN** a Command input is accepted while another request is running
- **THEN** its source is available in shared history immediately
- **AND** it remains available if the queued request later fails or is
  interrupted

#### Scenario: An AI submission is not command history

- **WHEN** an AI input is submitted
- **THEN** it is added to the shared workspace input history as an AI-origin
  entry
- **AND** pressing `ArrowUp` in a later Command or AI cell recalls it

#### Scenario: Duplicate commands are submitted consecutively

- **WHEN** the same non-empty input is submitted twice without another input
  between them, regardless of cell kind
- **THEN** history contains one entry for that input

#### Scenario: An unsubmitted draft is not recorded

- **WHEN** text is entered into an AI or Command cell but is not submitted
- **THEN** that draft is not added to shared history

### Requirement: Editable Command inputs navigate history with arrow keys

An editable cell input in the current workspace tab SHALL use unmodified
`ArrowUp` to move toward older AI or Command submissions and `ArrowDown` to
move toward newer submissions while history navigation is active. The history
SHALL be shared across all cells in that tab, including AI cells, Command
cells, and newly created cells. Navigation SHALL begin with `ArrowUp` when the
caret is on the first line and no text is selected, preserving the current
input as a draft. Moving down past the newest entry SHALL restore that draft and
end history navigation. When Command execution advances to a newly created
input, that input SHALL be editable and focused so history navigation works
immediately without an additional click.

#### Scenario: Up recalls the newest command

- **WHEN** an AI or Command input was submitted in an earlier cell of the
  current tab
- **THEN** pressing `ArrowUp` in another editable cell recalls that submission

#### Scenario: Repeated Up navigates to older commands

- **WHEN** history navigation is active
- **THEN** repeated `ArrowUp` presses move through AI and Command entries from
  newest to oldest without changing the stored order

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

- **WHEN** a new editable AI cell is created after a Command or AI input was
  submitted in another cell
- **THEN** pressing `ArrowUp` in the new AI cell recalls the shared history

#### Scenario: Automatic advance leaves the new cell ready for history

- **WHEN** a Command cell is submitted with run-and-advance
- **THEN** the newly created input is editable and focused
- **AND** pressing `ArrowUp` immediately recalls the submitted command
