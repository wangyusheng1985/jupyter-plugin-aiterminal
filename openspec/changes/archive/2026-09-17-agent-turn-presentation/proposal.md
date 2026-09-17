## Why

AI cells currently render every assistant message and tool call as an equally
weighted, fully expanded block. Multi-step turns routinely contain dozens of
tool calls and hundreds of thousands of characters, so the final result and
actionable failures are buried in raw output.

## What Changes

- Model each AI execution as a Turn with a final Outcome, ordered Activities,
  Diagnostics, file Changes, and execution Metrics.
- Use the SDK's `ResultMessage.result` as the canonical final result instead of
  treating the last text block as the answer.
- Present completed turns in a summary-first Focus View: keep the result,
  warnings, and changes visible while collapsing the detailed trace.
- Expand the trace, individual steps, and raw evidence on demand without
  deleting or rewriting the original tool input or output.
- Summarize tools deterministically by type, such as file and line counts for
  reads, match counts for searches, commands and output previews for Bash, and
  diff statistics for edits.
- Treat thinking as activity state by default rather than displaying raw
  reasoning content.
- Correlate server events with a `turnId`, enrich tool lifecycle data with
  timing and size metadata, and expose result metrics without changing queue
  semantics.
- Upgrade `.agentnb` persistence to a versioned Turn snapshot while continuing
  to restore version 1 workspaces.
- Preserve notebook conventions, JupyterLab theme tokens, `[*]` queue status,
  the compact output collapser, keyboard accessibility, and reduced-motion
  behavior.

## Capabilities

### New Capabilities

- `agent-turn-presentation`: Defines turn-level outcome, activity, diagnostic,
  evidence, expansion, and persistence behavior for AI cells.

### Modified Capabilities

None.

## Impact

Affected areas include the Agent SDK event bridge, WebSocket protocol, frontend
turn model and renderer, tool presentation helpers, workspace snapshots, and
Agent Workspace styles. Existing AI, Command, queued-run, history, and cell
output-collapse behavior remains supported. Version 1 `.agentnb` files remain
readable; newly saved files use a forward-compatible version 2 snapshot.
