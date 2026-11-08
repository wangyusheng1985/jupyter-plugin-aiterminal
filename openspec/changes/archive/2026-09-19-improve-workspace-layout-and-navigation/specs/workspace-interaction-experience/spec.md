## Purpose

Make the complete AI Terminal workspace feel responsive and stable across editing, execution, streaming, scrolling, navigation, toolbar actions, and status feedback while remaining consistent with JupyterLab interaction conventions.

## ADDED Requirements

### Requirement: Accepted actions receive coordinated immediate feedback

The workspace SHALL acknowledge accepted insert, run, queue, interrupt, select, and navigation actions without waiting for a server response. Related toolbar, Cell prompt, navigator, and status indicators SHALL converge on the same execution state without changing their surrounding layout dimensions.

#### Scenario: A Cell run is accepted immediately
- **WHEN** the user submits a valid Cell
- **THEN** the Cell, toolbar, navigator, and status presentation acknowledge its queued or running state before execution completes
- **AND** the acknowledgement does not wait for the first streamed output event

#### Scenario: Interrupt is unavailable
- **WHEN** no Cell is actively running
- **THEN** the interrupt control is visibly and semantically disabled

#### Scenario: A queued Cell starts running
- **WHEN** the active request finishes and a queued Cell begins
- **THEN** the Cell prompt, navigator, and status presentation update to the new running Cell
- **AND** the selected editing Cell is not changed merely because queue progression occurred

### Requirement: Toolbar and status information follow workspace state

The workspace SHALL group structural Cell actions separately from execution actions and SHALL expose stable connection, working-directory, active-run, and queue feedback using JupyterLab-native controls and theme semantics. Status changes SHALL not resize the toolbar or bottom status region.

#### Scenario: The workspace is connected and idle
- **WHEN** the session is connected with no active or queued request
- **THEN** the status presentation communicates the connected and ready state
- **AND** the current working directory remains available

#### Scenario: Work is running or queued
- **WHEN** a Cell is running or later Cells are queued
- **THEN** the status presentation identifies the active execution and available queue count
- **AND** the information remains understandable without color alone

#### Scenario: Available width decreases
- **WHEN** the status region cannot show every value in full
- **THEN** primary connection and execution state remain visible
- **AND** the working directory truncates without increasing the status region's height

### Requirement: Streaming output follows only with user consent inferred from position

While output is streaming, the workspace SHALL follow the newest visible output only while the user remains near that output's tail. Manual movement away from the tail SHALL detach automatic following, preserve the user's reading position, and expose a direct control for returning to the latest output.

#### Scenario: The user remains near the output tail
- **WHEN** new output arrives while the user is reading near the running output's end
- **THEN** the workspace keeps the newest output visible
- **AND** existing expanded disclosures remain in their chosen state

#### Scenario: The user scrolls away from the tail
- **WHEN** the user moves upward to read earlier workspace content
- **THEN** subsequent output does not move the user's reading position
- **AND** a return-to-latest control becomes available

#### Scenario: The user returns to latest output
- **WHEN** the user activates the return-to-latest control
- **THEN** the running output tail is revealed
- **AND** automatic following resumes while the user remains near the tail

#### Scenario: The active run terminates
- **WHEN** the running Cell completes, fails, or is interrupted
- **THEN** its transient follow or detached state ends
- **AND** the final output and user-selected disclosure state remain available

### Requirement: Streaming updates preserve reading and interaction state

New streamed output SHALL preserve the main workspace reading position when follow mode is detached, the scroll positions of bounded output and evidence regions, the active keyboard focus where the focused control still exists, and the selected Cell and edit mode.

#### Scenario: Evidence updates while being inspected
- **WHEN** new Turn activity arrives while the user is reading an expanded evidence region
- **THEN** the region keeps its scroll position
- **AND** the focused disclosure control remains focused if it still exists

#### Scenario: Output streams into a non-selected Cell
- **WHEN** output arrives for a running Cell while the user edits or selects another Cell
- **THEN** the running Cell updates
- **AND** the user's selected Cell and editing focus do not move

#### Scenario: Follow mode is detached
- **WHEN** new content arrives after the user has moved away from the tail
- **THEN** the main workspace scroll position remains stable
- **AND** the new content remains reachable through the return-to-latest control or ordinary scrolling

### Requirement: Cell selection and editing remain distinct

The workspace SHALL distinguish selecting a Cell from entering its editor. Pointer navigation through output, the history navigator, or Cell chrome SHALL select without forcing edit mode, while deliberate editor activation and notebook keyboard commands SHALL retain the established editing behavior.

#### Scenario: The user selects Cell output
- **WHEN** the user activates a non-interactive area of a Cell's output
- **THEN** that Cell becomes selected
- **AND** its editor does not automatically receive focus

#### Scenario: The user activates the editor
- **WHEN** the user deliberately focuses the selected Cell input or invokes the edit command
- **THEN** the Cell enters edit mode
- **AND** keyboard input is directed to the editor

#### Scenario: Output changes while another Cell is edited
- **WHEN** a running output rerenders elsewhere in the workspace
- **THEN** the active editor retains focus and selection

### Requirement: Page-level motion is restrained, interruptible, and optional

The workspace SHALL use motion only to communicate selection, navigation, disclosure, or running progress. Motion SHALL not block input, SHALL yield to newer user actions, SHALL avoid moving surrounding layout, and SHALL be removed or reduced when the user requests reduced motion.

#### Scenario: A rapid sequence of interactions occurs
- **WHEN** the user moves between navigation items, changes disclosure state, or selects another Cell before an earlier transition ends
- **THEN** the newest requested state becomes authoritative
- **AND** correctness does not depend on an earlier animation completing

#### Scenario: Reduced motion is enabled
- **WHEN** the operating environment requests reduced motion
- **THEN** all workspace functions remain available in their final states
- **AND** nonessential tracking, fading, and smooth-scrolling motion is disabled

#### Scenario: An interaction changes visual state
- **WHEN** a control is hovered, pressed, focused, selected, or disabled
- **THEN** feedback appears without moving adjacent controls or Cell content

### Requirement: The page adapts to the workspace container

The workspace SHALL adapt its layout using the available JupyterLab panel width rather than assuming the browser viewport width. Primary Cell input, output, execution controls, and status information SHALL remain operable without page-level horizontal scrolling across supported container sizes.

#### Scenario: The JupyterLab panel is resized
- **WHEN** the user narrows or widens the AI Terminal panel
- **THEN** toolbar, Cell, status, output, and navigation presentation reflow for the new container width
- **AND** the document's selected Cell and execution state are preserved

#### Scenario: Structured content is wider than a narrow panel
- **WHEN** a table, code block, path, or execution record cannot fit the available content width
- **THEN** overflow is contained within the relevant content region or the content reflows
- **AND** the entire workspace does not acquire horizontal scrolling

### Requirement: Interaction responsiveness remains perceptibly immediate

Under normal supported workspace load, pointer proximity feedback SHALL be rendered by the next animation frame, accepted actions SHALL show a visible state response within 100 milliseconds, and streaming updates SHALL not repeatedly reconstruct unrelated Cell navigation or steal the main interaction focus.

#### Scenario: The pointer moves over the Cell navigator
- **WHEN** the browser is able to render at its normal refresh rate
- **THEN** the closest-marker feedback is visible by the next rendered frame

#### Scenario: The user activates a workspace control
- **WHEN** an insert, run, interrupt, select, disclosure, or navigation action is accepted
- **THEN** visible acknowledgement appears within 100 milliseconds under normal operating conditions

#### Scenario: A running Turn emits frequent updates
- **WHEN** several streamed events arrive while the user interacts elsewhere in the workspace
- **THEN** unrelated navigation and editing controls remain responsive
- **AND** focus and main-scroll ownership remain with the user
