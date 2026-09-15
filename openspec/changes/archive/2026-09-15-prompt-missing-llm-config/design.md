## Context

See `proposal.md` for motivation. The server validates `Base URL`, `Model`, and `API Token` in `jupyter_aiterminal/settings.py`; `AgentSession.start()` emits an error event with `code: "config"` before constructing or connecting the Claude SDK client. The frontend protocol already preserves error events as transcript blocks, and `AgentWorkspaceContent.onSessionChange()` copies those blocks into the running AI cell and ends it as interrupted.

The existing error text points to Settings, but the user experience should make the first-run path unmistakable and keep configuration failures distinguishable from runtime/model failures. Command execution is handled by the same WebSocket but uses the local shell event path and must remain independent.

## Goals / Non-Goals

**Goals:**

- Present a clear, actionable configuration message in the AI cell output when the server reports a `config` error.
- Preserve the typed `config` error classification and avoid exposing credential values.
- Make the retry path work with the documented new-WebSocket/session requirement after settings change.
- Keep Command cells functional and free of LLM-specific guidance.

**Non-Goals:**

- Adding a new settings editor, inline credential form, or automatic navigation into JupyterLab Settings.
- Validating credentials or network reachability in the browser.
- Changing the required setting names, server-side environment mapping, or Agent SDK behavior.
- Showing a prompt for ordinary runtime, denied-command, or model-response errors.

## Decisions

### Reuse the existing typed configuration error event

Keep `code: "config"` as the source of truth and improve its presentation in the frontend. The server already short-circuits before SDK construction, and the event is available both for a missing settings file and incomplete/invalid values. A new protocol event or client-side filesystem probe would duplicate validation and could diverge from the server's actual configuration.

### Render configuration guidance as a dedicated actionable error block

When a `config` error reaches the current AI cell, render it as a visually distinct error block (or equivalent existing error presentation) that includes the Settings path and required field names. Keep the original server message available for diagnostics, but normalize or append stable guidance so all config-error variants provide the same next step.

This is preferred over relying only on the bottom status bar: the output block stays attached to the failed cell and remains visible when the user moves focus. The status bar may mirror a short summary, but it is not the sole channel.

### Scope feedback to AI runs

The frontend will associate configuration guidance with AI transcript/error blocks, while Command output remains governed by shell events. This avoids suggesting LLM setup for a feature that does not require it and preserves the existing mixed-cell contract.

### Treat the prompt as transient run feedback

The message is represented by the existing error block/session state and is not added to settings, command output, or a new persisted schema field. On a new session with valid settings, a successful or ordinary runtime result replaces the current run state; no special migration or cleanup marker is required.

## Risks / Trade-offs

- [A server error message may vary by missing-file, malformed-JSON, or missing-key case] → Match the typed `config` code and provide stable frontend guidance naming Settings → AI Terminal and the three required fields.
- [Users may change settings while the current WebSocket remains connected] → Keep the documented “open a new AI Terminal session/WebSocket” retry requirement visible in the guidance.
- [Persisting the failed cell could preserve an old configuration error block] → Treat the block as normal run history but ensure a subsequent run replaces the cell's active blocks and does not append stale guidance to the new attempt.
- [Overly specific wording may be difficult to translate] → Reuse existing translation/message conventions and keep the guidance short, field-oriented, and secret-free.

## Migration Plan

No data migration is required. Deploy the frontend/server message presentation with the existing `config` event contract. Existing `.agentnb` files and settings remain compatible. Rollback is a code-only revert of the presentation and tests.
