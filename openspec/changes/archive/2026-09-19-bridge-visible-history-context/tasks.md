## 1. Version 4 Context Boundaries

- [x] 1.1 Add version 4 root context generation/bridge records and per-Cell native generation, and verify version 1/2/3 migration plus version 4 round-trip tests preserve every source, Turn, evidence block, execution count, and disclosure state.
- [x] 1.2 Normalize invalid generations, duplicate bridge records, unknown/non-AI Cell IDs, and malformed arrays conservatively, and verify valid version 3 sessions migrate with only the newest successful AI Cell treated as native.
- [x] 1.3 Assign the active generation only after the SDK accepts an AI run, increment it on explicit replacement context, and verify pre-acceptance failure plus reset/reopen tests preserve earlier native boundaries without modifying old evidence.
- [x] 1.4 Carry the real session ID on the accepted event and persist it atomically with native/bridged membership, and verify an accepted Turn survives save/reopen before its final result without silently entering a fresh context.
- [x] 1.5 Normalize unlinked version 4 current native/non-empty bridge membership to uncovered while preserving prior-generation evidence and explicit empty-context policy, and verify the next AI draft is gated instead of silently using a fresh session.

## 2. Deterministic History and Task Projection

- [x] 2.1 Add a pure strict background-task reference projection for saved start and TaskOutput-style blocks, and verify valid IDs/absolute paths, latest saved running/completed/failed/killed state, deduplication, malformed-output rejection, and zero filesystem I/O.
- [x] 2.2 Add a pure versioned history-capsule builder for the newest eight eligible AI Cells with a 12,000-character cap, and verify chronological serialization, per-field/global truncation, omission counts, no raw tool inputs, and stability under output-only Turn revisions.
- [x] 2.3 Add a pure active-generation membership projection for native, bridged, outside, and draft Cells, and verify multiple resets, partial bridges, deleted Cells, and restored documents produce deterministic membership/counts.

## 3. Bridge Protocol and Server Composition

- [x] 3.1 Extend the frontend user-message protocol with one optional structured history bridge and a turn-scoped SDK-accepted event, and verify ordinary, bridged, reconnect, retry-once, and accepted messages preserve the original Cell source and turn ID.
- [x] 3.2 Validate bridge version, counts, field lengths, total size, task IDs, and absolute paths in the WebSocket handler before querying the SDK, and verify malformed or oversized bridges emit a context error without a model request.
- [x] 3.3 Compose the validated server prompt with a fixed read-only notice, JSON capsule, and latest current request, and verify tests prove historical commands are not promoted to instructions, no referenced file is read, and the current request appears last.

## 4. Submission Gate and Context Choice

- [x] 4.1 Gate only AI submission when meaningful visible history is uncovered, preserve the idle draft and advance intent, and verify empty workspaces submit normally while Command execution remains usable and does not resolve the choice.
- [x] 4.2 Implement Continue from visible history and Start empty context against the stable pending Cell ID, and verify each submits exactly once, cancels if the draft changes/deletes, disables duplicate activation, commits bridge membership only after SDK acceptance, and records the correct generation/bridge membership.
- [x] 4.3 Add keyboard focus, Escape/dismissal restoration, narrow reflow, and reduced-motion behavior to the existing context disclosure, and verify no request is sent on dismissal and the unchanged editor regains focus.
- [x] 4.4 Extend unavailable-session recovery with explicit bridged and empty alternatives while retaining the stale ID until a choice, and verify no implicit fresh retry, Cell mutation, or evidence loss occurs.
- [x] 4.5 Restore keyboard focus to the submitted Cell after acceptance or pre-acceptance failure when run-and-advance did not already focus the next draft, and verify no hidden acceptance control retains focus.

## 5. Truthful Context Presentation

- [x] 5.1 Extend overview/context text with native, bridged, and outside counts and explanations, and verify new, live, resumed, reset, unavailable, migrated, partial-bridge, empty-history, wide, and narrow DOM states.
- [x] 5.2 Add non-color compact navigator cues and accessible-name suffixes for bridged/outside Cells while preserving default rail density, stable keyed entries, history filtering, failure cues, viewport tracking, and no output-stream rerender churn.

## 6. Verification and Existing-Service Rollout

- [x] 6.1 Run Python tests, `jlpm test --runInBand`, `jlpm typecheck`, `jlpm lint`, `jlpm build:prod`, strict OpenSpec validation, and `git diff --check`; verify no new runtime dependency, credential field, raw SDK transcript, or unrelated file change is introduced.
- [x] 6.2 Back up and update the existing `10.9.34.84:8888` installation without starting another environment, restart only the original service, and verify the served frontend hash, backend module hashes, extension registration, HTTP response, and rollback artifacts.
- [x] 6.3 Open a copy of the supplied disk-cleanup workspace on `:8888`, submit “结果如何了？”, choose Continue from visible history, and verify the model receives saved task IDs/output paths, does not replay cleanup commands or auto-read files, retains the original draft in the document, and produces a context-aware response.
- [x] 6.4 Close/reopen the bridged copy and verify session resume plus durable native/bridged/outside markers, then validate Start empty context, copied/unavailable session recovery, eight-Turn/12,000-character limits, Command independence, keyboard flow, reduced motion, 820px layout, and removal of all acceptance-only drafts/files.
