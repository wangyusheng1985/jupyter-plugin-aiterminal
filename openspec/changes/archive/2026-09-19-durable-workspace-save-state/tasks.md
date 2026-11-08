## 1. Save Coordinator

- [x] 1.1 Add a pure revision-based save coordinator with `saved`, `pending`, `saving`, and `error` state, and verify deterministic state transitions plus no-op flushes with unit tests.
- [x] 1.2 Implement debounce and one shared in-flight drain that coalesces rapid mutations and edits arriving during save into the newest follow-up snapshot, and verify deferred-promise tests prove the maximum concurrent save count is one.
- [x] 1.3 Preserve dirty revisions across rejection and implement explicit retry plus mutation-triggered recovery without automatic retry loops, and verify repeated failure/success tests never report an unsaved revision as Saved.

## 2. Workspace Persistence Integration

- [x] 2.1 Replace direct timer/save handling in `AgentWorkspaceContent` with coordinator mutation marking and latest-snapshot model synchronization, and verify Cell, Turn, context-link, navigation, and disclosure mutations still persist their newest serialized state.
- [x] 2.2 Reconcile document readiness and idle external model restoration with coordinator state while preserving the `applyingModel` loop guard, and verify existing version 1–4 fixtures restore as Saved without schema or content drift.
- [x] 2.3 Make Retry save call the same single-flight drain and verify editing, AI execution, Command execution, interrupt, and queue operations remain usable while save state is pending or failed.
- [x] 2.4 Drain debounce, in-flight save, and any newest follow-up revision inside `shutdownOnce()` before Agent disconnect in `finally`, and verify close-during-debounce, close-during-save, repeated shutdown, and failed-final-save ordering.

## 3. Save-State Experience

- [x] 3.1 Extend coarse workspace UI state with save phase, concise label, and retry availability, and verify save-only changes do not alter execution/context truth or trigger output/navigation projection churn.
- [x] 3.2 Add one atomic polite save-status group and keyboard-accessible Retry save control to the bottom status bar, and verify Saved, Saving…, Not saved, repeated retry, disabled, focus-preservation, and screen-reader semantics in DOM tests.
- [x] 3.3 Style save feedback with existing Jupyter theme and motion tokens, persistent non-color error treatment, stable dimensions, and container-responsive reflow, and verify light/dark token use, reduced motion, 200% text, and narrow-panel operation without horizontal page scrolling.

## 4. Compatibility and Rollout Verification

- [x] 4.1 Verify save coordinator runtime fields, errors, counters, and retry state never enter `.agentnb`, and prove equivalent notebook state serializes identically before and after this capability.
- [x] 4.2 Run Python tests, `jlpm test --runInBand`, `jlpm typecheck`, `jlpm lint`, `jlpm build:prod`, strict OpenSpec validation, and `git diff --check`; verify no new runtime dependency or backend/protocol change is introduced.
- [ ] 4.3 Back up and update only the existing `10.9.34.84:8888` installation, restart its current service, and verify served asset hashes, extension registration, single-port health, normal deployed save success, and the documented rollback path without starting another environment.
