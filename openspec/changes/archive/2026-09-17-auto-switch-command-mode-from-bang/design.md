## Context

See `proposal.md` for motivation and
`specs/cell-mode-switching/spec.md` for the behavioral contract.

The workspace currently exposes cell kind through a toolbar selector, a
double-click prompt toggle, and `AI`/`sh` badges. `WorkspaceCell.kind` also
drives queue capture and output rendering, while a run request uses one source
value for history, queuing, and execution. Removing user-facing mode selection
therefore requires separating the visible unified input from the internal
execution decision and normalizing legacy Command cells.

## Goals / Non-Goals

**Goals:**

- Make ordinary text use the AI instruction path and a leading `!` use the
  shell path without any user-selected cell type.
- Keep the marker visible and reversible.
- Execute the command without the marker while retaining the marked source in
  shared input history.
- Return run-and-advance to a new AI input after a prefix-controlled command.
- Remove the mode selector, prompt toggle, mode badges, and related public
  switching APIs.
- Normalize legacy Command cells without requiring a new `.agentnb` version.

**Non-Goals:**

- Adding Python kernel execution; notebook Python cells are only the UX
  analogy for a default execution path plus `!` shell escape.
- Supporting general shell syntax interpretation in AI mode.
- Changing queue ordering, history persistence, or output rendering behavior
  beyond the unified execution classification.

## Decisions

### Keep one visible input and classify execution at submission

The editor has no user-selectable AI/Command mode. Source edits update a
per-cell ephemeral shell-marker flag derived from whether the first
non-whitespace character is `!`; this flag only controls execution preparation
and does not alter toolbar or prompt presentation.

The submitted input remains the trimmed source including `!`. The execution
kind is `command` when the marker is active and `ai` otherwise. Removing the
marker clears the flag and therefore returns the next submission to the AI
path.

The cell model may retain an internal execution classification for queue
compatibility and output rendering, but it is not exposed as a user mode and
there is no public setter or toggle. The marker flag is reconstructed from
`source.trimStart().startsWith('!')` after restore.

Alternatives considered:

- **Remove `!` immediately when switching mode:** rejected because the user
  cannot delete the marker to return to AI mode and history would lose the
  visible input form.
- **Persist a new document field:** rejected because kind and source already
  contain enough information to reconstruct the behavior.
- **Keep the selector as an advanced option:** rejected because the request is
  to make one input sufficient and remove the AI/Command presentation.

### Separate submitted input from execution source

Extend run requests with an execution source in addition to the submitted
source. The submitted source remains the trimmed visible input, including `!`,
and is the value recorded in shared history. For a marker-controlled command,
the execution source removes the leading marker and surrounding whitespace
before it is sent to the shell. Ordinary AI input uses the submitted source for
both values.

For a marker-only input, execution source is empty, so the request is rejected
and no history entry is created. Queued requests retain the execution source
captured at submission time, matching existing queue semantics.

Alternatives considered:

- **Strip the marker in the session layer:** rejected because the session
  should receive the final shell input and must not know about editor notation.
- **Store the stripped command in history:** rejected because recalling it
  would no longer restore Command mode.

### Remove mode-selection UI and public switching behavior

Remove the toolbar cell-type selector, the prompt double-click handler, the
`AI`/`sh` prompt badge, and the public kind setter/toggle used only by that UI.
Cell insertion always creates the unified default input. Refresh the notebook
only when source classification changes affect queued or rendered output; avoid
overwriting the focused editor during history navigation.

The status bar SHALL no longer describe the current cell as `AI cell` or
`Command cell`; it may continue to show workspace and working-directory state
without a mode label.

### Return run-and-advance to AI input for marker-controlled commands

Trailing-input creation for run-and-advance always creates a unified default AI
input. If a subsequent cell already exists, advance selects it without changing
its source.

### Normalize legacy Command cells during document restoration

When a persisted Command cell is read, convert it in memory to the unified
input form: preserve its source, prepend `!` when the source does not already
begin with the first non-whitespace `!`, and use the default AI cell kind.
Subsequent saves write the normalized source. Already marked sources are not
changed, so restoring a workspace is idempotent.

This avoids a `.agentnb` version bump while preserving the execution behavior
of existing command cells. Rolling back to an older extension is best-effort:
the source remains readable, but an older build may treat a normalized
`!command` source as an AI instruction.

## Risks / Trade-offs

- **A shell command legitimately needs a leading `!` character** -> The leading
  `!` is reserved as the shell escape marker in the unified input; ordinary
  command cells without the marker are no longer available.
- **Legacy Command sources gain a visible marker on reopen** -> Normalize only
  when no marker exists and document the one-time visible source change.
- **Internal output classification still exists** -> Keep it private to queue
  and rendering behavior so no mode control or badge is exposed.
- **Source edits and history recall can take different UI paths** -> Derive
  shell classification in the shared source-change handler used by typing,
  paste, and history recall.
- **Older extension versions may not understand normalized `!command`
  sources** -> Preserve source text and state the best-effort rollback limit in
  the migration plan.

## Migration Plan

No document version bump, server migration, or storage migration is required.
Legacy Command cells are normalized in memory when read: a source without `!`
receives the marker, and an already marked source is unchanged. If the
normalized workspace changes, the next save writes the unified source. Rolling
back leaves source text readable but may change execution behavior for
normalized `!command` inputs.
