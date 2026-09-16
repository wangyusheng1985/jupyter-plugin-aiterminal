## Context

Each AI Terminal tab is backed by one workspace document and one
`AgentWorkspaceContent` instance. Command submissions already pass through the
workspace scheduler, which preserves the submitted source before a request is
queued. The workspace document serializes cells and outputs, so history must be
kept outside that snapshot to preserve the session-only contract in
`specs/cell-input-history/spec.md`.

The input is a `textarea`, so hijacking arrow keys without editor guards would
break multiline caret movement.

## Goals / Non-Goals

**Goals:**

- Keep command history scoped to the lifetime of one open workspace tab.
- Record accepted Command cell submissions independently of execution outcome.
- Provide predictable shell-style Up/Down navigation with draft restoration.
- Keep the behavior testable without adding a new dependency.

**Non-Goals:**

- Persisting history in `.agentnb` files or across application restarts.
- Sharing history globally across tabs or with an external terminal.
- Searching, filtering, editing, or displaying a history list UI.
- Adding AI cell history.

## Decisions

### Use a dedicated session-only history model

Introduce a small `CommandHistory` model owned by `AgentWorkspaceContent`.
Store entries oldest-to-newest plus a nullable navigation cursor and the draft
captured when navigation starts.

This keeps ephemeral state out of `WorkspaceNotebook` and the serialized
document. Keeping it on the content instance also makes tab isolation natural:
closing or reopening a tab creates a new history instance with no state to
migrate.

Alternative considered: add history to the notebook snapshot. Rejected because
it would make history persistent and mix UI navigation state into the document
contract.

### Record at the accepted submission boundary

Add a command source to history only after `runCell` has accepted a non-empty
Command request. Record the source before queue promotion so queued commands
are immediately recallable, regardless of later success, failure, or
interruption. Consecutive duplicates are collapsed; a repeated command after a
different command remains distinct.

Alternative considered: record when execution starts. Rejected because a
command queued behind a long-running request would not be available for
recall, and canceled queued work would have inconsistent history behavior.

### Guard history navigation in the editor

Handle unmodified `ArrowUp` and `ArrowDown` on editable Command cell inputs.
Start navigation only when `ArrowUp` is pressed with no selection and the
caret is on the first line. Continue navigation while history browsing is
active. `ArrowDown` past the newest entry restores the saved draft and ends
history navigation.

The guard preserves normal multiline caret movement. AI cells and read-only
inputs never enter history navigation. Blur, selection, cell changes, kind
changes, and user edits end the navigation session so a later rerender cannot
silently replace unrelated text.

Alternative considered: handle every arrow key globally. Rejected because it
would make it impossible to move between lines in multiline commands and could
interfere with text selection.

### Separate user edits from programmatic recall

Keep a distinct callback for user input and for replacing the editor with a
recalled command. User input ends navigation; programmatic recall updates both
the visible editor and the current cell source without recording a new history
entry. A command is added to history only when the user submits it.

Alternative considered: update history on every editor input. Rejected because
partially typed text and arrow navigation would be recorded as commands.

## Risks / Trade-offs

- [Multiline editing still has edge cases] -> Require first-line caret position,
  no selection, no modifiers, and Command-cell-only activation; cover these
  guards with focused tests.
- [A rerender could overwrite recalled text] -> Keep navigation state scoped to
  the active editor interaction and end it on blur, selection, cell change, or
  editing.
- [History can grow during a long session] -> Keep the model isolated so a
  future size policy can be added without changing the document format.
