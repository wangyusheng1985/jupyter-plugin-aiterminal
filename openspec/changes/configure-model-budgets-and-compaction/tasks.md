## 1. Verify the runtime capability baseline

- [x] 1.1 Confirm the pinned DSH runtime version and record it in the change notes; verify the local reference formulas (`messageBudget = C - O`, `pressure = C - O - H`, `threshold = floor(min(C * r, pressure))`, `retain = floor((C - O) * retainRatio)`, `retain < threshold`, `retainRatio < thresholdRatio`, ratios in `(0, 1]`, `headroom >= 0`) still match that version, and note the result next to the budget derivation function as a definition comment
- [x] 1.2 Confirm and record that the ACP surface has no session-level provider or compaction configuration (`build_acp_session_params` carries only `cwd`/`mcpServers`) and that the effective configuration is fixed when the shared runtime process starts, so compaction values travel only through the runtime profile patch rows; record the evidence the effective-configuration report relies on
- [x] 1.3 Confirm the ACP surface exposes no compaction-specific status update (only `usage_update`); record the evidence so the observability default in task 6.4 is justified
- [x] 1.4 Confirm the existing `--dump-config` preflight fails closed on a missing patch row (`patch: entry "<id>" not found`) and record the `token-meter`/`compaction-basic` row ids plus the exact field names the pinned runtime accepts, so the task 4.4 assertions cover real fields

## 2. Settings schema and parsing

- [x] 2.1 Add optional `contextWindow`, `maxOutputTokens`, `compactionEnabled`, `compactionThresholdRatio`, `compactionHeadroom`, `compactionRetainRatio`, and `compactionSummaryMaxTokens` to `schema/plugin.json`; budget fields use positive-integer bounds, ratio fields use `exclusiveMinimum: 0` and `maximum: 1`, and `compactionHeadroom` uses `minimum: 0`; keep `additionalProperties: false`; verify with a schema test that an unknown key is rejected, an absent field is accepted, and a `0` ratio is rejected
- [x] 2.2 Extend `parse_dsh_provider_config` in `jupyter_aiterminal/dsh_config.py` to read the new fields, apply documented defaults when absent, and record per-field provenance (user-provided / default / derived / inherited); verify each provenance branch is asserted in a parser test
- [x] 2.3 Remove the fixed `DEFAULT_MAX_OUTPUT_TOKENS`/`DEFAULT_CONTEXT_WINDOW` hardcoding as the sole authority: derive the effective budget from settings with the documented fallbacks, and verify (a) an empty optional-field settings file parses to the documented defaults and (b) explicit values win over defaults
- [x] 2.4 Verify `jupyter_aiterminal/settings.py` needs no change: the raw settings object is already handed to `parse_dsh_provider_config`, so the new fields flow through; record the verification instead of editing the read path

## 3. Joint budget and compaction validation

- [x] 3.1 Implement one derivation function that computes `message_budget`, `pressure`, `threshold`, `retain` from the effective context window, maximum output tokens, and compaction inputs, returning both values and per-field provenance; verify the exact arithmetic (including `floor`) in a table-driven unit test
- [x] 3.2 Reject configurations that fail the runtime's preconditions and load-time invariants — non-positive context window or maximum output tokens, `threshold_ratio` or `retain_ratio` outside `(0, 1]`, `retain_ratio >= threshold_ratio`, negative headroom, `headroom >= message_budget`, and `retain >= threshold` — with an `AgentConfigError` naming the offending fields and computed values; verify each rejection case has its own test, including a case where `retain < threshold` holds but `retain_ratio >= threshold_ratio` is still rejected
- [x] 3.3 Derive default headroom and summary output budget from the effective budget instead of adopting the runtime's absolute headroom or a summary budget larger than the maximum output tokens; verify (a) a small context window still yields `pressure > 0` and `retain < threshold`, and (b) the derived summary budget never exceeds `maxOutputTokens`
- [x] 3.4 Add explicit legacy handling: a settings file without the new fields keeps loading; a legacy combination that cannot compact attempts a derived valid replacement reported as `derived`, otherwise raises an actionable error naming the conflicting pair; verify the "never silently reports an invalid combination as healthy" case with a test

## 4. Patch generation and dump-config preflight

- [x] 4.1 Remove `ACP_MAX_OUTPUT_TOKENS_CAP` and the `min(...)` clamp in `jupyter_aiterminal/dsh_acp_config.py::_provider_row`; make the ACP profile patch and `defaultMaxTokens` use the effective maximum output tokens; verify with a test that a configured budget above 4096 reaches the patch unchanged and that no replacement clamp exists
- [x] 4.2 Make `build_provider_insert_patch` in `jupyter_aiterminal/dsh_config.py` emit only values from the derived budget object; verify both patch builders produce identical `contextWindow`/`maxTokens` for the same configuration in one shared assertion
- [x] 4.3 Extend the ACP profile patches to carry compaction configuration for the already-enabled `token-meter`/`compaction-basic` rows using the existing patch-known-rows mechanism (patch existing ids only, never insert), and disable automatic compaction when the switch is off; verify the generated patch in a test and confirm no new row id is introduced
- [x] 4.4 Extend the `--dump-config` preflight in `jupyter_aiterminal/dsh_acp_session.py` to assert that the patched `token-meter`/`compaction-basic` rows are present and carry the expected fields from task 1.4; verify a test where the dumped config omits the row or an expected field makes startup fail closed with an explicit error naming the row id
- [x] 4.5 Ensure the effective-configuration report claims compaction is applied only when the preflight in task 4.4 proved the rows landed; verify the report path and the fail-closed error stay consistent for the same configuration

## 5. Terminal reason reporting

- [x] 5.1 In `jupyter_aiterminal/dsh_acp_events.py`, carry the ACP `stopReason` on the terminal `dsh/v1/run.finished` event as a distinct reason instead of collapsing it into `status`, mapping `max_tokens` to budget exhausted, `cancelled` to cancelled, `end_turn` to completed, and any other value to failed; verify with independent tests asserting `max_tokens`, `failed`, and `cancelled` each produce their own reason
- [x] 5.2 Put that terminal reason on the `result` event in `jupyter_aiterminal/agent.py` (budget exhausted / provider failure / cancelled / completed), preserving any assistant text; verify an empty-body `max-tokens` turn reports the budget-exhausted reason in a server test
- [x] 5.3 Render and persist the terminal reason in `src/agent/workspace.ts` when a finished turn has no body, instead of showing an empty successful `done`, so a reopened detached turn shows the same reason; verify with a presentation test for the empty-body success case, the failure case, and the reopened case
- [x] 5.4 Confirm no automatic continuation, provider retry, or request replay is introduced for a budget-exhausted turn; verify by asserting the retry/continuation path is not entered in the existing turn tests

## 6. Effective configuration, runtime snapshot, and compaction status UI

- [x] 6.1 Present the effective context window, effective maximum output tokens, each value's provenance (user / default / derived / inherited), and the computed compaction values; verify with a presentation test covering a user-provided, a derived, and a defaulted configuration
- [x] 6.2 State in that presentation that the context window is declared configuration metadata, not a measured model capacity, and that a larger budget does not repair gateway/provider-side truncation; verify the wording is asserted in the same presentation test
- [x] 6.3 Record the active configuration snapshot and a runtime generation at shared-runtime start in `jupyter_aiterminal/dsh_runtime_host.py`, keeping the first transport's snapshot authoritative; adopt the first transport already initialized by `DshAcpSession.start()` through an idempotent `adopt_initialized_transport` interface without issuing a second `initialize`, and verify invalid snapshots cannot cause partial binding or replace the first transport; show the desired configuration, the active snapshot, their differences, and the generation, and mark a differing desired configuration `pending-next-runtime`; verify with a test that saving settings while a runtime is active leaves the active snapshot and generation unchanged, and that a new session or reconnect uses the active snapshot rather than the pending settings
- [x] 6.4 State that a `pending-next-runtime` configuration applies only when a shared runtime process next starts normally (for example an explicit Jupyter server restart), that the plugin never restarts or kills the runtime or interrupts active/detached turns, and that a new session on the running runtime does not activate the pending configuration; verify the wording and the "no restart issued" behavior in a test
- [x] 6.5 Report compaction state as `disabled`, `not observable`, or `observed`, defaulting to `not observable` when enabled unless the verified runtime capability from task 1.3 supplies evidence; verify that no compaction event is emitted when the runtime provides none
- [x] 6.6 Keep the compaction presentation distinct from Start new context, resume failure, and pending-next-runtime so none of the states is used to explain another; verify with a workspace-context-continuity test

## 7. Regression and preservation checks

- [x] 7.1 Verify shared-runtime behavior is unchanged: multiple ACP sessions, parallel prompts, per-session cancel, detached-turn persistence, and reopen all still pass their existing tests
- [x] 7.2 Verify the saved workspace session link is unchanged across a compacted turn and that compaction is never treated as a reset (test at the workspace-context-continuity seam)
- [x] 7.3 Verify missing or incomplete LLM settings still produce the existing configuration error and that budget/compaction errors, including the dump-config row preflight error, reuse the same in-cell error surface without echoing the token
- [x] 7.4 Confirm the implementation starts from the unarchived `shared-dsh-detached-sessions` current working-tree baseline and preserves its offline/detached continuity semantics; record the baseline commit/working-tree state and the rebase order if that change lands first
- [x] 7.5 Run the full Python and TypeScript test suites plus `openspec validate configure-model-budgets-and-compaction --strict`, and record the results

## 8. Deferred: authorized deployment verification

- [ ] 8.1 After a separately authorized deployment, verify against the remote runtime version that the active budget and compaction values take effect when the shared runtime next starts and record the observed behavior; do not claim compaction observability from this verification unless the runtime actually reports it
- [x] 8.2 Record the administrator maintenance procedure for activating a `pending-next-runtime` configuration by explicitly restarting the Jupyter server; confirm the plugin performs no automatic restart or runtime replacement as part of this procedure
