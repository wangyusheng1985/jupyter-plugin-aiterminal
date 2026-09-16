## 1. Notebook Queue Model

- [x] 1.1 Add `queued` to the cell status model and introduce an ephemeral run
  request shape containing stable cell id, kind, source snapshot, and advance
  intent; verify duplicate submissions and source snapshots with
  `src/agent/notebook.spec.ts`.
- [x] 1.2 Add notebook operations to enqueue, promote the next request, and
  cancel all pending requests for a cell or a kind change; verify FIFO order,
  promotion to running, and cancellation behavior in notebook unit tests.
- [x] 1.3 Move execution-count allocation from submission to promotion and keep
  queued requests count-free; verify the count is assigned only when a request
  starts and that the last completed count remains persisted.
- [x] 1.4 Update document normalization so persisted `queued` status restores as
  idle without persisting queue membership, while `outputCollapsed` and prior
  output still round-trip; verify with `src/agent/document.spec.ts`.

## 2. Workspace Scheduling

- [x] 2.1 Replace the current `busy()` rejection in
  `AgentWorkspaceContent.runCell` with a single active request plus FIFO queue;
  verify a second AI or Command submission is accepted, stays queued, and is
  not sent to `AgentSession` before the first request terminates.
- [x] 2.2 Route Command completion/failure and AI completion/error/interruption
  through one queue-drain path so the next request always starts; verify queue
  progression after success, failure, and interruption.
- [x] 2.3 Update deletion and cell-kind switching so queued entries are canceled
  safely and the active running cell cannot be reclassified; verify pending
  request removal and active-run protection with focused tests.
- [x] 2.4 Handle run-and-advance at enqueue time and remove completion-time
  selection/focus movement; verify background completion does not change the
  current selection while immediate advance still works.
- [x] 2.5 Clear queued and active requests on workspace close/dispose without
  attempting to restore or resend them; verify via scheduler shutdown tests and
  the existing session-close behavior.

## 3. Prompt and Output UI

- [x] 3.1 Render `[*]` for both queued and running cells, show the queued
  output prompt when no prior output exists, and suppress the animated running
  indicator for queued cells; verify prompt and indicator DOM tests.
- [x] 3.2 Preserve prior output while queued, then clear it only when the
  request is promoted; verify this transition for both AI blocks and Command
  text.
- [x] 3.3 Replace the `OutputPlaceholder` full-hide path with a compact visible
  output body controlled by `outputCollapsed`; verify collapsed and expanded
  states for AI and Command cells with workspace rendering tests.
- [x] 3.4 Preserve output `scrollTop` across streamed rerenders and make the
  compact body keyboard-scrollable without changing the selected/editing cell;
  verify with a focused DOM test.
- [x] 3.5 Add compact-preview CSS with bounded height, internal scrolling,
  theme-compatible variables, and no regression to expanded output; verify CSS
  contains the compact rules and `yarn lint` passes.

## 4. Integration Verification

- [x] 4.1 Run `yarn test` and verify queue, prompt, persistence, rendering, and
  session tests pass together.
- [x] 4.2 Run `yarn typecheck` and `yarn eslint` and verify no TypeScript,
  accessibility, or lint regressions.
- [x] 4.3 Run `yarn build` and verify the generated Lab extension includes the
  queue and compact-output behavior.
- [x] 4.4 Exercise an AI cell followed by two Command cells while the first is
  running; verify all three run FIFO, prompts show `[*]`, counts start in
  execution order, and interrupting the active request still starts the next
  queued request.
- [x] 4.5 Exercise a long AI output and a long Command output; verify both
  collapse to a bounded scrollable preview, survive reload with the same state,
  and keep the full content inspectable.
