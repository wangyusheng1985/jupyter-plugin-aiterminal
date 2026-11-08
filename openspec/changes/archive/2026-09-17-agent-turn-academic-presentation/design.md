## Context

See `proposal.md` for motivation and
`specs/agent-turn-academic-presentation/spec.md` for the behavior contract.

The pending `agent-turn-presentation` change already supplies the Turn domain
model, deterministic tool summaries, diagnostics, merged changes, metrics,
bounded evidence, version 2 persistence, and disclosure state. The current
renderer then presents those capabilities as separate `Outcome`, `Diagnostics`,
`Changes`, and `Trace` sections. This change keeps the data model and replaces
the visible information architecture and its supporting styles.

The validated HTML prototype establishes the target reading order and
interaction model. The implementation must reproduce that behavior with real
JupyterLab widgets, theme tokens, DOM events, and existing Turn state rather
than importing the prototype markup or styles.

## Goals / Non-Goals

**Goals:**

- Make the outcome read like the result paragraph of a research notebook rather
  than the first panel in a diagnostic dashboard.
- Represent all secondary execution information through one audit summary and
  one chronological record.
- Keep failure visibility and navigation immediate without leaving diagnostics
  or changes detached from the activity that produced them.
- Preserve bounded, inspectable evidence and keep expanded content from
  creating uncontrolled page growth.
- Reuse existing Turn data and saved disclosure state without a workspace
  snapshot migration.
- Produce a layout that remains readable in JupyterLab light/dark themes,
  narrow panels, and long-content cases.

**Non-Goals:**

- Changing Agent SDK event payloads, tool presenters, outcome resolution, or
  snapshot version 2.
- Replacing the Turn model with a second summarization pass or model call.
- Changing queue order, `[*]` semantics, input history, Command execution, or
  cell editing.
- Introducing a configurable notebook skin, global density setting, dashboard,
  timeline graph, or alternate workspace view.
- Showing hidden model reasoning content.

## Decisions

### Replace the section stack with outcome plus audit summary

The renderer will emit a stable two-part default view:

```text
Turn
  Outcome
    canonical Markdown result, unframed
  Audit summary
    record disclosure
    failure count when present
    available step, duration, and changed-file metrics
```

The existing `turn.outcome`, `turn.timeline`, `turn.diagnostics`,
`turn.changes`, and `turn.metrics` remain the inputs. The renderer stops
creating top-level diagnostic, change, and trace sections. It merges their
visible signals into the audit summary.

This was chosen over retaining separate compact sections because the user still
has to scan several regions to understand one execution. It was also chosen
over hiding diagnostics and changes entirely inside the record because an
actionable failure must remain visible before expansion. A failure count with
direct navigation preserves both properties without restoring the section
stack.

### Use a semantic audit-summary row with independent controls

The summary row will not be one large button containing every metric. Its DOM
contract will be:

```text
.jp-AgentWorkspace-auditSummary
  button[data-audit-toggle]
    disclosure marker
    text: Show/Hide execution record
  button[data-failure-navigation]  (only when failures exist)
    text: N step(s) failed
  .jp-AgentWorkspace-auditStats
    available metric spans
```

The record toggle uses `aria-expanded` and `aria-controls`. The failure control
has its own accessible name and does not depend on color. Metrics are read-only
text and use tabular figures. Controls wrap rather than overlap at narrow
widths.

An alternative single disclosure button containing the failure count was
rejected because activating the summary and navigating to a failure are
different intents. Nested buttons are invalid HTML and create ambiguous
keyboard behavior.

### Keep the chronological record as a flat table-like list

The expanded record will render one flat list. Each activity row uses a
responsive grid aligned approximately as:

```text
sequence | action + target | result/status | duration
```

At narrow widths, result/status moves to a second line under the action target
and duration remains aligned at the end. Rows use separators rather than card
borders and have no surrounding panel. The activity row itself is the
disclosure button for its evidence.

Activity order is preserved. Repeated edits to one path remain distinct rows;
the merged file-change list contributes only to summary metadata and is not
rendered as a second ordered list. A diagnostic is visually associated with
its source row through status text, failure styling, and expanded detail.

### Reuse existing disclosure state and add one navigation action

The existing `TurnPresentationState` already models the needed persistence:

```ts
type TraceDisclosure = 'auto' | 'expanded' | 'collapsed';

interface TurnPresentationState {
  trace: TraceDisclosure;
  expandedActivityIds: string[];
  fullEvidenceActivityIds: string[];
  outcomeExpanded: boolean;
}
```

The record maps to `trace`, a step maps to `expandedActivityIds`, and complete
raw output maps to `fullEvidenceActivityIds`. No new persisted state is needed.

Failure navigation needs an atomic state transition because it must expand the
record and the failed activity together:

```ts
function revealFailedActivity(
  turn: ChatTurn,
  activityId: string
): ChatTurn;
```

The renderer receives `onRevealFailure(turnId, activityId)`. The workspace
applies the transition in one update, then focuses the failed row and scrolls
it into view after the next render. The focus and scroll key uses the same
stable activity identity already used by render-state preservation.

Calling the existing trace and activity toggles in sequence was rejected
because it can produce an intermediate collapsed render, extra work, and
incorrect behavior if either state was already expanded.

### Keep evidence bounded inside rows

No raw evidence is created while a row is collapsed. Expanding a row creates
its available input and output blocks. Each evidence block uses
`max-height` plus `overflow: auto`; output preview and full-output states share
the same bounded shell. The complete route does not remove the height bound.

The audit record itself does not use an internal scrollbar. This avoids a
notebook list nested inside a scrollable record. The cell-level output
collapser remains the outer bound, and only individual raw evidence blocks
scroll internally.

### Use an academic notebook visual system

The style implementation will use existing JupyterLab variables:

- Outcome prose uses the JupyterLab content font family and a readable measure.
- Labels, metrics, and controls use the UI font family.
- Commands, paths, and evidence use the code font family.
- Light and dark surfaces use JupyterLab layout, border, text, focus, brand,
  warning, and error variables.
- Durations and counts use tabular numeric figures.
- Rows rely on spacing, thin separators, and typographic hierarchy instead of
  cards, shadows, gradients, or decorative color blocks.

The existing `.jp-AgentWorkspace-disclosure` marker vocabulary remains in use
for consistency with JupyterLab. New classes are scoped under
`.jp-AgentWorkspace-turn` and follow the repository's flat `jp-AgentWorkspace-*`
class convention.

The typography should be set at the workspace content boundary rather than
overriding arbitrary Markdown descendants. This keeps notebook output, links,
code, math, and tables compatible with JupyterLab rendering.

### Preserve running and completion behavior

While a Turn is running, `trace: auto` resolves to expanded and the renderer
keeps the existing newest-activity window of three rows. The summary reports
live progress without replacing the running indicator at the output tail.
Rows older than the window remain compact unless the user explicitly expanded
them.

When a Turn completes, automatic state collapses the record. The audit summary
continues to show available final metrics and failures. Explicit record and
activity expansion remains unchanged until the cell is rerun.

### Keep the existing render reconciliation strategy

The implementation will update the existing renderer rather than replace the
workspace update architecture. Existing keys for outcome, activity, evidence,
and focus preservation remain the basis for maintaining scroll and focus.

New failure navigation reuses the focus-preservation path and adds a one-shot
scroll target. The target is consumed after the render so later streaming
events do not repeatedly force scroll position.

## Risks / Trade-offs

**[A subtle failure count can be missed]** -> Use explicit failure text and a
semantic error treatment rather than color alone; test light and dark themes.

**[Removing separate change and diagnostic sections can hide useful detail]** ->
Keep failure count visible, include changed-file count in the summary, and
render diagnostics with their source rows in the expanded record.

**[A single dense row can break with long commands or paths]** -> Use a
responsive grid, `min-width: 0`, controlled wrapping, and a deliberate
second-line layout for result/status at narrow widths.

**[Failure navigation can disorient a keyboard user]** -> Move focus to the
revealed failed row, expose its expanded state, and disable animated scrolling
under reduced motion.

**[Multiple scrollable evidence blocks can feel heavy]** -> Keep only step
evidence scrollable, leave the record itself in normal page flow, and preserve
each block's scroll position across rerenders.

**[Styling can leak into user Markdown]** -> Scope typography and layout rules
to the renderer's own elements; do not force fonts or spacing onto arbitrary
rendered content beyond the result container's intended measure.

**[The change can regress the existing completed Turn contract]** -> Keep the
existing `ChatTurn` fields, rerun behavior, output collapser, and version 2
round-trip tests unchanged while replacing renderer expectations.

## Migration Plan

1. Update Turn presentation tests to describe the new two-part default view and
   failure navigation.
2. Refactor the renderer to produce Outcome plus audit summary while retaining
   the existing Turn model and identity keys.
3. Add the atomic reveal-failed-activity transition and workspace
   post-render focus/scroll behavior.
4. Replace the section-oriented styles with scoped academic presentation
   styles and responsive evidence rules.
5. Run renderer, workspace, persistence, typecheck, lint, unit, and build
   verification.
6. Verify the built plugin in JupyterLab with successful, failed, running,
   narrow, light, and dark Turns.

Rollback is presentation-only: the stored version 2 data and raw evidence are
unchanged, so restoring the prior renderer restores the previous section-based
view without migrating documents.
