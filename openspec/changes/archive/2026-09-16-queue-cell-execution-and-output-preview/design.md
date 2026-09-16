## Context

See `proposal.md` for motivation. The current workspace uses one shared
`AgentSession` whose event payloads identify output type but not the originating
cell. `AgentWorkspaceContent.runCell` prevents a second request with
`WorkspaceNotebook.busy()`, and the server independently rejects overlapping
Command executions. Cell status currently has only `idle`, `running`, `done`,
and `interrupted`; execution counts are assigned before the request starts.

Output rendering already tracks a persisted `outputCollapsed` boolean, but its
true state hides the output body and attaches a JupyterLab `OutputPlaceholder`.
The replacement must keep the same persisted field while changing its visual
meaning, so existing `.agentnb` files remain compatible.

## Goals / Non-Goals

**Goals:**

- Serialize all runnable AI and Command requests through one workspace-level
  scheduler without changing the WebSocket protocol.
- Keep queue ownership and cancellation deterministic when cells are edited,
  deleted, or change kind.
- Make execution numbering and prompt state match notebook expectations.
- Keep compact output scrollable, stable during streaming, and persisted across
  reloads.
- Keep completion of background queued work from stealing selection, focus, or
  editor state from the user.

**Non-Goals:**

- Server-side queuing, cross-workspace scheduling, parallel kernels, or request
  cancellation by queue position.
- Reordering queued requests, showing a separate queue panel, or persisting the
  queue across document reloads.
- Changing Command shell semantics, AI SDK behavior, or the WebSocket message
  schema.
- Adding output paging, virtualization, search, or a user-configurable preview
  height UI.

## Decisions

### Serialize in the workspace before using the existing session

`AgentWorkspaceContent` will own an ordered list of run requests and a single
active request slot. A submission captures `{cellId, kind, source, advance}`
and is pushed to the tail. If no request is active, it is promoted immediately;
otherwise only the cell's presentation state changes to queued. A request is
sent to `AgentSession` only when promoted, so the session continues to see at
most one AI turn or Command execution at a time.

This is preferred over adding a backend queue because current server events have
no request identifier. Sending concurrent requests would require protocol
correlation to route streamed output correctly. Client-side serialization
preserves the protocol and also leaves the server's existing overlap guard as
defense in depth.

### Represent pending work explicitly in the notebook model

`CellStatus` will gain `queued`; queued cells retain prior output until their
request starts. The notebook model will expose operations to enqueue, promote,
and cancel requests so source snapshots and cancellation rules can be unit
tested without a browser or WebSocket.

Promotion, not submission, will clear prior output, allocate the next execution
count, and set status to running. The prompt renders `[*]` for both queued and
running statuses and shows a numeric count only after promotion. Deleting a cell
removes every queue entry for that cell, and changing a queued cell's kind
cancels its pending entries. Changing the kind of the active running cell will
be rejected so the active request cannot lose its output target.

This is preferred over assigning execution counts when the user presses Run,
because notebook queues show `[*]` until execution actually begins and the
count reflects true start order.

### Make queue completion and advance non-disruptive

Run-and-advance will move the selected cell immediately after a successful
enqueue. Request completion will update only its originating cell and then
promote the next queue entry; it will not reselect the completed cell, focus its
editor, or advance the notebook again. Run-and-stay leaves selection unchanged.

The scheduler will run its drain step from a single completion path for
Command promises and AI session events. A failure, nonzero Command result, or
interrupt releases the active slot in `finally`-equivalent control flow so one
bad request cannot stall the queue.

This is preferred over retaining the current completion-time selection
movement, which would steal focus as soon as a background cell finishes.

### Keep queue state ephemeral, but preserve visible output state

The queue itself will not be serialized. Normalization will map a persisted
`queued` status to `idle`; the existing `running` to `interrupted` behavior
remains. Prior output and `outputCollapsed` continue to round-trip normally.
Closing or disposing a workspace clears pending entries and rejects any active
Command wait through the existing session shutdown path.

This avoids surprising automatic execution after reload and requires no document
version bump.

### Change the meaning of `outputCollapsed` from hidden to compact

The output body will remain visible for a collapsed cell. CSS will apply a
bounded `max-height` and `overflow-y: auto` to the body when
`outputCollapsed` is true; expanded output keeps natural height and visible
overflow. The existing output collapser toggles the boolean, and the
`OutputPlaceholder` path is removed.

A theme-scoped CSS custom property will define the preview height with a stable
fallback. This keeps the behavior compatible with JupyterLab themes and allows
future adjustment without changing the document model. A persisted `true`
value from older documents automatically means "compact" after upgrade.

### Preserve compact scroll position across streaming renders

The output body will be scrollable and keyboard-focusable in compact state.
`CellView` will capture `scrollTop` before rerendering streamed output and
restore it afterward, while the expanded state remains at natural layout
height. Toggling states will preserve the current scroll offset where possible.

This is preferred over rebuilding the output DOM without scroll restoration,
which would jump users to the top every time another streamed chunk arrives.
Virtualized or incremental output rendering is deferred because the current
output contract is small and this change can remain localized.

## Risks / Trade-offs

- [The queue state can diverge from the visible cell if a queued cell is
  deleted or reclassified] → Centralize enqueue/cancel operations in the
  notebook model, cancel by stable cell id, and cover deletion, kind changes,
  and duplicate submissions in unit tests.
- [A completion handler can steal focus or advance the wrong cell] → Remove
  selection movement from the completion path and test advance behavior at
  submission time while another request is active.
- [AI events are global to the session and could update the wrong cell if two
  requests overlap] → Maintain one active slot and start the next request only
  after the previous AI turn reports completion, interruption, or error.
- [Refreshing a compact output resets user scroll] → Save and restore
  `scrollTop` around output rendering, with tests covering a streamed update
  while compact.
- [A bounded output body can hide newly streamed content below the viewport] →
  Keep the cell prompt visible as the running signal and preserve the user's
  chosen scroll position rather than forcing an auto-scroll behavior that
  competes with inspection.
- [Changing persisted `outputCollapsed` semantics could surprise users who
  expect full hiding] → Treat this as the requested behavior change; prompt and
  output stay visible, and the full result remains inspectable without an
  expand action.

## Migration Plan

This is a frontend behavior change with no data migration. Existing
`outputCollapsed` booleans restore as compact previews, and no saved queue is
created. Deploy the frontend and styles together, then verify both a saved
compact document and an in-progress workspace. Rollback consists of reverting
the frontend bundle and styles; documents remain readable because the persisted
schema and field names do not change.
