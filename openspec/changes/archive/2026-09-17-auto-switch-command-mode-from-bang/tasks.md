## 1. Unified Input And Classification

- [x] 1.1 Add ephemeral shell-marker classification derived from the first
  non-whitespace `!` in cell source; verify notebook tests cover ordinary,
  marked, whitespace-prefixed, and marker-only input.
- [x] 1.2 Route typing, paste, and history recall through one source handler
  that defaults to the AI path and selects shell execution only while the
  marker is present; verify workspace tests cover each source-change path.
- [x] 1.3 Remove the public AI/Command kind setter and toggle behavior from the
  editor flow; verify tests no longer depend on explicit mode switching.
- [x] 1.4 Remove the toolbar type selector, prompt double-click handler,
  `AI`/`sh` badges, and mode-specific status text; verify DOM tests assert the
  unified prompt, toolbar, insertion, and status behavior.
- [x] 1.5 Normalize legacy Command cells when a workspace is restored by
  preserving source, adding one visible `!` marker when absent, and keeping
  normalization idempotent; verify document round-trip tests.

## 2. Execution, History, And Queue Semantics

- [x] 2.1 Separate the submitted source from the execution source in run
  requests so history retains `!command` while the shell receives `command`;
  verify notebook and workspace tests cover both values.
- [x] 2.2 Reject a marker-only submission after stripping `!` and whitespace so
  it creates no shell request or history entry; verify the rejection test.
- [x] 2.3 Preserve the stripped execution source in queued prefix-controlled
  commands while retaining the marker in visible source and shared history;
  verify queued, failed, and interrupted request tests.
- [x] 2.4 Make run-and-advance from a prefix-controlled command create a new
  editable unified AI input; verify focus, editability, and next-input
  classification tests.

## 3. History Recall And Restoration

- [x] 3.1 Apply marker transitions when source is recalled from history so
  recalling `!command` selects shell execution and deleting `!` returns to the
  AI instruction path; verify workspace keyboard-navigation tests.
- [x] 3.2 Preserve marker behavior after saving and reopening a workspace,
  including the ability to delete `!` and revert to AI mode; verify document
  round-trip and restored-workspace tests.

## 4. Regression Verification

- [x] 4.1 Run the focused notebook, document, workspace, history, and key test
  suites and verify all marker, queue, history, and focus assertions pass.
- [x] 4.2 Run `jlpm test`, `jlpm typecheck`, `jlpm eslint`, and
  `jlpm prettier:check`; verify all commands succeed.
- [x] 4.3 Run `jlpm build` and verify the generated labextension includes the
  marker transition, execution-source separation, and next-input behavior.
- [x] 4.4 Perform a browser smoke test on an existing Jupyter environment and
  verify typing `!` selects shell execution, execution strips the marker,
  deleting `!` returns to the AI path, run-and-advance returns to AI input, and
  no AI/Command selector or badge remains visible.
