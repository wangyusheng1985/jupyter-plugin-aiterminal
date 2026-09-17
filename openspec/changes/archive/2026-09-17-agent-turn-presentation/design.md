## Context

See `proposal.md` for motivation. The current frontend model is a flat
`ChatBlock[]`, the server emits assistant text and tool lifecycle events without
a turn identifier, and the cell renderer displays every tool input and output
at full size. The SDK already provides a terminal `ResultMessage` carrying the
final result and execution metrics, so the presentation problem can be solved
without introducing a second model-based summarization pass.

The change crosses the Python event bridge, the WebSocket protocol, frontend
state, rendering, persistence, and styles. Existing queue, history, prompt,
output-collapse, and running-indicator behavior must remain intact.

## Goals / Non-Goals

**Goals:**

- Make the Turn Outcome, Diagnostics, and file Changes the first visible layer.
- Keep the ordered tool and thinking trace available without allowing raw
  evidence to dominate the default view.
- Represent expansion behavior as a deliberate user state rather than a
  collection of unrelated CSS toggles.
- Preserve complete tool evidence and restore existing workspaces safely.
- Reuse the notebook visual language and JupyterLab theme tokens.
- Keep mouse, keyboard, scrolling, copy, and reduced-motion behavior coherent.
- Avoid rendering or serializing large raw output repeatedly during streaming.

**Non-Goals:**

- Showing raw model reasoning content in the focused or trace presentation.
- Adding a second LLM call to summarize a Turn.
- Replacing the queue, execution counter, input history, cell editing, or
  Command-cell execution model.
- Introducing a global three-mode density selector.
- Converting the workspace into a general workflow or observability product.
- Changing the Agent SDK provider contract beyond adapting its message data.

## Decisions

### Use a Turn-level domain model with a raw evidence ledger

The runtime presentation model will be:

```text
ChatTurn
  id
  status                 running | done | interrupted | error
  outcome                canonical user-facing result
  timeline               ordered text, thinking, tool, and diagnostic items
  diagnostics            derived actionable failures
  changes                derived file mutation summary
  metrics                duration, turns, usage, cost when available
  presentation           trace and activity disclosure state
```

The existing `blocks` array remains the raw evidence ledger. A tool activity
references its raw tool block by id rather than duplicating potentially large
input and output strings. Outcome and metrics are stored on the Turn because
they are not derivable from individual blocks after the terminal result is
known.

This preserves the strength of the current event model, avoids duplicating
large payloads in `.agentnb`, and still gives the renderer a stable Turn model.
The alternative of replacing `blocks` entirely would make migration and
downgrade behavior unnecessarily risky.

### Use the SDK result as the canonical outcome

`ResultMessage.result` will become the primary Outcome source. The final-result
event will also carry available `duration_ms`, `num_turns`, `total_cost_usd`,
`usage`, `errors`, and `permission_denials` metadata.

Outcome resolution order:

1. Use a non-empty runtime result.
2. If no runtime result exists, promote the last user-facing assistant text
   item.
3. If neither exists, derive a concise result from the final meaningful tool
   activity.
4. If the Turn failed before producing content, use the diagnostic as the
   visible failure state.

If the runtime result matches the final assistant message, the message remains
in the evidence ledger but is not rendered a second time as an activity.
Calling an LLM to summarize the Turn was rejected because it adds latency and
cost and can disagree with the actual result.

### Keep one Focus View instead of multiple global display modes

There will be one default presentation called Focus View. It is not a separate
page or mode selector. The trace itself has three disclosure states:

```ts
type TraceDisclosure = 'auto' | 'expanded' | 'collapsed';
```

- `auto` resolves to expanded while running and collapsed when completed.
- A user toggle changes the state to `expanded` or `collapsed`.
- A fixed user choice is not overridden when the Turn completes.
- Rerunning a cell creates a new Turn in `auto`.

This delivers the value of compact and detailed modes without making users
choose a global mode before they understand the Turn. A global three-mode
selector was rejected because it adds chrome, creates cross-cell state
confusion, and does not solve the underlying hierarchy problem.

### Present the Turn in three visual layers

```text
Layer 1: Outcome
  Final result, bounded if unusually long

Layer 2: Action summary
  Diagnostics and file Changes, visible when present
  One compact trace header with activity count and available metrics

Layer 3: Evidence
  Ordered activity rows
  Per-step input and output preview
  Complete raw output only after explicit expansion
```

The first layer is unframed and uses normal Markdown presentation. The trace
summary uses one compact full-width row rather than a card. Tool details use
plain inset rows rather than nested cards. This keeps the output visually
closer to a notebook while avoiding the current wall of equally weighted
boxes.

### Derive tool summaries deterministically

A frontend presenter will map tool name, input, status, and output metadata
into a primary row:

| Tool | Primary summary |
| --- | --- |
| `Read` | File path and available line or size metadata |
| `Glob` | Pattern and matched-file count |
| `Grep` | Pattern, match count, and file count |
| `Bash` | Command, status, duration, and output size |
| `Edit` / `Write` | File path and available diff statistics |
| Unknown | Tool name, status, and output size |

The server adds deterministic lifecycle metadata such as elapsed time, line
count, and byte count where it can measure them. Missing metadata is omitted
rather than inferred from prose. Tool-specific previews show a small beginning
of successful output; failed results prioritize the tail. Diff statistics are
shown only when the output contains parseable diff information.

The previous full input formatting remains available inside the expanded step.
No presenter is allowed to change the stored input or output.

### Limit the running view to the current context window

While running, the newest activity is expanded and older activities are shown
as compact rows. If many activity rows exist, the trace remains internally
scrollable or exposes a compact “older activity” affordance rather than
forcing the user to the bottom of the page.

The running indicator remains the final visible presentation element for the
current Turn. This preserves the existing running-output behavior while the
richer activity rows provide the missing context.

### Represent thinking as state, not raw reasoning

`ThinkingBlock` content will not be displayed or persisted by the Turn
presentation. The event bridge emits a thinking activity containing only an
identity and state. Focus View shows a concise thinking row; Trace View may
show its place in sequence, but neither view exposes raw reasoning text.

This avoids adding large sensitive text to the document and keeps the output
focused on the user’s task and observable actions. If a future requirement
explicitly asks for raw reasoning, it should be designed as a separate
diagnostic or developer feature rather than silently adding it here.

### Pin diagnostics and changes outside the collapsible trace

Turn diagnostics include runtime errors, denied actions, failed installs, and
failed tool results. Diagnostics remain visible when the trace is collapsed.
File changes are merged by path across mutation activities and shown as a
compact list with available additions and deletions.

The diagnostics and changes summaries do not replace raw evidence. They provide
the action-oriented layer while the corresponding tool activity remains
available in the trace.

### Use item-level rendering and lazy raw evidence

The current cell renderer recreates the entire output and stringifies all
blocks whenever output changes. Turn rendering will instead track a structural
revision and update the affected activity. In the collapsed and preview
states, full tool output is not placed into a natural-height `<pre>`.

Expanding a step creates the input and bounded preview. Revealing complete
output creates the full `<pre>` inside a bounded scroll container. The raw
string remains in the Turn/evidence model so save, restore, and copy continue
to use the exact stored content.

### Preserve notebook and JupyterLab interaction conventions

- The cell output collapser continues to bound the entire Turn output.
- The queue prompt continues to use `[*]`.
- Running uses the existing output-tail indicator and reduced-motion rules.
- Trace headers and activity rows use real buttons with `aria-expanded`.
- Enter and Space activate disclosure controls.
- Disclosure controls stop cell-selection and editor-blur side effects.
- Chevrons use the existing JupyterLab icon vocabulary rather than custom
  text arrows.
- New surfaces use JupyterLab CSS variables for background, border, text,
  focus, error, and brand colors.
- Long paths, commands, and output use wrapping rules that prevent horizontal
  escape without shrinking text to unreadable sizes.
- Summary labels use a responsive grid so status and metadata truncate before
  they overlap controls.

### Persist a version 2 overlay without destructive migration

Snapshot version 2 keeps the existing cell fields and raw `blocks` array, then
adds an optional `turn` object:

```text
CellSnapshot v2
  existing v1 fields
  blocks                 raw evidence ledger
  turn
    id
    status
    outcome
    metrics
    presentation
```

Runtime activities, diagnostics, and changes are derived from `blocks` with
the Turn overlay. This reduces duplicate storage and allows an older plugin to
continue reading raw assistant and tool content from `blocks`.

Version 1 migration is in-memory and deterministic:

1. Preserve every cell and block.
2. Derive activity metadata from legacy text and tool blocks.
3. Select an Outcome using the same resolution order.
4. Initialize trace presentation to `auto`.
5. Write version 2 only when the document is next saved.

Unknown future activity kinds are rendered through the generic activity
presenter instead of being dropped. A running Turn is persisted as interrupted,
as the existing snapshot behavior requires.

## Risks / Trade-offs

**[Outcome extraction can disagree with a provider that reports little result
metadata]** → Keep the fallback chain explicit, preserve the final assistant
message in the ledger, and add tests for empty, duplicate, and error results.

**[Deterministic summaries may omit a detail the user expects]** → Keep every
summary expandable and retain the complete raw evidence; never hide
diagnostics or file changes behind the trace.

**[Collapsed trace state may make a running task feel stalled]** → Keep the
current activity, running indicator, and live header metadata visible even
when older rows are compact.

**[A user's manual expansion can conflict with automatic completion folding]**
→ Represent `auto`, `expanded`, and `collapsed` explicitly and let explicit
user choices win until the next execution.

**[Large raw outputs can still burden memory and persistence]** → Do not
duplicate them in the Turn overlay, defer raw DOM creation, and render only
bounded previews by default.

**[Changing the block union can break legacy render assumptions]** → Keep the
existing block identities for text and tool evidence and place Turn-only state
in a separate optional overlay.

**[Tool summary formatting can drift between server and frontend]** → Keep
user-facing summaries in the frontend presenter and reserve server enrichment
for measured metadata and raw event data.

**[Frequent rerenders can steal focus or scroll]** → Update activity nodes by
identity, preserve focused disclosure controls, preserve cell and preview
scroll positions, and avoid replacing the whole output tree.

**[Theme and narrow-layout regressions can make controls overlap]** → Use
JupyterLab tokens, responsive grid tracks, wrapping rules, and viewport tests
for narrow, desktop, and long-content cases.

## Migration Plan

1. Extend event and snapshot types without removing existing block fields.
2. Add the Turn reducer and presenter behind the new cell rendering path.
3. Convert version 1 documents into the Turn view when loaded.
4. Save version 2 snapshots only after the new renderer can round-trip version
   1 fixtures.
5. Keep queue, history, Command execution, cell output collapse, and running
   indicator behavior covered by regression tests.
6. If a rollback is required before a version 2 document is reopened by an
   older plugin, the raw `blocks` field remains available; Turn-only metrics
   and disclosure preferences are ignored by the older version.
