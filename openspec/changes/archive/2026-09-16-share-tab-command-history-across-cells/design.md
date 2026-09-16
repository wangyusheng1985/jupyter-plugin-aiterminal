## Context

`CommandHistory` is already owned by `AgentWorkspaceContent`, so every cell in
one workspace tab shares the same entries. The remaining restriction is in the
editor key guard and cell synchronization, which currently disables history
navigation unless the active cell kind is `command`.

## Goals / Non-Goals

**Goals:**

- Make tab history recallable from Command, AI, and new editable cells.
- Keep one history source per tab and preserve draft restoration.
- Keep normal multiline caret movement away from history boundaries.

**Non-Goals:**

- Recording AI prompts as command history.
- Sharing history across workspace tabs.
- Persisting history across reloads.

## Decisions

Remove the cell-kind condition from the history key guard. Keep the guards for
read-only inputs, modifiers, selections, and first/last-line caret boundaries
so multiline editing continues to work.

Do not move history into individual cells. The existing tab-level history model
already provides the required cross-cell behavior, and preserving that location
keeps the session-only lifecycle and document format unchanged.

## Risks / Trade-offs

- [Recall from an AI cell may replace its draft] -> Preserve the draft and
  restore it when navigating past the newest entry.
- [Multiline caret movement could regress] -> Retain first/last-line guards and
  cover them with focused key and DOM tests.
