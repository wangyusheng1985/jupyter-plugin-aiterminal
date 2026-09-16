## 1. Command History Model

- [x] 1.1 Add a session-only Command history model with oldest-to-newest
  entries, navigation cursor, and captured draft; verify append order,
  consecutive duplicate collapse, and empty-input rejection with focused unit
  tests.
- [x] 1.2 Implement older/newer navigation with stable boundary behavior and
  draft restoration; verify repeated `ArrowUp`, repeated `ArrowDown`, and
  navigation reset with focused unit tests.
- [x] 1.3 Own one history model per `AgentWorkspaceContent` instance and keep
  it out of document serialization; verify two content instances do not share
  entries and saving/reloading does not restore history.

## 2. Recording Command Submissions

- [x] 2.1 Record an accepted Command cell source at the submission boundary
  before queue promotion; verify queued commands are immediately recallable
  and rejected empty submissions are not recorded.
- [x] 2.2 Leave AI submissions out of command history; verify a submitted AI
  cell does not change the current tab's Command history.
- [x] 2.3 Preserve submitted command entries after queued execution completes,
  fails, or is interrupted; verify each outcome leaves the entry available.

## 3. Editor Navigation

- [x] 3.1 Add Command-cell-only arrow-key handling for editable inputs, with
  guards for modifiers, text selection, read-only cells, and multiline caret
  position; verify AI and non-editable inputs retain native arrow behavior.
- [x] 3.2 Connect `ArrowUp` to older history and `ArrowDown` to newer history
  while keeping the visible editor, current cell source, and history cursor in
  sync; verify empty-input recall and forward navigation with DOM/unit tests.
- [x] 3.3 Preserve the pre-navigation draft and restore it after moving past the
  newest command; verify the editor value and cell source both restore.
- [x] 3.4 End navigation when the user edits recalled text, blurs the editor,
  changes cells, or changes cell kind; verify a later rerender does not
  overwrite unrelated text.

## 4. Integration Verification

- [x] 4.1 Run `jlpm test` and verify the history model, workspace input, queue,
  and document suites pass together.
- [x] 4.2 Run `jlpm typecheck`, `jlpm eslint`, and `jlpm prettier:check` and
  verify no type, lint, or formatting regressions.
- [x] 4.3 Run `jlpm build` and verify the generated extension includes the
  Command history behavior.
- [x] 4.4 Exercise two workspace tabs: submit distinct commands, verify
  histories remain isolated, recall older/newer entries with Up/Down, restore a
  draft with Down, and confirm AI-cell arrow editing is unchanged.
