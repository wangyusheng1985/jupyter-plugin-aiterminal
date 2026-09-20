## MODIFIED Requirements

### Requirement: The presentation follows academic notebook visual rules

The Turn presentation SHALL use a restrained academic notebook visual system consistent with JupyterLab. Outcome prose SHALL use a readable serif treatment and readable line measure, while the outcome container and structured content such as tables, code blocks, media, and execution records SHALL use the available workspace width when beneficial. Controls and labels SHALL use the UI font, evidence SHALL use the code font, and numeric metrics SHALL use tabular figures. The presentation SHALL NOT use decorative gradients, ornamental cards, nested cards, or color as the only means of conveying status.

#### Scenario: A supported JupyterLab theme is active

- **WHEN** the workspace is displayed under a light or dark JupyterLab theme
- **THEN** backgrounds, borders, text, links, focus indicators, and status colors use theme tokens with readable contrast

#### Scenario: Structured output is displayed in a wide panel

- **WHEN** an outcome contains a table, code block, media element, or execution record and horizontal workspace space is available
- **THEN** that structured content can use the available result width beyond the prose line measure
- **AND** the outcome root does not reserve the remaining width as unused blank space

#### Scenario: Long prose is displayed in a wide panel

- **WHEN** an outcome contains ordinary headings, paragraphs, lists, or blockquotes
- **THEN** the prose retains a readable line measure
- **AND** the presence of wide structured content does not force prose to span the full panel width

#### Scenario: The cell is displayed in a narrow panel

- **WHEN** the available width is narrow or the content contains wide tables, long paths, commands, or unbroken evidence
- **THEN** the outcome and audit rows reflow or contain overflow within the relevant content region without workspace-level horizontal overflow
- **AND** summary metrics do not overlap row controls

#### Scenario: A user operates the audit record by keyboard

- **WHEN** the audit summary, failure count, or activity row receives keyboard focus
- **THEN** the control has a visible focus state and exposes its expanded state to assistive technology
