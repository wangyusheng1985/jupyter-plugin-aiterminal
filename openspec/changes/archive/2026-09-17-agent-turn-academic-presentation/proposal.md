## Why

The current Turn renderer is functionally summary-first, but its separate
Outcome, Diagnostics, Changes, and activity sections still read like a stack of
dashboard panels. Multi-step AI runs remain visually fragmented, and the user
must infer how warnings and file mutations relate to the ordered execution
record. An academic notebook presentation should read like a paper result:
result prose first, followed by one quiet audit record that expands into the
complete evidence.

## What Changes

- Replace the separate visible `Outcome`, `Diagnostics`, `Changes`, and
  `Execution` sections with a result-first layout and one compact audit-record
  summary.
- Present the canonical Turn outcome as unframed Markdown prose without a
  section label or card container.
- Summarize activity count, duration, changed-file count, and failure count in
  the audit summary; keep absent metrics omitted.
- Let a failure count act as a direct navigation control that opens the audit
  record, expands the failed step, and brings it into view.
- Expand the audit summary into one chronological execution table with step,
  action, target, result, and duration columns.
- Keep diagnostics and file changes inside the corresponding execution step
  and audit summary instead of rendering them as separate top-level sections.
- Keep raw input and output evidence behind per-step disclosure and bound all
  evidence blocks with an internal scroll area so expansion does not turn the
  cell into an unbounded page.
- Apply a restrained academic visual system: neutral JupyterLab surfaces,
  serif result prose, sans-serif controls, monospaced evidence, tabular
  metrics, visible focus states, and no decorative cards or gradients.
- Preserve the existing `[*]` queue/running convention, compact cell-output
  collapse, checkpoint grouping, keyboard operation, reduced-motion behavior,
  and version 2 workspace compatibility.

## Capabilities

### New Capabilities

- `agent-turn-academic-presentation`: Defines the result-first Turn
  presentation, compact audit summary, chronological execution record,
  failure navigation, bounded evidence disclosure, and academic notebook
  visual behavior.

### Modified Capabilities

None.

## Impact

This change refines the Turn renderer and Agent Workspace styles introduced by
the pending `agent-turn-presentation` change. It affects the frontend Turn
presentation state and DOM contracts, renderer tests, workspace interaction
tests, and `style/base.css`. It does not change Agent SDK events, tool
presentation extraction, queue semantics, input history, cell execution, or
the persisted raw evidence ledger. Existing workspaces and saved Turn
disclosure choices remain readable.
