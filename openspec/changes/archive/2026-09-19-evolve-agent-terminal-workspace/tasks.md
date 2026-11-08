## 1. Version 3 Document Context

- [x] 1.1 Add nullable Agent session identity to version 3 workspace snapshots and verify version 1/2 migration plus version 3 round-trip tests preserve all existing Cells and Turn disclosure state.
- [x] 1.2 Add strict frontend session-ID normalization and verify malformed, non-string, empty, overlong, and valid UUID values normalize safely.
- [x] 1.3 Persist a newly confirmed session identity without output-only save churn and verify document tests observe one stable root field rather than credentials or transcript content.

## 2. Backend Resume Lifecycle

- [x] 2.1 Validate optional WebSocket session IDs as UUIDs before constructing the backend Agent session and verify handler tests reject malformed IDs without path interpretation.
- [x] 2.2 Generate a new UUID for fresh sessions, configure SDK-native persistence, and configure saved sessions with resume instead; verify option tests prove new-session and resume arguments are mutually exclusive and `no-session-persistence` is absent.
- [x] 2.3 Emit real session identity and new/resumed state on ready plus SDK-confirmed identity on result, and verify event-conversion tests cover each protocol payload.
- [x] 2.4 Emit a distinct resume-context failure without fresh fallback, retain identity through stale-client reconnect, and verify backend session tests cover failed resume, retry-once, and preserved context identity.

## 3. Frontend Context Lifecycle

- [x] 3.1 Extend protocol and frontend `AgentSession` state for connecting, new, live, resumed, unavailable, and reset contexts and verify URL encoding and event-state tests.
- [x] 3.2 Defer production WebSocket connection until document restore configures its saved context and verify workspace/factory tests prove context is set before the first connect and only one socket is created.
- [x] 3.3 Capture ready/result session identity, persist it after successful AI work, and verify new and resumed workspaces retain the confirmed ID across save/reopen.
- [x] 3.4 Block AI continuation after resume failure while preserving Command execution, Cells, navigation, and evidence, and verify recovery tests distinguish unavailable context from ordinary runtime/config failures.
- [x] 3.5 Implement confirmed Start new context behavior that reconnects without the previous ID and preserves the complete document, and verify reset plus subsequent-session persistence tests.

## 4. Workspace Overview and Recovery UI

- [x] 4.1 Add a pure workspace-overview projection for submitted AI/Command Cells, queued/running, interrupted, failed diagnostics, and context state and verify it ignores output-only Turn revisions.
- [x] 4.2 Extend the fixed overview/status presentation with explicit context text and compact deterministic counts and verify wide/narrow, empty, active, interrupted, failed, resumed, and unavailable DOM states.
- [x] 4.3 Add keyboard-accessible context disclosure and two-step Start new context action and verify focus, escape/dismissal, reduced-motion, and accidental-single-click behavior.
- [x] 4.4 Add failure/interrupted overview navigation through stable Cell IDs and verify activation reveals the first relevant Cell without entering edit mode.

## 5. Verification and Isolated Environment Rollout

- [x] 5.1 Run Python tests, `jlpm test --runInBand`, `jlpm typecheck`, and `jlpm lint` and verify all existing and new lifecycle, migration, overview, and navigation tests pass.
- [x] 5.2 Run `jlpm build:prod`, strict OpenSpec validation, and `git diff --check` and verify no new runtime dependency, credential field, or unrelated file change is introduced.
- [x] 5.3 Update the isolated `10.9.34.84:8889` candidate without restarting `:8888`, create a fresh Agent session, close/reopen it, and verify a context-dependent follow-up resumes correctly.
- [x] 5.4 In the isolated candidate, verify version 2 migration, unavailable copied-session recovery, explicit fresh reset, long-workspace overview counts, Command execution during unavailable context, and unchanged live `:8888` process/session state.

## 6. Long-History Orientation

- [x] 6.1 Add deterministic failure counts and non-color failure cues to navigation entries and verify marker, accessible-label, and overview navigation tests.
- [x] 6.2 Add a reusable searchable history palette opened from the overview or narrow-mode history control and verify local filtering, no-match state, keyboard focus, stable Cell activation, and default-rail compactness.
- [x] 6.3 Validate the searchable palette and failure markers against the real 25-turn candidate workspace and verify no workspace-level horizontal overflow or model request occurs during filtering.

## 7. Evidence-Preserving Retry

- [x] 7.1 Add a notebook operation that inserts a clean retry draft after a source Cell and verify it copies source/kind but no result, evidence, execution count, or collapsed state.
- [x] 7.2 Add an accessible Retry as new turn control to failed and interrupted AI Turn summaries and verify it is absent from successful Turns, does not start execution, preserves the original Cell, and focuses the new draft.
- [x] 7.3 Validate retry preparation on a failed real candidate Turn and verify source evidence, overview counts, navigation destinations, and runtime context remain unchanged until the draft is submitted.

## 8. Compact Final Markdown

- [x] 8.1 Add scoped final-outcome spacing tokens and compact paragraph, list-item, nested-list, and heading rhythm without changing renderer semantics or structured-content width; add regression coverage for the outcome scope and representative semantic Markdown structure.
- [x] 8.2 Run frontend tests, typecheck, lint, production build, strict OpenSpec validation, and `git diff --check`; deploy to the existing `10.9.34.84:8888` service and visually verify the current long summary at wide and constrained widths without duplicated gaps, clipping, or workspace-level horizontal overflow.
