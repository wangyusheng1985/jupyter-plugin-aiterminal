## Context

See `proposal.md` for motivation and `specs/workspace-history-bridge/spec.md` for behavior. The current version 3 document stores one current `agentSessionId`, while Cells store source, outcome/Turn evidence, and execution state but no context membership. The disk-cleanup document demonstrated three distinct facts: visible Cells survived, the original SDK context did not, and background task IDs/output paths remained recoverable inside saved tool blocks.

The Agent SDK session remains the highest-fidelity continuity mechanism. A history bridge is a conservative fallback for visible document history that is not covered by that session; it must not be described as resume and must not cause historical side effects.

## Goals / Non-Goals

**Goals:**

- Prevent the first AI request from silently leaving visible history behind.
- Carry enough bounded context for referential follow-ups such as “结果如何了？” while preserving the current draft as the only actionable request.
- Make native, bridged, and outside-context history inspectable after reopen and reset.
- Recover last-known background-task references from existing document evidence without new provider calls or file reads.
- Preserve Command independence, fail-closed resume behavior, stable Cell IDs, and document audit fidelity.

**Non-Goals:**

- Reconstructing the provider's hidden reasoning, full token history, subagent registry, or process memory.
- Replaying old prompts or tools, automatically reading server-local task output, or asserting that a saved background process is still alive.
- Replacing SDK-native resume when a valid session is available.
- Bridging Command-only history or importing history from another document automatically.
- Solving administrative SDK transcript retention or portable cross-server session storage.

## Decisions

### Gate the pending draft with one focused context choice

AI submission first evaluates a pure context-coverage projection. If submitted AI Cells exist outside a valid current context and no policy has been chosen for this generation, the notebook does not enqueue the run. It stores a runtime-only pending intent containing stable Cell ID and advance behavior, opens the existing context disclosure near the fixed overview, and focuses **Continue from visible history**. The Cell remains idle and editable.

Activating either choice re-resolves the Cell by ID and verifies that it is still idle and its source is non-empty before continuing. If the Cell changed or was deleted, the pending intent is canceled. Escape closes the disclosure, clears the intent, and restores focus without a request. Choice controls disable synchronously while acceptance proceeds, preventing double submission.

Reusing the existing status/context disclosure was chosen over a modal because the consequence belongs to runtime-context state and the current UI already provides keyboard focus, Escape, narrow-mode, and reset behavior there. A passive warning was rejected because the reported failure occurred even though context text was technically present. Automatic bridging was rejected because it conflicts with an explicit Start new context decision and could send copied history without a deliberate choice.

### Version 4 records local context generations and bridge membership

The snapshot advances to version 4 with additive fields:

```text
root.agentContextGeneration: non-negative integer
root.agentContextBridges: [{ generation, cellIds[] }]
cell.agentContextGeneration: integer | null
```

The existing nullable `agentSessionId` remains the current generation's resume link for backward compatibility. A native AI Cell is assigned the current generation when its request is accepted. Starting a new or replacement context increments the generation, clears the current SDK linkage, and does not rewrite older Cells. A bridge record stores only stable Cell IDs selected for that generation; source and outcome remain in their original Cells.

Context membership relative to the active generation is derived as:

- `native`: Cell generation equals the active generation;
- `bridged`: Cell ID appears in the active generation's bridge record;
- `outside`: submitted AI Cell satisfies neither condition;
- `draft`: unsubmitted Cell, which has no membership cue.

Version 1 and 2 documents normalize all existing Cells to `null`, generation 0, and no bridges. Version 3 documents without a session do the same. A version 3 document with a saved session conservatively assigns only its newest successful AI Cell to generation 0; older Cells remain outside because the document cannot prove when that SDK context began. A version 4 document with no valid session link cannot claim current native or non-empty bridged coverage, so those current markers normalize to uncovered while prior generations and an explicit empty-context policy remain as audit evidence. Invalid generations, duplicate bridge records, unknown Cell IDs, and non-AI IDs normalize away.

Storing local generations was chosen over copying the opaque SDK UUID into every Cell: generation is stable across provider ID updates, does not multiply server-owned identifiers, and preserves prior boundaries after reset. A single root boundary was rejected because it cannot represent multiple explicit resets or bridged subsets.

### Build one deterministic structured capsule from saved domain state

A new pure history-bridge module receives Cells and the current draft ID. It selects at most the eight newest submitted AI Cells preceding the draft, then serializes them in chronological order. Each entry contains stable Cell ID, source, final status, a bounded canonical outcome, and task-reference IDs. A separate task-reference list contains source Cell ID, provider task ID, output path, and last saved state.

The capsule uses a versioned JSON-compatible structure rather than Markdown/XML delimiters. Global serialization is capped at 12,000 characters. Per-field truncation and newest-history selection happen before final serialization; if the cap is still exceeded, oldest entries are removed until valid. The capsule includes omitted-turn and truncated-field counts so the model and UI do not mistake it for complete history.

Canonical outcome comes from the saved Turn/result projection already used for display, excluding presentation-only revision/disclosure data. Raw tool inputs are never serialized. This keeps the projection deterministic and prevents destructive historical commands from becoming executable instructions.

Model-generated summarization was rejected because it adds latency, cost, nondeterminism, and another context mismatch. Sending the entire document was rejected because real workspaces exceed safe prompt sizes and contain extensive raw evidence.

### Derive a provider-bounded task ledger without reading files

The pure projection recognizes only strict supported patterns in persisted tool blocks:

- a background-start result with a valid task ID and absolute output path;
- a later TaskOutput-style block with the same task ID and an explicit running, completed, failed, killed, or unknown state.

References are deduplicated by task ID; later saved evidence wins. Each state is labeled last-known. The projection never stats, opens, tails, or trusts the path as current truth. Unsupported/malformed text yields no reference and leaves the raw block untouched.

This provider-bounded parser is intentionally narrow. A generic heuristic over arbitrary output was rejected because it could mistake untrusted tool text for task metadata. A new persistent task table was deferred because existing blocks already form the durable evidence source; the pure ledger can be replaced by structured provider events later without a document migration.

### Send bridge data separately and compose the model prompt on the server

The frontend user message gains one optional `historyBridge` object. The visible Cell and RunRequest retain the original source. The server validates the capsule version, item counts, string lengths, total serialized size, task IDs, and paths before passing anything to the SDK. Invalid bridge data produces a context error and no model request.

The server composes a prompt with three explicit regions:

1. a fixed notice that the bridge is quoted, incomplete, and must not trigger historical actions;
2. the validated JSON capsule;
3. the current user request identified as the latest actionable instruction.

The bridge is sent only with the first accepted AI request of the selected generation. SDK stale-client retry reuses the same composed prompt. The accepted event carries the server-owned session ID, allowing the frontend to persist session linkage, native membership, and bridge membership in the same update rather than waiting for the final result. The `.agentnb` persists bridge membership but not the capsule or composed prompt; the SDK's server-owned transcript naturally retains the received request for native resume.

Frontend-only concatenation was rejected because the backend would have no independent size/type enforcement. Storing the composed prompt in the Cell was rejected because it would pollute the audit record and expose implementation framing as user-authored source.

### Make context membership visible without expanding the compact rail

The fixed overview context label gains a concise covered-history count, for example `Context: Resumed · 5 bridged`, while the disclosure explains excluded history and the active generation. Navigator markers keep their compact line form and add non-color geometry/state plus accessible-name suffixes for bridged and outside Cells. Native Cells retain the normal marker treatment.

At the narrow breakpoint, the status bar continues to preserve connection, context, and execution truth; membership detail moves into the existing `Cell history` and context disclosures. Focus returns to the draft after cancel and to the newly running Cell after acceptance or pre-acceptance failure, unless run-and-advance already placed focus in the next draft. Any disclosure transition uses existing motion tokens and becomes immediate under reduced motion.

Permanent transcript labels beside every Cell were rejected because they would add noise to long workspaces. Color-only membership was rejected for accessibility and theme compatibility.

### Resume remains preferred and unavailable recovery stays explicit

When a saved session resumes, no bridge choice is shown for Cells already native or bridged in that generation. If resume fails, the pending request remains blocked and the stale ID remains visible for diagnosis. Only an explicit bridge or empty-context recovery increments the generation, clears the stale linkage, and continues the preserved draft.

Starting empty context records no bridged IDs. It does not delete historical bridge records or evidence, but membership UI is always relative to the new active generation. Command execution never consumes, dismisses, or resolves the AI choice.

## Risks / Trade-offs

**[Quoted history can still influence the model]** -> Require explicit user choice, omit raw tool inputs, label history read-only/incomplete, place the current request last, and cap the capsule strictly.

**[A conservative version 3 migration underclaims context]** -> Mark uncertain older Cells outside rather than falsely claiming coverage; preserve resume and let the user bridge visible history deliberately.

**[Provider output wording changes]** -> Keep task parsing strict and isolated with positive/negative fixtures; unsupported output remains inspectable raw evidence without a derived reference.

**[A 12,000-character bridge omits important older context]** -> Favor newest Turns, expose omission counts, show exact bridged membership, and keep excluded Cells navigable for manual retry or a later richer bridge workflow.

**[Choice gating adds one interaction to legacy workspaces]** -> Show it only when meaningful uncovered AI history exists, make continuity the focused primary action, preserve the draft, and remember the chosen generation after acceptance.

**[Bridge reaches the model but the result is lost]** -> Treat membership as established only after normal request acceptance/persistence, retain the source Cell and evidence on failure, and require explicit recovery if no resumable ID is confirmed.

**[Version 4 rollback loses membership UI]** -> Keep additive fields and the version 3 `agentSessionId`; older readers ignore boundary metadata while preserving Cells, sources, outcomes, and evidence.

## Migration Plan

1. Add version 4 normalization, context generations, bridge records, and migration fixtures for versions 1–3.
2. Add pure capsule and task-reference projections with strict caps, malformed-output coverage, and no-I/O tests.
3. Extend the WebSocket protocol and backend validation/composition without changing persisted Cell source.
4. Gate AI submission and add the focused bridge/empty choice, cancellation, duplicate prevention, and Command independence.
5. Add context-membership overview and compact navigator cues for wide, narrow, keyboard, theme, and reduced-motion states.
6. Run Python/frontend tests, typecheck, lint, production build, strict OpenSpec validation, and diff checks.
7. Back up and update the existing `10.9.34.84:8888` service, then validate a copy of the supplied disk-cleanup workspace: bridge it, ask “结果如何了？”, confirm the model receives task references without replaying commands, close/reopen, and verify durable membership.

Rollback restores the previous extension/backend and version 3 writer. Version 4 is additive, so rollback acceptance must verify that older code ignores the extra root/Cell fields and still restores every visible Cell and Turn.
