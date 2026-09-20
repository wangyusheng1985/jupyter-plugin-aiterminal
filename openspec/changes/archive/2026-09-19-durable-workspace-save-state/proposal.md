## Why

AI Terminal currently updates the in-memory document and calls `context.save()`, but a failed save is reported only to the browser console. The workspace can continue to look ready even though recent Cells, Agent context linkage, and presentation state are not durable, creating avoidable data loss on refresh or close.

## What Changes

- Coordinate workspace saves through one single-flight pipeline that coalesces edits made while a save is pending and always saves the latest snapshot next.
- Expose explicit `Saving`, `Saved`, and persistent `Not saved` state in the workspace status region without blocking editing or execution.
- Provide a keyboard-accessible Retry action after failure; later edits may also start a new save attempt without creating parallel saves.
- Flush the latest snapshot when the workspace shuts down and wait for already-started/follow-up saves where the lifecycle permits, while keeping Agent shutdown single-flight.
- Keep save-state presentation runtime-only: no transient saving/error metadata is written into `.agentnb`.
- Verify debounce, overlapping edits, failure/retry, close-during-save, narrow layout, screen-reader announcements, and unchanged Agent/Command execution behavior.

## Capabilities

### New Capabilities

- `workspace-save-reliability`: Durable single-flight workspace persistence, visible save truth, recoverable failures, and lifecycle flushing.

### Modified Capabilities

<!-- No existing main-spec requirements change. -->

## Impact

- Workspace persistence orchestration in `src/agent/workspace.ts` and a testable save coordinator module.
- Workspace/UI state projection, bottom status presentation, keyboard behavior, responsive CSS, and accessibility tests.
- Document-context save mocks and lifecycle tests for coalescing, failure recovery, and disposal.
- Existing `.agentnb` schema, Agent protocol, credentials, runtime dependencies, and backend APIs remain unchanged.
