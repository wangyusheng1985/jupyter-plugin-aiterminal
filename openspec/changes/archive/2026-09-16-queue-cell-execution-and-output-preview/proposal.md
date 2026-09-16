## Why

Running a second cell while another AI or Command cell is active currently fails
instead of behaving like a notebook. Long outputs also have only a full hide
action, which makes it difficult to keep multiple results visible and inspect
them without expanding every cell.

## What Changes

- Queue AI and Command execution requests within a workspace and run them FIFO,
  one at a time.
- Snapshot each cell's source when it is submitted, preserve the submission
  order, and continue with the next queued request after completion, failure,
  or interruption of the active request.
- Show notebook-style `[*]` prompts for queued and running cells, assign the
  numeric execution count only when a request actually starts, and keep queue
  state ephemeral across saves/reloads.
- Replace full output hiding with a compact collapsed state that keeps a
  bounded, internally scrollable preview of the output.
- Preserve the existing expanded-output behavior and ensure running indicators
  appear only for the actively executing cell.

## Capabilities

### New Capabilities

- `cell-execution-queue`: Defines FIFO queueing, status visualization, source
  snapshotting, lifecycle behavior, and interrupt semantics for AI and Command
  cell runs in one workspace.
- `compact-output-collapse`: Defines the bounded-height, scrollable output
  preview used when a cell's output is collapsed.

### Modified Capabilities

None.

## Impact

- Frontend workspace scheduling and run-state transitions in
  `src/agent/workspace.ts` and `src/agent/notebook.ts`.
- Cell and output rendering in `src/agent/workspace.ts`, with supporting styles
  in `style/base.css`.
- Persisted `.agentnb` normalization so ephemeral queue state is not restored
  as active work.
- Frontend unit tests for queue ordering, prompt counts, interruption,
  persistence, and compact output layout.
- No WebSocket protocol change, backend queue, shell behavior change, or new
  runtime dependency is required because requests remain serialized before
  they reach the existing per-workspace session.
