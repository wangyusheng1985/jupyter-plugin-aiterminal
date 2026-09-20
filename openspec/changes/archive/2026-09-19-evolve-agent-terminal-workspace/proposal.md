## Why

AI Terminal now presents and navigates long workspaces well, but a saved `.agentnb` is still only a visual transcript: reopening it creates a fresh Agent SDK client even though the interface looks like a continuous conversation. A real 1.9 MB workspace on `10.9.34.84` contained 25 completed/interrupted turns and 408 evidence blocks, making runtime-context truth, failure orientation, and safe continuation more important than additional visual decoration.

## What Changes

- Reposition AI Terminal as a durable, inspectable Agent workbench: the document is the audit record, while runtime context has an explicit lifecycle that users can understand and control.
- Persist the actual Agent SDK session identifier after a successful AI turn and request that session when the same workspace is reopened.
- Distinguish new, live, resumed, unavailable, and explicitly reset runtime context; never imply that visible historical Cells are automatically in model context when they are not.
- Add an explicit **Start new context** action that clears the runtime linkage without deleting the workspace's Cells, outcomes, or evidence.
- Fail safely when a saved session cannot be resumed: preserve the document, explain the state, and require a deliberate fresh-context action before sending a prompt without history.
- Add a compact workspace overview that communicates turn count, interrupted/failed work, and runtime-context state without another model call.
- Make long final Markdown outcomes compact and scannable in the workbench: remove stacked paragraph/list whitespace while preserving semantic hierarchy, readable measure, structured-content width, and responsive reflow.
- Keep session identifiers opaque, exclude credentials and SDK transcript contents from `.agentnb`, and preserve older workspace compatibility through a document-version migration.

## Capabilities

### New Capabilities

- `workspace-context-continuity`: Durable linkage between a workspace document and its resumable Agent SDK context, including explicit reset and unavailable-state recovery.
- `workspace-task-overview`: Deterministic workspace-level orientation derived from saved Cell and Turn state, with no additional model inference.

### Modified Capabilities

- `agent-session-lifecycle`: The session lifecycle must initialize from document context, report the real SDK session identity and resume state, and avoid silently falling back from failed resume to an unrelated fresh context.

## Impact

- `.agentnb` snapshot version and migration logic in `src/agent/document.ts`.
- Workspace attachment order, session startup, persistence, status presentation, and reset controls in `src/agent/workspace.ts`.
- WebSocket URL/protocol and frontend session state in `src/agent/session.ts` and `src/agent/protocol.ts`.
- Resume query validation and Agent SDK option construction in `jupyter_aiterminal/handlers.py` and `jupyter_aiterminal/agent.py`.
- Python and TypeScript tests for session identity, resume, migration, unavailable recovery, explicit reset, and deterministic overview counts.
- No credential schema changes, no persisted raw SDK transcript in `.agentnb`, and no change to Command-cell shell persistence semantics.
