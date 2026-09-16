# compact-output-collapse Specification

## Purpose

Keep long AI and Command results compact without hiding them completely, using
a bounded output preview that remains scrollable for inspection.

## Requirements

### Requirement: Collapsed output keeps a bounded visible preview

Collapsing a cell's output SHALL keep the output body visible inside a bounded
viewport instead of replacing it with a fully hidden placeholder. Content that
exceeds the viewport SHALL remain available through scrolling within the output
area.

#### Scenario: A short output is collapsed

- **WHEN** the user collapses output whose content fits within the preview
  height
- **THEN** the output remains visible at its natural height
- **AND** no unnecessary scrollbar is shown

#### Scenario: A long output is collapsed

- **WHEN** the user collapses output whose content exceeds the preview height
- **THEN** the output is limited to the configured preview height
- **AND** the output area provides scrolling for the remaining content

#### Scenario: A long output is expanded again

- **WHEN** the user expands an output that was in the compact collapsed state
- **THEN** the output returns to its natural expanded height
- **AND** the stored output text is unchanged

### Requirement: Existing output collapser controls the compact state

The existing output collapser SHALL toggle between expanded output and the
bounded compact preview. The same behavior SHALL apply to AI and Command cell
outputs.

#### Scenario: Toggle Command output

- **WHEN** the user clicks the Command cell output collapser
- **THEN** the output switches between expanded and compact preview states

#### Scenario: Toggle AI output

- **WHEN** the user clicks the AI cell output collapser
- **THEN** the output blocks switch between expanded and compact preview states

### Requirement: Compact output remains inspectable and stable

The compact output viewport SHALL support wheel, trackpad, touch, and keyboard
scrolling without changing cell selection or editing state. Streaming updates
and late-arriving output SHALL remain inside the same bounded viewport.

#### Scenario: Scroll a compact result

- **WHEN** the user scrolls inside a compact output preview
- **THEN** the output position changes without selecting a different cell

#### Scenario: Output updates while compact

- **WHEN** more output arrives for a running cell whose output is compact
- **THEN** the new content is appended within the existing bounded viewport
- **AND** the cell's compact state is preserved

### Requirement: Compact state persists with the workspace

The compact or expanded choice SHALL remain part of the saved workspace state
and SHALL be restored with the cell's output.

#### Scenario: Reload a compact cell

- **WHEN** a workspace with compact output is saved and restored
- **THEN** that cell's output is shown in the compact state
- **AND** the full output content remains available for scrolling
