## Context

See `proposal.md` for motivation and the delta specs for behavior. Remote validation on `10.9.34.84` used a 1.9 MB version 2 workspace containing 26 Cells, 25 AI Turns, 408 stored blocks, four interrupted Cells, and execution counts from 21 through 51. It rendered acceptably with the new navigation rail, but reopening created a new backend `AgentSession` whose ready event always reported `sessionId: "default"`.

The backend currently sets Claude CLI `--no-session-persistence`, constructs the SDK client before any document context is supplied, and does not forward `ResultMessage.session_id`. `AgentWorkspaceContent` starts its WebSocket in the constructor before `DocumentRegistry.IContext.ready`, so the frontend cannot restore document-owned session metadata before connecting. Version 2 snapshots persist Cells and Turns but have no runtime-context field.

## Goals / Non-Goals

**Goals:**

- Make runtime-context continuity truthful, durable, explicit, and user-controlled.
- Preserve existing connection single-flight, stale-client retry, queue, Command shell, and document evidence behavior.
- Add deterministic orientation for long workspaces without a model-generated summary.
- Fail closed when a saved context cannot be resumed and keep historical content readable.
- Validate migration and resume behavior without disturbing the active `10.9.34.84:8888` service.

**Non-Goals:**

- Embedding the Claude JSONL transcript, credentials, or environment configuration in `.agentnb`.
- Making a linked workspace portable across servers without its server-owned SDK session data.
- Semantic model-generated task grouping, automatic goal extraction, conversation compression, or cross-provider resume in this change.
- Deleting old SDK sessions when a user starts a new context.
- Changing Command-cell shell restoration; shell cwd remains tab-lifetime state.

## Decisions

### Upgrade the document root to version 3 with one opaque session link

`WorkspaceSnapshot` gains `agentSessionId: string | null` and increments `AGENT_WORKSPACE_VERSION` to 3. The value is an opaque validated UUID. Version 1 and 2 documents normalize to `null` while retaining every existing Cell, Turn, status, count, and disclosure field.

Only the identifier is stored. Resume state (`new`, `live`, `resumed`, `unavailable`, or `reset`) is runtime presentation derived from connection events and is not persisted. This prevents a stale document from claiming it is currently resumed.

Persisting the complete SDK transcript was rejected because the document already contains a product-level audit representation and raw SDK history may include provider-specific content, credentials, or sidechain state. Keeping the identifier only also matches the SDK's native resume contract.

### Delay Agent connection until document context is ready

`AgentWorkspaceContent` no longer calls `start()` from its constructor. `attachContext()` restores the snapshot, configures `AgentSession` with `agentSessionId`, and only then connects. Standalone construction remains inert until explicitly started, which makes startup order testable and prevents an unresumable placeholder connection racing document load.

`AgentSession.configureContext(id)` is allowed only before an active socket exists. Its WebSocket URL adds an encoded `sessionId` query parameter when present. Start new context closes the old socket, clears transient blocks/error/run state, configures `null`, and reconnects through a dedicated reset method.

Connecting immediately and trying to switch context later was rejected because an SDK client cannot safely replace its conversation identity after startup. Sending the identifier in the first user message was rejected because the backend starts before that message and ready-state truth would remain ambiguous.

### Use SDK-native persisted sessions with explicit new or resume options

The server validates `sessionId` as a UUID before constructing `AgentSession`. For a fresh workspace it generates a UUID and supplies `ClaudeAgentOptions.session_id`; for a linked workspace it supplies `ClaudeAgentOptions.resume`. It removes the `no-session-persistence` CLI flag so the dedicated AI Terminal `CLAUDE_CONFIG_DIR` retains the SDK transcript.

New-session and resume options are never combined. The dedicated config directory remains under Jupyter configuration, separate from the user's normal Claude configuration. Existing environment filtering and setting-source isolation stay unchanged.

Generating a new identifier on the frontend was rejected because session ownership and validation belong to the server. Using `continue_conversation=True` was rejected because it selects a most-recent session by cwd and could connect one workspace to another workspace's context.

### Report context lifecycle explicitly over the protocol

The ready event becomes:

```text
ready {
  sessionId: UUID,
  contextState: "new" | "resumed",
  model,
  cwd
}
```

Final result events also include `sessionId` from `ResultMessage.session_id`. Frontend `AgentSession` tracks the latest real identifier and a state union that also includes `connecting`, `live`, `unavailable`, and `reset`. After a successful result, new/resumed becomes live and the workspace persists the latest ID immediately.

Backend connection failure while a resume ID is requested emits error code `resume` and does not construct a fresh fallback. Existing `config`, `runtime`, and `denied` errors remain. A resume error moves the frontend to unavailable and prevents queued AI work from silently draining through new context; Command work remains usable because it is independent.

Keeping `sessionId: "default"` was rejected because it cannot support document linkage. Treating all resume startup errors as ordinary runtime failures was rejected because the recovery action and risk of context loss differ.

### Preserve stale-client retry without changing identity

`AgentSession` retains its requested or confirmed session ID after a stale SDK connection is discarded. Reconnection rebuilds options with `resume=<same-id>` and retries once. A stale reconnect therefore preserves current conversation identity or fails as resume-unavailable; it never creates a new session implicitly.

### Add an explicit context control, not a passive ambiguous badge

The fixed bottom overview extends the existing status regions:

```text
Connected · Context: Resumed | cwd | 25 turns · 4 interrupted · 9 failed | Ready
```

Context state is a native button when an action is available. Activating it opens a small disclosure explaining whether history is in model context and exposing **Start new context**. Reset requires a second explicit activation inside the disclosure, but not a blocking browser dialog; this keeps keyboard flow and makes the consequence visible next to the action.

At narrow widths, context plus active execution remain visible. Cwd yields first, then secondary counts move into the disclosure. The overview stays fixed-height and uses JupyterLab tokens.

A toolbar-only reset icon was rejected because an unlabeled destructive-to-context action is too easy to trigger and provides no explanation. A full top-of-document dashboard was rejected because it consumes primary reading space and scrolls away in long sessions.

### Derive overview counts from saved domain state

A pure overview projection consumes Cells plus runtime UI state and returns:

- submitted AI and Command Cell counts;
- queued/running counts;
- interrupted Cell count;
- distinct failed Turn diagnostic count;
- context label/action availability.

The projection key excludes outcome text, raw block output, and Turn revisions that do not change counts. Status DOM updates only when the projection changes. Failure activation resolves the first Cell with diagnostics and reuses stable-ID Cell reveal. Interrupted activation resolves the first interrupted Cell.

Generating a summary through the model was rejected because it adds cost, latency, nondeterminism, and a second context whose truth may differ from the runtime being described.

### Keep long-history search as a presentation-layer palette

The compact rail remains the default presentation. The overview turn-count button and narrow-mode Cell history control open the same reusable palette, which contains one search input and a keyed ordered result list. Filtering uses normalized current Cell source locally; it never invokes the Agent or changes document state. The palette reuses stable-ID activation, roving focus, accessible names, and reduced-motion behavior from the navigator.

Each navigation entry also carries its deterministic Turn diagnostic count. A failed entry receives a non-color marker cue and an accessible name suffix such as `2 failed`; the overview failure button continues to navigate to the first failed Cell. Failure state is derived from saved Turn diagnostics, not from a model classification pass.

Adding a permanent text list beside the rail was rejected because the real 25-turn workspace would lose the requested compact default. Making the palette a browser-global command menu was rejected because Cell navigation must remain scoped to the active workspace document.

### Prepare retries as new editable Cells

Failed and interrupted Turn audit summaries gain one native `Retry as new turn` button. The action resolves the source Cell by stable ID, inserts a fresh Cell immediately after it, copies only the current source/kind, selects the new Cell in edit mode, focuses the editor, and persists the document. It copies no output, blocks, Turn state, execution count, collapse state, or SDK identifiers.

The action prepares a draft rather than executing immediately. Agent work often has filesystem or network side effects, so a one-click automatic rerun would repeat an operation before the user can inspect or adjust the prompt. Keeping the original Cell immutable preserves the audit trail and makes retries comparable in the history rail.

Changing ordinary notebook rerun semantics globally was rejected because successful exploratory Cells may still reasonably be rerun in place. Hiding retry only in the workspace-level failure overview was rejected because recovery belongs next to the actual failed Turn as well as in aggregate orientation.

### Give final Markdown a workbench-density rhythm

The final outcome keeps JupyterLab's sanitized Markdown renderer and semantic DOM, but `.jp-AgentWorkspace-outcomeBody` owns a small set of scoped spacing tokens for ordinary prose gaps, list-item gaps, section gaps, and structured-content gaps. Direct paragraphs and lists use the ordinary gap; list items use a smaller gap; and `li > p` removes the inherited paragraph margin that otherwise stacks with the list margin. Nested lists retain a small inset gap so hierarchy remains visible without looking like a new section.

Headings use a larger leading section gap and a compact trailing gap. Code blocks, tables, quotes, figures, and media keep a stronger boundary than ordinary paragraphs and retain their existing local overflow behavior. The readable direct-prose measure remains in place, while structured content continues to use the available workspace width.

All selectors stay beneath `.jp-AgentWorkspace-outcomeBody`, use unitless line height and relative spacing, and leave colors, focus indicators, disclosure controls, execution records, and renderer semantics unchanged. This keeps light/dark themes and 200 percent text reflow compatible. A fixed-height summary, blanket removal of all margins, and rewriting Markdown into custom presentation markup were rejected because they would respectively clip content, erase hierarchy, or duplicate and weaken the trusted renderer contract.

### Treat unavailable resume as a recoverable document state

When resume fails, historical Cells remain normal and readable. The status disclosure explains that the transcript is visible but not loaded into model context. Run controls for AI requests remain blocked until the user chooses Start new context or retry; Command cells remain available. The first rejected AI Cell retains an actionable resume error rather than being silently replayed later.

No automatic deterministic replay of previous user prompts is attempted. Replaying could repeat side effects and would still not reconstruct hidden model/tool state exactly.

## Risks / Trade-offs

**[SDK persistence increases server-side retained data]** -> Keep it in the dedicated AI Terminal Claude config directory, persist only an opaque ID in `.agentnb`, document the retention behavior, and leave deletion/retention controls to a later administrative change.

**[A copied document carries a meaningless server-local ID]** -> Validate resume, enter unavailable state, preserve the document, and require explicit fresh context instead of fallback.

**[Old workspaces appear historical but have no model context]** -> Version migration sets no ID and the overview explicitly says Context: New.

**[Resume failure could block useful Command work]** -> Block only AI-context submission; keep Command shell execution and document navigation available.

**[Removing eager constructor start breaks tests or launcher timing]** -> Make `attachContext()` the production startup boundary, keep explicit `start()` for isolated tests, and cover single connection plus context-before-connect ordering.

**[Overview counts churn on streaming events]** -> Use a coarse projection key and exclude raw output/revision changes.

**[Session ID exposure aids cross-workspace guessing]** -> Require UUID syntax, treat the ID as opaque, keep WebSocket authentication, resolve sessions only inside the dedicated server-owned config store, and never interpret the ID as a direct path.

**[Compact Markdown makes complex results visually flat]** -> Keep heading and structured-content gaps larger than paragraph/list gaps, retain semantic heading levels, and validate paragraphs, nested lists, code, tables, quotes, and narrow reflow together.

## Migration Plan

1. Add version 3 snapshot normalization and round-trip tests while retaining version 1/2 fixtures.
2. Extend protocol types and event conversion with session ID and context state.
3. Add UUID validation and new/resume SDK option tests on the Python backend.
4. Defer frontend connect until context restore, then add unavailable and reset state transitions.
5. Add pure overview projection and fixed status disclosure with failure/interrupted navigation.
6. Run Python tests, frontend tests, typecheck, lint, production build, and strict OpenSpec validation.
7. Deploy to the isolated `10.9.34.84:8889` candidate, create a fresh session, close/reopen it, verify resume with a context-dependent prompt, test copied/missing-ID failure, and verify the existing `:8888` service remains unchanged.
8. Apply scoped final-outcome density tokens, run renderer/style regressions, and validate representative long Markdown summaries at wide and constrained widths in the explicitly selected deployed environment.

Rollback restores version 2 serialization and ephemeral SDK startup. Version 3 readers write only one nullable root field, so rollback testing must confirm older code ignores the additional field and still restores Cells safely.
