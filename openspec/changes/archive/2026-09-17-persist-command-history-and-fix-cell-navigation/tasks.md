## 1. Persistent Storage

- [x] 1.1 Generalize the history model and versioned browser-storage adapter to
  one AI/Command input history, including legacy command-history import; verify
  focused tests cover valid data, malformed data, migration, unavailable
  storage, quota/write failures, and entry/byte bounds.
- [x] 1.2 Load history after the workspace document path is available and save
  after each accepted AI or Command submission; verify recreating a workspace
  with the same path restores its entries and a different path remains
  isolated.
- [x] 1.3 Record every accepted AI and Command submission at the submission
  boundary; verify queued, failed, interrupted, empty, duplicate, and
  unsubmitted-draft behavior.
- [x] 1.4 Preserve chronological shared tab history after restore; verify AI
  and Command entries are recallable from Command, AI, and newly created cells.

## 2. Run-And-Advance Focus

- [x] 2.1 Re-synchronize notebook views after automatic advance and before
  focusing the new input; verify the new textarea is editable and
  `document.activeElement` immediately after `Shift+Enter` submission.
- [x] 2.2 Add a regression test that submits a Command with run-and-advance and
  verifies `ArrowUp` in the new input recalls that command without an extra
  click or refresh.

## 3. Regression Verification

- [x] 3.1 Run the focused history, key, notebook, and workspace test suites and
  verify all assertions pass.
- [x] 3.2 Run `jlpm test`, `jlpm typecheck`, `jlpm eslint`, and
  `jlpm prettier:check`; verify all commands succeed.
- [x] 3.3 Run `jlpm build` and verify the generated labextension contains the
  unified persistent history adapter and automatic-advance focus fix.
- [x] 3.4 Perform a browser smoke test after reopening the workspace and
  verify AI and Command entries remain shared and isolated by workspace tab,
  and `ArrowUp` works immediately in a new cell after execution.
