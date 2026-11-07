## Why

AI Terminal exposes only `apiProtocol`/`baseUrl`/`model`/`token`, so context window, output budget, and DSH compaction behavior are invisible fixed values: `DEFAULT_CONTEXT_WINDOW = 8192`, `DEFAULT_MAX_OUTPUT_TOKENS = 4096`, and an ACP overlay with a hardcoded `ACP_MAX_OUTPUT_TOKENS_CAP = 4096`. Users cannot choose a larger output budget, cannot see why a turn stopped at `max-tokens`, and cannot tune compaction even though DSH already implements it; truncation and an empty `done` body look like a successful turn. Removing the plugin's own ceiling is necessary for the budget to be configurable and diagnosable, but it does **not** repair truncation caused by a gateway or provider outside this plugin — this change makes the plugin's budget explicit and makes a budget-limited stop identifiable, not gateway truncation fixable.

## What Changes

- Expose advanced AI Terminal settings for the provider's effective budget: context window, maximum output tokens, plus compaction controls (enable switch, threshold ratio, headroom tokens, retain ratio, summary output-token budget).
- Thread those settings through every layer that currently hardcodes values: Jupyter settings JSON schema, the settings/parse path, the provider snapshot, the generated provider patch, and the ACP profile patch.
- Remove the hidden `4096` output cap so the effective `maxTokens` equals the configured or derived budget. This change introduces no second, narrower budget cap: the displayed value is the value written to the provider row and the ACP profile.
- Jointly validate the derived budget against DSH's actual compaction formulas: `messageBudget = contextWindow - maxOutputTokens`, `pressure = contextWindow - maxOutputTokens - headroom`, `threshold = floor(min(contextWindow * thresholdRatio, pressure))`, `retain = floor((contextWindow - maxOutputTokens) * retainRatio)`. Reject every combination DSH would reject or would warn about and continue with, including `retainRatio >= thresholdRatio` (DSH throws at load time), ratios outside `(0, 1]`, negative headroom, non-positive budgets, and `retain >= threshold`.
- Derive safe defaults for headroom and summary-output budget from the configured budget so a new configuration never inherits the unusable `8192` context plus `65536` headroom pairing and never inherits a `65536` summary-output budget from DSH's base profile.
- Treat the configuration as a **shared-runtime process-level snapshot**. Saving settings records the new desired configuration and marks it `pending-next-runtime`; it takes effect only when a shared runtime process next starts normally, and it does not affect new sessions created on an already-running shared runtime. This change never restarts or kills the runtime, never interrupts active or detached turns, never hot-reconfigures a live session, and never starts a second runtime. A later administrator maintenance window may explicitly restart the Jupyter server to activate a pending configuration; that restart is out of scope for this change.
- Make the desired configuration, the active snapshot, their differences, and the runtime generation observable in the UI. The first transport prepared for a shared runtime is the authoritative active snapshot; reconnects and new sessions continue to use it.
- Surface `max-tokens` termination and provider failure reasons: carry ACP `stopReason` through the projector (`dsh_acp_events.py`) into the `agent.py` turn result and the frontend/persisted turn state so a turn never ends as a `done` with no body and no explanation.
- Keep the existing shared-runtime behavior intact: multiple ACP sessions, detached/persisted turns, and workspace history bridging are unchanged. Remote deployment and the pinned remote runtime version are verified only during authorized implementation.
- **BREAKING**: an existing settings file carrying an invalid or now-rejected combination (for example `8192` context with a `65536` headroom, `maxOutputTokens > contextWindow`, or `retainRatio >= thresholdRatio`) becomes a reported configuration error until the values are corrected or migrated; the plugin no longer silently degrades such a configuration.

## Capabilities

### New Capabilities

- `model-budget-configuration`: Settings, parsing, provider/ACP patch generation, and effective-configuration reporting for context window, maximum output tokens, and the derived budget constraints they impose. Reporting distinguishes the desired settings from the active shared-runtime snapshot and its generation.
- `session-compaction`: Configuring DSH's existing compaction (switch, threshold, headroom, retain ratio, summary output budget), validating it with DSH's real formulas, applying it when the shared runtime next starts, and reporting compaction state honestly given ACP capability limits.

### Modified Capabilities

- `missing-llm-config-feedback`: budget and compaction configuration errors, including patch-row preflight failures, join the existing configuration-error classification and are reported in the cell output area with actionable guidance, including effective-configuration provenance.
- `workspace-context-continuity`: compaction performed inside the live ACP session must preserve session identity and the saved session link, and must not be presented as or silently become a fresh context.

## Impact

- `schema/plugin.json` — new advanced fields; `additionalProperties: false` stays, so unbounded keys are still rejected.
- `jupyter_aiterminal/settings.py` — verified no change needed: it passes the raw settings object to `parse_dsh_provider_config`, so the new fields flow through the existing read path.
- `jupyter_aiterminal/dsh_config.py` — defaults, `parse_dsh_provider_config`, derived budget/validation, snapshot validation, `build_provider_insert_patch` metadata.
- `jupyter_aiterminal/dsh_acp_config.py` — remove `ACP_MAX_OUTPUT_TOKENS_CAP`, provider-row and ACP profile patch generation including compaction rows.
- `jupyter_aiterminal/dsh_acp_events.py` — carry ACP `stopReason` on the terminal projected event instead of collapsing `max_tokens` into `failed`.
- `jupyter_aiterminal/agent.py` — turn result/error reporting for `max-tokens` and failure reasons, and the desired/active snapshot state.
- `jupyter_aiterminal/dsh_runtime_host.py` — record the active configuration snapshot and its generation at shared-runtime start; keep the first transport authoritative.
- `src/agent/workspace.ts` — terminal `done` rendering, effective-configuration/compaction status presentation, and pending-next-runtime state.
- Tests: Python config/ACP/patch-preflight tests, projector tests (independent `max_tokens`/`failed`/`cancelled` assertions), and TypeScript presentation tests, all source-named.
- Read-only evidence from the local `deepseek-harness` checkout (`packages/bundle/base/cordis.patch.yml`, `compaction-basic/src/config.ts`, `src/index.ts`, `core/agent-loop/src/agent.ts`) establishes DSH's formulas; the pinned remote runtime version MUST be verified before implementation claims compaction events are observable. The external `deepseek-harness` repository is not modified.
- Dependency: the shared-runtime behavior this change builds on is delivered by the unarchived `shared-dsh-detached-sessions` change and is present in the current working tree. Implementation MUST start from that working-tree baseline, keep the detached/offline continuity semantics it establishes, and be rebased after it if that change lands first.
- `contextWindow` remains declared metadata, not a measurement of any model's real capacity; `deepseek-flash` real capacity is not asserted by this change.
