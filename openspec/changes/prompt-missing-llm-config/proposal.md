## Why

When an AI cell is run before Base URL, Model, and API Token are configured, the server already detects the missing configuration but the user does not get a clear, first-use-oriented path to Settings. The resulting failed run should explain what is missing and how to continue instead of looking like an unexplained execution failure.

## What Changes

- Detect and present missing or incomplete LLM configuration as an actionable first-run message in the AI cell output area.
- Tell the user to open **Settings → AI Terminal** and identify the required Base URL, Model, and API Token fields.
- Keep the failed run visibly distinct from a normal model/runtime error and avoid sending the request to the Agent SDK when configuration is unavailable.
- Ensure the prompt is refreshed or cleared after configuration is corrected and a new AI Terminal WebSocket/session is opened.
- Do not block Command cells, which use the local shell and do not require LLM configuration.

## Capabilities

### New Capabilities

- `missing-llm-config-feedback`: Provides actionable UI feedback when an AI cell is run without complete LLM settings.

### Modified Capabilities

None.

## Impact

- Frontend session/error handling and AI cell output/status rendering in `src/agent/session.ts` and `src/agent/workspace.ts`.
- Existing server-side configuration validation and `config` error event contract in `jupyter_aiterminal/settings.py` and `jupyter_aiterminal/agent.py` may be reused or clarified, without changing required setting names.
- Frontend tests for first-run configuration errors, retry/session refresh, and Command cell isolation.
- No new dependencies, persistence schema changes, or changes to Command cell execution.
