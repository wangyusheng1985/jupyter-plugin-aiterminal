## Why

An `.agentnb` can display a complete multi-turn audit record while its next AI request starts in an unrelated fresh Agent context. The attached disk-cleanup case proved that this mismatch makes a follow-up such as “结果如何了？” appear to lose memory and also strands background-task identifiers that still exist in saved tool evidence.

## What Changes

- Detect when submitted AI Cells are visible but no resumable Agent session covers them, and stop the first AI submission from silently entering an empty context.
- Present one focused, keyboard-accessible choice: **Continue from visible history** as the primary recovery action or **Start empty context** as the explicit alternative.
- Build a deterministic, bounded, read-only history capsule from saved user inputs, final outcomes, and background-task references, and attach it exactly once to the next request after the user chooses continuity.
- Never replay saved tool commands, read task output files automatically, or store credentials/raw SDK transcripts in the bridge.
- Persist which Cells were bridged and where native work in the new context begins, so status, navigation, reopen, copy, and reset flows communicate the real context boundary.
- Derive background-task references and their last known states from already persisted tool blocks so follow-up work can locate evidence after a frontend or SDK-session discontinuity.
- Keep Command execution available while the AI-context choice is unresolved, and preserve the existing resume-unavailable fail-closed behavior.

## Capabilities

### New Capabilities

- `workspace-history-bridge`: Safe, explicit continuity from visible `.agentnb` history into a fresh Agent context, including durable context-boundary metadata and saved background-task references.

### Modified Capabilities

<!-- No existing main-spec requirement changes. Agent SDK resume remains the preferred path; this capability applies only when resume cannot cover visible history. -->

## Impact

- Versioned `.agentnb` normalization and migration for context-boundary and bridged-Cell metadata.
- Pure frontend projections for eligible history, bounded capsule construction, background-task extraction, and prompt composition.
- AI submission gating, context-choice presentation, status/rail markers, focus management, and reset/reopen behavior in the workspace.
- Protocol/backend tests proving the original Cell source remains unchanged and only the composed model request receives bridge context.
- Regression and deployed-environment validation using the supplied disk-cleanup workspace, copied/unavailable sessions, long histories, background task evidence, Command execution, keyboard operation, narrow layouts, and reduced motion.
- No new runtime dependency, no automatic model summarization request, and no automatic re-execution or file read.
