## Context

See `proposal.md` for motivation and `specs/workspace-save-reliability/spec.md` for behavior. `AgentWorkspaceContent.persistSoon()` currently debounces for 400 ms, while `persistNow()` synchronously replaces the Jupyter document model and starts `context.save()` without tracking or awaiting it. Rejections are console-only, overlapping calls are not coordinated explicitly, and `shutdownOnce()` starts persistence but does not drain it before closing the Agent session.

The Jupyter document context remains the authority for file persistence. The workspace must retain its existing versioned serializer, `context.model.fromString()` integration, autosave compatibility, and non-blocking execution behavior.

## Goals / Non-Goals

**Goals:**

- Make persistence ordering deterministic and testable under rapid edits, streaming updates, failure, retry, and disposal.
- Keep the latest complete serialized workspace revision until it is confirmed saved.
- Surface compact, accurate, accessible save truth without displacing connection or execution truth.
- Preserve one asynchronous shutdown path for both persistence drain and Agent disconnect.

**Non-Goals:**

- Replacing Jupyter's document model, contents API, conflict handling, or server-side file storage.
- Adding local browser backups, offline synchronization, multi-user merge resolution, or automatic infinite retry.
- Persisting save-state metadata or raw server errors into `.agentnb`.
- Blocking editing, AI execution, or Command execution while a save is pending or failed.

## Decisions

### Introduce a revision-based single-flight save coordinator

A small frontend coordinator owns monotonically increasing requested and saved revisions, one debounce handle, one in-flight drain promise, and a state union such as `saved | pending | saving | error`. The workspace supplies two callbacks: serialize/synchronize the latest model and invoke `context.save()`.

Every meaningful workspace mutation marks a new revision. Debounced work calls `flush()`. A drain snapshots the newest requested revision, synchronizes the complete current document model, and awaits one save. If a newer revision arrived during that await, the same drain loops once more with the latest state; callers share the same promise and cannot create a parallel write.

Revision tracking was chosen over comparing only model text after a save because the Jupyter model can already contain newer text while an older `context.save()` promise is unresolved. A queue of every intermediate snapshot was rejected because only the newest complete workspace state is required and streaming could create excessive writes.

### Treat failed revisions as dirty until a later save succeeds

On rejection, the coordinator records a bounded runtime error, enters `error`, preserves `requestedRevision > savedRevision`, and ends the current drain. Retry invokes the same drain against the latest serializer output. A later mutation transitions to pending and may use the normal debounce to recover. No unbounded automatic retry loop is introduced.

The coordinator only marks `savedRevision` after `context.save()` resolves for the target revision and no newer revision remains. An older save resolving cannot overwrite the visible state to Saved while a newer revision is pending.

### Separate model synchronization from durable confirmation

Before each save attempt, the workspace serializes the notebook and calls `context.model.fromString()` only when the model differs. This keeps Jupyter dirty-state and external model observers current. The save coordinator nevertheless remains pending/saving until `context.save()` confirms durability.

An unchanged serialized model can skip `fromString()`, but it does not skip a required retry when the same revision previously failed. Save-state fields never enter the serializer, so document version 4 remains unchanged.

### Add one stable save-status group to the existing bottom bar

The status bar gains a fixed semantic group containing an atomic polite text status and a Retry save button shown only for failure. Labels are concise: `Saved`, `Saving…`, and `Not saved`; the retry control has a full accessible name and disables synchronously while retrying.

Save feedback does not reuse the execution message because Agent/Command progress and persistence can change independently. It does not use a transient toast because an unresolved durability failure must remain visible. Theme tokens, stable minimum width, wrapping at narrow container sizes, non-color error cues, and no focus movement follow the existing workspace visual system.

### Feed save state through the coarse workspace UI projection

`WorkspaceUiState` gains save phase, label, and retry availability so toolbar/status tests can assert a single source of truth. Save changes notify the same UI listeners but do not rerender Cell output or rebuild navigator entries. The status component updates only its keyed coarse state.

This avoids routing save status through Cell state, which would create unrelated output rerenders during streaming.

### Drain persistence before Agent disconnect in shutdownOnce

`shutdownOnce()` awaits `saveCoordinator.flush()` and then closes the Agent session in `finally`, preserving the existing `ShutdownCoordinator` idempotency. `dispose()` still initiates the asynchronous shutdown without blocking Lumino disposal, but the coordinator holds the document context reference needed to finish the already-started drain.

If shutdown persistence fails, the error state/log path records it and Agent disconnect still runs. A browser or process crash cannot be made lossless by an asynchronous API and remains outside this change.

### Keep external model changes distinct from local dirty revisions

`applyModel()` restores externally supplied document text under the existing `applyingModel` guard and resets the save coordinator to Saved for that authoritative model only when no local drain is active. Model callbacks caused by the workspace's own `fromString()` remain suppressed. Tests cover external reload while idle and avoid claiming conflict resolution for simultaneous collaborative edits.

## Risks / Trade-offs

**[Jupyter may already serialize saves internally]** → Keep one explicit coordinator at the workspace boundary and test that it never overlaps or drops the newest revision; do not depend on undocumented internal queuing.

**[Streaming produces many local revisions]** → Preserve the existing debounce and coalesce all in-flight changes into the newest follow-up snapshot.

**[Persistent Saved text increases status density]** → Use a compact stable-width group, retain connection/execution priority, and validate narrow container reflow instead of hiding save truth.

**[Retry can repeatedly fail]** → Keep failure persistent, disable duplicate activation during attempts, and avoid automatic infinite loops.

**[Disposal cannot synchronously block browser/tab destruction]** → Start flush immediately, await it in the existing asynchronous shutdown promise, and state this lifecycle limit explicitly rather than implying crash-proof storage.

**[External model changes race local dirty work]** → Preserve current guards and scope this change to deterministic local saves; collaborative merge/conflict UX remains a non-goal.

## Migration Plan

1. Add and unit-test the pure revision/save coordinator with deferred promises and deterministic timers.
2. Integrate mutation marking, model synchronization, retry, and shutdown drain into the workspace.
3. Extend coarse UI state and the status bar with accessible save feedback and narrow-layout styling.
4. Run the full frontend/Python/type/lint/build/OpenSpec gates and confirm serialized fixtures remain byte-equivalent for equivalent notebook state.
5. Back up and update only the existing `10.9.34.84:8888` installation, restart its current service, and validate asset hashes, extension health, and a deployed save-success flow.

Rollback restores the previous frontend labextension. The `.agentnb` schema is unchanged, so documents saved by either version remain mutually readable.
