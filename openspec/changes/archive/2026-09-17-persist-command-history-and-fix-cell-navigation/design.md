## Context

`AgentWorkspaceContent` already owns one history instance per open workspace
document, and accepted submissions are recorded before execution. The current
implementation records only Command submissions, keeps entries only in memory,
and has no document identity until `attachContext()` receives the workspace
path.

The automatic advance path also renders the notebook before
`advanceAfterRun()` changes the active cell. The target input is therefore
synchronized as read-only, and the following `focusActive()` call returns
without focusing it. A later refresh makes the input editable but does not move
keyboard focus from the previously executed cell.

## Goals / Non-Goals

**Goals:**

- Maintain one chronological input history for AI and Command submissions in
  the same workspace document.
- Restore that shared history after browser reload, tab reopen, or JupyterLab
  restart.
- Keep the history independent for different workspace documents and tabs.
- Make the input produced by run-and-advance editable and focused immediately.
- Keep storage failure and malformed data from breaking the workspace.

**Non-Goals:**

- Synchronizing history across browsers, devices, or Jupyter origins.
- Maintaining separate AI and Command history lists within one workspace.
- Storing history in the `.agentnb` document or adding a server-side history
  API.
- Preserving history when browser site data is explicitly cleared.

## Decisions

### Store one bounded AI/Command history in browser `localStorage`

Generalize the in-memory model to `WorkspaceInputHistory` and use the versioned
key `jupyter-aiterminal:input-history:v1:<encoded-path>`. The browser origin
already isolates different Jupyter servers, and the document path isolates
different workspace documents in the same browser.

Persist one JSON array containing accepted AI and Command strings, capped at
200 entries and a small byte budget. On load, ignore malformed values and
retain only valid, non-empty strings. Read or write failures fall back silently
to the existing in-memory behavior.

For compatibility with the command-only build created during this unreleased
change, if the unified key is absent, read `command-history:v1` and import its
valid entries into the unified history. Write the result under the unified key
and leave the legacy value unused rather than deleting it.

Alternatives considered:

- **Separate AI and Command histories:** rejected because users expect one
  workspace tab to behave like one history and because switching between cell
  kinds should not hide entries.
- **Sidecar file on the Jupyter server:** survives browser changes, but adds
  file lifecycle, permissions, concurrency, and cleanup concerns that are not
  required for a server restart.
- **Serialize history into `.agentnb`:** simple to reload, but mixes ephemeral
  local usage data into a workspace document and may expose AI prompts or
  commands when the document is shared.

### Load after the document path is available

Keep `WorkspaceInputHistory` as the in-memory navigation model and add a small
storage adapter used by `AgentWorkspaceContent`. Load restored entries once the
document context is ready, before the first editable interaction. A request is
recorded only after `enqueueRun()` accepts it, regardless of cell kind. Save
after an accepted AI or Command submission changes the history; whitespace,
rejected queued requests, unsubmitted drafts, and consecutive duplicates do not
trigger unnecessary writes.

The storage adapter accepts an injected storage object so unit tests do not
depend on a real browser implementation.

### Keep one navigation session across AI and Command cells

The existing editor key handler already consults the workspace-owned history
model for every editable cell. Generalizing the model and recording both request
kinds therefore makes `ArrowUp`/`ArrowDown` work across AI, Command, and newly
created cells without separate per-kind navigation state.

### Re-render before focusing the advanced cell

When run-and-advance selects the new trailing input, synchronize the notebook
views after `advanceAfterRun()` and before calling `focusActive()`. This makes
the target editor editable, clears its read-only state, and allows focus to
move there. Queue draining may continue to refresh output state, but it must not
move focus away from the new cell.

## Risks / Trade-offs

- **Sensitive AI prompts and command text remain in browser storage** -> Keep
  data local to the origin, never send it to the server, and document that
  clearing site data removes it.
- **Storage is unavailable or full** -> Catch storage errors and continue with
  in-memory history.
- **Two tabs edit the same workspace document concurrently** -> Treat storage
  writes as last-write-wins; the current product already treats open tabs as
  independent UI sessions.
- **Renaming a workspace changes its storage key** -> History remains under the
  old path and is not migrated by this change.

## Migration Plan

No server or document migration is required. When a workspace has command-only
history from the unreleased intermediate build, import it into the unified
history on first load. Rolling back to an older extension leaves the unified
browser value unused and does not affect the workspace document.
