# workspace-task-overview Specification

## Purpose

Give users immediate, deterministic orientation in long Agent workspaces by summarizing saved turns, incomplete work, failures, and runtime-context truth without adding another model call or obscuring the notebook content.

## Requirements

### Requirement: The workspace exposes a compact deterministic overview

The workspace SHALL display a compact overview derived only from persisted Cell, Turn, queue, and runtime-context state. It SHALL communicate the number of submitted AI and Command Cells, interrupted work, failed activities or diagnostics, and current context state while omitting unavailable values.

#### Scenario: A long saved workspace is opened
- **WHEN** the workspace contains completed, interrupted, or failed Cells
- **THEN** the overview reports deterministic counts for those states
- **AND** no model request is made to produce the overview

#### Scenario: The workspace contains no submitted work
- **WHEN** only an empty draft Cell exists
- **THEN** the overview presents an empty or ready state
- **AND** it does not render zero-valued diagnostic clutter

### Requirement: Overview state updates with accepted work

The overview SHALL update when a Cell is submitted, queued, started, completed, interrupted, deleted, restored, or rerun, and when runtime context changes. Token-by-token output updates that do not change overview facts SHALL NOT rewrite the overview.

#### Scenario: A request is accepted
- **WHEN** a Cell becomes queued or running
- **THEN** the overview reflects active or pending work immediately

#### Scenario: Only streamed text changes
- **WHEN** a running Turn receives more text without a status, failure, or count change
- **THEN** the overview remains stable

### Requirement: Failures and interrupted work are directly actionable

When failed or interrupted work exists, the overview SHALL provide a direct route to the first relevant Cell and SHALL communicate the condition with text or shape in addition to color.

#### Scenario: Failed activities exist
- **WHEN** one or more saved Turns contain failure diagnostics
- **THEN** the overview exposes the failure count
- **AND** activating it reveals the first Cell containing a failure

#### Scenario: Interrupted Cells exist without failures
- **WHEN** one or more Cells ended interrupted
- **THEN** the overview exposes the interrupted count
- **AND** activating it reveals the first interrupted Cell

### Requirement: Context truth is always visible

The overview SHALL distinguish new, live, resumed, unavailable, and reset runtime context using explicit text. It SHALL NOT infer continuity from the presence of historical Cells.

#### Scenario: Historical Cells are visible in a fresh context
- **WHEN** an older document has Cells but no resumable Agent session
- **THEN** the overview identifies the context as new
- **AND** it does not label the workspace resumed

#### Scenario: Resume is unavailable
- **WHEN** the Agent runtime cannot resume the saved context
- **THEN** the overview identifies context as unavailable
- **AND** the recovery action remains reachable by keyboard

### Requirement: The overview remains compact and theme-compatible

The overview SHALL use JupyterLab theme tokens, keep a stable height, truncate secondary path or count details before primary context and execution state, and remain keyboard operable in wide and narrow panels.

#### Scenario: The panel becomes narrow
- **WHEN** all overview details cannot fit on one line
- **THEN** primary runtime-context and active-work state remain visible
- **AND** secondary counts are available through an accessible disclosure

### Requirement: Long history remains searchable without changing the default rail

The workspace SHALL keep the default compact marker rail visually minimal while providing an accessible history palette that can be opened from the overview or narrow-mode history control. The palette SHALL filter Cell destinations by normalized current input without requesting model assistance.

#### Scenario: A user opens history search
- **WHEN** the user activates the workspace turn-count overview or Cell history control
- **THEN** a keyboard-focusable search field and ordered Cell results are shown
- **AND** the default marker rail remains compact when the palette is closed

#### Scenario: A query matches Cell inputs
- **WHEN** the user types a non-empty query into the history search field
- **THEN** only matching Cell destinations remain in the result list
- **AND** activating a result selects and reveals the same stable Cell

#### Scenario: A query has no matches
- **WHEN** no submitted Cell input matches the query
- **THEN** the palette communicates that no matching Cells exist
- **AND** it does not alter notebook selection or execution state

### Requirement: Failure state is visible in Cell history orientation

The workspace SHALL mark navigation items whose saved Turn contains one or more failure diagnostics using a non-color cue and SHALL include the failure count in the item's accessible name and preview context.

#### Scenario: A Turn contains failed activity
- **WHEN** a Cell has one or more failure diagnostics
- **THEN** its history marker exposes a failure shape or length/state treatment
- **AND** keyboard users can discover the failure count from the marker name

#### Scenario: A Turn has no failure diagnostics
- **WHEN** a submitted Cell completes without failure diagnostics
- **THEN** its marker does not display a failure cue

### Requirement: Failed work can be retried without overwriting evidence

A failed or interrupted AI Turn SHALL expose an explicit Retry as new turn action. Activating it SHALL create a new editable draft immediately after the source Cell with the same current input, while preserving the source Cell's complete outcome, failure status, execution record, evidence, execution count, and navigation destination.

#### Scenario: A failed AI Turn is prepared for retry
- **WHEN** the user activates Retry as new turn on a failed AI Cell
- **THEN** a new draft Cell containing the failed Cell's input is inserted immediately after it
- **AND** the new Cell is selected in edit mode
- **AND** no Agent request starts until the user deliberately submits the draft

#### Scenario: An interrupted AI Turn is prepared for retry
- **WHEN** the user activates Retry as new turn on an interrupted AI Cell
- **THEN** the same draft-preserving behavior is used
- **AND** partial evidence in the interrupted source Cell remains unchanged

#### Scenario: A completed successful Turn is displayed
- **WHEN** an AI Cell has no interruption and no failure diagnostics
- **THEN** Retry as new turn is not presented as a primary recovery action

#### Scenario: Retry is operated by keyboard
- **WHEN** the recovery control receives keyboard focus and is activated
- **THEN** the new draft is created and its editor receives focus
- **AND** the original failure remains reachable through overview and Cell history navigation

### Requirement: Long final outcomes remain compact and scannable

Final Markdown outcomes SHALL use a workbench-density rhythm that avoids stacked whitespace from nested paragraph and list markup while preserving Markdown semantics, heading hierarchy, readable line measure, structured-content width, and theme compatibility. Compactness SHALL NOT depend on clipping content or forcing a fixed result height.

#### Scenario: A final outcome contains consecutive paragraphs and lists
- **WHEN** Markdown renders paragraphs, ordered or unordered lists, and paragraphs nested inside list items
- **THEN** paragraph and list-item spacing remains visually compact without duplicated vertical gaps
- **AND** nested lists remain visibly subordinate without appearing as separate disconnected sections

#### Scenario: A final outcome contains multiple sections and structured content
- **WHEN** headings separate prose, code, tables, quotes, or media
- **THEN** heading spacing communicates section boundaries more strongly than ordinary paragraph spacing
- **AND** code, tables, quotes, and media retain enough separation and their existing contained-overflow behavior

#### Scenario: A dense outcome reflows in a constrained workspace
- **WHEN** the workspace narrows or text is enlarged to 200 percent
- **THEN** all Markdown content remains available without workspace-level horizontal overflow or fixed-height clipping
- **AND** the compact rhythm does not collapse interactive controls below their accessible target or focus treatment
