# cell-history-navigation Specification

## Purpose

Provide a compact, responsive, and accessible overview of submitted workspace Cells so users can understand a long AI Terminal document and move directly to earlier work without searching through the main scroll surface.

## Requirements

### Requirement: Submitted Cells appear in document order

The workspace SHALL expose one navigation item for each Cell that has an accepted queued, running, completed, or interrupted submission. Navigation items SHALL follow current document order, SHALL retain stable association with their Cell identity, and SHALL exclude empty trailing inputs and drafts that have never been submitted.

#### Scenario: A Cell submission is accepted
- **WHEN** a non-empty Cell is accepted for immediate or queued execution
- **THEN** one navigation item represents that Cell
- **AND** the item appears at the Cell's position in document order

#### Scenario: The same Cell is executed again
- **WHEN** a represented Cell is submitted more than once
- **THEN** the navigator continues to display one item for that Cell
- **AND** it does not create a separate item for each execution attempt

#### Scenario: A represented Cell is deleted
- **WHEN** the user deletes a Cell represented in the navigator
- **THEN** its navigation item is removed
- **AND** every remaining item stays associated with its original Cell

#### Scenario: The workspace contains an unsubmitted draft
- **WHEN** a Cell contains input that has never been accepted for execution
- **THEN** the navigator does not expose that Cell as history

### Requirement: The navigator presents a compact Cell overview

In a sufficiently wide workspace, the navigator SHALL remain available beside the main Cell scroll surface and SHALL present each item as a compact horizontal marker. It SHALL visually distinguish selected, viewport-current, queued, running, and pointer- or keyboard-targeted Cells without relying on color alone and without changing the width of the main content while states change.

#### Scenario: No item is being previewed
- **WHEN** the pointer and keyboard focus are outside the navigator
- **THEN** submitted Cells appear as compact horizontal markers
- **AND** the selected Cell remains identifiable by marker length or another non-color cue

#### Scenario: The user manually scrolls the workspace
- **WHEN** a different Cell becomes the viewport-current Cell
- **THEN** the navigator updates the viewport-current indication
- **AND** the selected Cell and editor mode remain unchanged

#### Scenario: A represented Cell is queued or running
- **WHEN** a represented Cell changes to queued or running state
- **THEN** its marker communicates that state
- **AND** the state remains understandable without color alone

#### Scenario: Navigation state changes
- **WHEN** a marker becomes selected, current, hovered, focused, queued, or running
- **THEN** the navigator does not resize the main result area
- **AND** surrounding Cell content does not shift

### Requirement: Pointer proximity provides immediate preview feedback

The navigator SHALL respond to pointer proximity by emphasizing the closest marker and, with lower emphasis, its immediate neighbors. The feedback SHALL track current pointer position without a deliberate hover delay, SHALL remain interruptible by subsequent pointer movement, and SHALL NOT be required to activate navigation.

#### Scenario: The pointer enters the marker rail
- **WHEN** the pointer enters the navigator near a marker
- **THEN** the closest marker is emphasized on the next rendered frame under normal operating conditions
- **AND** nearby markers receive progressively lower emphasis

#### Scenario: The pointer moves between markers
- **WHEN** the pointer crosses from one marker's region into another
- **THEN** emphasis and preview content move to the newly closest marker
- **AND** an earlier transition does not have to finish first

#### Scenario: The pointer leaves the navigator
- **WHEN** the pointer leaves the marker rail and no item retains keyboard focus
- **THEN** proximity emphasis is removed
- **AND** persistent selected, current, queued, and running states remain visible

### Requirement: Each navigation item discloses its Cell input preview

Hovering or keyboard-focusing a navigation item SHALL disclose an adjacent preview derived from that Cell's stored input. The preview SHALL normalize surrounding and repeated whitespace, display the first ten user-perceived characters, and add an ellipsis when more content remains.

#### Scenario: A short Cell input is previewed
- **WHEN** the targeted Cell input contains ten or fewer user-perceived characters after whitespace normalization
- **THEN** the preview displays the normalized input without an ellipsis

#### Scenario: A long Cell input is previewed
- **WHEN** the targeted Cell input contains more than ten user-perceived characters after whitespace normalization
- **THEN** the preview displays the first ten characters followed by an ellipsis

#### Scenario: A keyboard user focuses an item
- **WHEN** a navigation item receives keyboard focus
- **THEN** the same preview available on hover is displayed
- **AND** the item exposes an accessible name identifying its Cell and input preview

### Requirement: Activating an item reveals its Cell without entering edit mode

Activating a navigation item SHALL select and reveal its associated Cell while preserving notebook-style command-mode semantics. Navigation motion SHALL be interruptible by further user input, and a target already sufficiently visible SHALL not be scrolled unnecessarily.

#### Scenario: The target Cell is outside the viewport
- **WHEN** the user activates its navigation item
- **THEN** the target Cell becomes selected without automatically focusing its editor
- **AND** the main Cell surface brings the target into view

#### Scenario: The target Cell is already visible
- **WHEN** the user activates its navigation item
- **THEN** the target Cell becomes selected
- **AND** the workspace does not perform an unnecessary page movement

#### Scenario: The user interrupts navigation motion
- **WHEN** the user scrolls, activates another item, or otherwise provides navigation input during a reveal
- **THEN** the earlier movement yields to the new input
- **AND** the workspace remains in a valid selected state

#### Scenario: Reduced motion is requested
- **WHEN** the user activates an item while reduced motion is enabled
- **THEN** the target is revealed without animated scrolling or proximity motion

### Requirement: Navigation is fully keyboard operable

The navigator SHALL provide one logical entry point in the page tab order, visible focus, ordered traversal among markers, and Enter or Space activation without requiring a pointer or forcing users to tab through every history item.

#### Scenario: Keyboard focus enters the navigator
- **WHEN** the user tabs to the Cell history navigator
- **THEN** one marker receives visible focus
- **AND** the focused marker's preview is displayed

#### Scenario: The user traverses history
- **WHEN** focus is in the navigator and the user presses the supported directional keys
- **THEN** focus moves to the preceding or following available marker in document order
- **AND** the corresponding preview updates

#### Scenario: The user activates a focused marker
- **WHEN** the user presses Enter or Space on a focused marker
- **THEN** the associated Cell is selected and revealed with the same behavior as pointer activation

### Requirement: Every represented Cell remains reachable at supported widths

The workspace SHALL keep every represented Cell reachable when the history exceeds the available rail height and SHALL replace the rail with an operable compact history control when the panel is too narrow to display the rail without obscuring primary content.

#### Scenario: History exceeds the available rail height
- **WHEN** all markers cannot fit at the normal spacing
- **THEN** the navigator provides a way to traverse every represented Cell
- **AND** no Cell is silently omitted

#### Scenario: The workspace panel becomes narrow
- **WHEN** the rail would materially obscure the Cell input or output area
- **THEN** the rail is replaced by a compact Cell-history control
- **AND** activating that control exposes the same ordered destinations and previews

#### Scenario: The workspace becomes wide again
- **WHEN** sufficient container width returns
- **THEN** the horizontal-marker rail is restored
- **AND** the selected destination and Cell state remain consistent
