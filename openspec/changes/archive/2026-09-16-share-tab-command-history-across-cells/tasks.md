## 1. Cross-Cell Navigation

- [x] 1.1 Remove the Command-cell-only restriction from history key handling
  and verify editable AI cells can invoke the same tab history.
- [x] 1.2 Keep history navigation reset behavior for non-editable or
  non-editing cells and verify selecting another editable cell can still start
  history navigation.
- [x] 1.3 Verify a command submitted in an earlier cell is recalled from a
  newly created AI cell and that moving down restores the AI cell draft.

## 2. Regression Verification

- [x] 2.1 Update key and workspace tests for cross-cell history and verify the
  focused suites pass.
- [x] 2.2 Run `jlpm test`, `jlpm typecheck`, `jlpm eslint`, and
  `jlpm prettier:check`.
- [x] 2.3 Run `jlpm build` and verify the generated bundle contains cross-cell
  history navigation.
