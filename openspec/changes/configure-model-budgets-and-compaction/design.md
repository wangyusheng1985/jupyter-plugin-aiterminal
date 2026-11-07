## Context

See `proposal.md` — Why for the user-facing problem. The constraints this design must respect:

- `schema/plugin.json` is `additionalProperties: false` with exactly `apiProtocol`, `baseUrl`, `model`, `token`; Jupyter settings are read as raw JSON by `jupyter_aiterminal/settings.py` (`parse`, ~line 126) and handed to `parse_dsh_provider_config`. The settings read path needs no change: new fields reach the parser unchanged.
- `jupyter_aiterminal/dsh_config.py` holds the fixed constants `DEFAULT_CONTEXT_WINDOW = 8192` and `DEFAULT_MAX_OUTPUT_TOKENS = 4096` (~49-50), defaults them in `parse_dsh_provider_config` (~183-184), validates only `max_output_tokens <= context_window`, and emits `contextWindow`/`maxTokens` into the provider insert patch (~248-249).
- `jupyter_aiterminal/dsh_acp_config.py` holds `ACP_MAX_OUTPUT_TOKENS_CAP = 4096` (~61) and applies `min(config.max_output_tokens, cap)` at `_provider_row` (~187) plus `defaultMaxTokens` in the ACP profile patch (~200-204). `retryPolicy.maxRetries = 0` is not an automatic recovery from a `max-tokens` stop.
- `jupyter_aiterminal/dsh_acp_events.py` (~141-166) reads ACP `stopReason` and collapses it into a `status` (`end_turn→completed`, `cancelled→cancelled`, everything else including `max_tokens`→`failed`); the terminal event carries only `{"status": ...}`.
- `jupyter_aiterminal/agent.py` (~511-525) emits a terminal `result` event with `text: ""` and `isError` only and reads only the projected `status`, so a `max-tokens` stop and a provider failure both reach the client as an empty body.
- `jupyter_aiterminal/dsh_runtime_host.py` (from the unarchived `shared-dsh-detached-sessions` change, present in the current working tree) keeps the first safely prepared transport as the server runtime (`bind_transport`) and serves every ACP session through it (`open_session`/`resume_session`). `DshAcpSession.start` creates a transport and verifies its profile patch only when `_supplied_transport is None`; an attached session reuses the supplied transport without re-rendering the patch or restarting the process. `build_acp_session_params` carries only `cwd`/`mcpServers`, and ACP exposes no session-level provider or compaction configuration. The effective budget and compaction configuration is therefore fixed when the runtime process starts, not when a session starts.
- `jupyter_aiterminal/dsh_acp_session.py` (~600-638) preflights the runtime with `--dump-config` and fails closed on patch warnings; `_row_block`/`_block_has_scalar` currently assert only the `approval` and `sandbox-policy` rows.
- `src/agent/workspace.ts` (~1050-1070) finalizes the turn as `done`.
- Read-only evidence from the local `/Users/wangyusheng/Documents/github/deepseek-harness` checkout:
  - `packages/bundle/base/cordis.patch.yml` (~351-355) enables `token-meter` and `compaction-basic`.
  - `compaction-basic/src/config.ts` defaults: `thresholdRatio` 0.8, `headroom` 65536, `retainRatio` 0.16, `auto` true, and `maxTokens` defaulting to `headroom` (~172-193): `messageBudget = C - O`, `pressure = C - O - H`, `threshold = floor(min(C * r, pressure))`, `retain = floor((C - O) * retainRatio)`; requires positive values and `retain < threshold`.
  - `compaction-basic/src/config.ts` (~230-241, called at top-level parse ~80) throws when `retainRatio >= thresholdRatio`; it is a load-time invariant, not a warn-and-continue path. Ratio bounds are `(0, 1]` (~358-362); `headroomTokens` accepts 0.
  - `compaction-basic/src/index.ts` (~157-174) warns and continues on an invalid configuration during pre-step.
  - `core/agent-loop/src/agent.ts` (~584) ends the turn on `max-tokens` without continuing; the ACP surface has no compaction-specific update, only `usage_update`.

Hard constraints for this change: reuse DSH's existing compaction (do not implement a second compactor, do not modify the external DSH repository), preserve shared-runtime multi-session and detached-turn semantics, never restart or kill the shared runtime or interrupt an active/detached turn, never start a second runtime, and treat the local DSH checkout as the formula reference only — the pinned remote runtime version is not yet verified. `contextWindow` stays declared metadata; no code may assert a real `deepseek-flash` capacity.

## Goals / Non-Goals

**Goals:**

- One authoritative budget model computed from settings, used by every layer that currently hardcodes or clamps a value.
- Cross-field validation that mirrors DSH's actual arithmetic and load-time invariants, so an accepted configuration is one DSH will not reject or warn-and-continue on.
- A single visible description of the desired budget/compaction configuration, the active shared-runtime snapshot, per-value provenance, and the `pending-next-runtime` boundary.
- Deterministic defaults derived from the configured budget, so no configuration inherits an unusable `8192` + `65536` pair or a `65536` summary budget.
- Honest reporting: `max-tokens`, provider failures, and cancellation become distinct visible reasons; unobservable compaction is labeled unobservable.

**Non-Goals:**

- No remote deployment, no runtime version bump, no claim that compaction events are observable before the pinned runtime is verified.
- No automatic continuation, auto-retry of a `max-tokens` stop, or request replay to extend an answer.
- No automatic restart, kill, or replacement of the shared runtime, and no second runtime process.
- No hot reconfiguration of a running shared runtime or live ACP sessions; a saved change stays `pending-next-runtime` until a later runtime start.
- No claim that raising the configured budget repairs truncation produced by a gateway or provider outside this plugin.
- No change to credential storage, Command-cell shell lifetime, detached-turn persistence, or workspace history bridging.
- No tokenizer-based real context measurement.

## Decisions

### 1. A single derived budget object is the only source of budget values

Introduce one immutable derived structure (a validated dataclass in `dsh_config.py`) holding: `context_window`, `max_output_tokens`, and the computed `message_budget`, `pressure`, `threshold`, `retain`, plus the compaction inputs (`auto`, `threshold_ratio`, `headroom`, `retain_ratio`, `summary_max_tokens`) and a per-field provenance record.

Both `build_provider_insert_patch` and `dsh_acp_config._provider_row` read from that structure. Neither recomputes, neither applies its own `min()`.

- Why: today three places independently pick a number (dataclass default, patch metadata, ACP clamp), which is exactly how a hidden `4096` cap appears.
- Alternative rejected: keeping `min(config, cap)` but reporting it. It still yields two arithmetic paths and keeps the cap's identity ambiguous.

### 2. Delete `ACP_MAX_OUTPUT_TOKENS_CAP`; this change adds no replacement cap

The cap is removed and the ACP patch uses the effective `max_output_tokens` directly. No other budget clamp exists in this change: there is no `applied_max_output_tokens` split, no second limit authority, and no narrower-cap code path. The value shown in the effective configuration is the value written to both the provider patch and the ACP profile.

- Why: a constant defined as "conservative, not measured" cannot distinguish a provider capability limit from an unexplained clamp, so raising it would just move the opaque number. The plugin has no measured capability limit to express, so none is modeled.
- Alternative rejected: environment-variable override of the cap. That adds a second configuration authority outside settings and outside the settings schema.

### 3. Defaults are derived from the configured context window, not copied from DSH

When the user supplies no compaction values, the system derives headroom and summary budget from the effective context window and maximum output tokens instead of adopting DSH's absolute `65536` headroom and `65536`-derived summary budget. Concretely: headroom as a fraction of the message budget small enough to keep `pressure > 0` (validated, not assumed), and summary budget capped by `max_output_tokens`.

- Why: DSH's absolute default is tuned for large windows; combined with the plugin's smaller declared windows it makes `pressure` non-positive, i.e. compaction can never trigger. DSH warns and continues, so the failure is silent.
- Alternative rejected: inheriting DSH defaults and only validating. Validation would then reject the plugin's own defaults, making the default configuration unusable.

### 4. Validation failures are configuration errors, evaluated before any connection

`parse_dsh_provider_config` (or a validation function it calls) rejects the whole configuration with an `AgentConfigError` naming the offending fields and computed values. Compaction values are validated with DSH's formulas and load-time invariants exactly:

```
message_budget = context_window - max_output_tokens
pressure       = message_budget - headroom
threshold      = floor(min(context_window * threshold_ratio, pressure))
retain         = floor(message_budget * retain_ratio)
valid          = context_window > 0 and max_output_tokens > 0
                 and 0 < threshold_ratio <= 1
                 and 0 < retain_ratio <= 1
                 and retain_ratio < threshold_ratio
                 and headroom >= 0
                 and pressure > 0
                 and retain < threshold
```

Every rejection is a distinct case with its own test, including `retain_ratio >= threshold_ratio` (which DSH throws on at load time, independently of whether `retain < threshold` happens to hold for the current budget), out-of-range ratios, negative headroom, non-positive budgets, and `retain >= threshold`.

Because `AgentConfigError` already flows into the `missing-llm-config-feedback` path, budget errors automatically surface in the cell output area without a new error channel — no model turn is attempted.

- Alternative rejected: relying on DSH's pre-step warning. It continues with a non-compacting session, which is the silent degradation this change exists to remove.

### 5. Compaction is configured by patching the existing DSH rows, verified by the dump-config preflight

Compaction settings travel as configuration for the already-enabled `token-meter`/`compaction-basic` rows via the ACP profile patch, using the existing row-patch mechanism in `dsh_acp_config.py` (patch existing ids only; never insert new plugin rows). When the compaction switch is off, the patch disables automatic compaction for the session. The existing `--dump-config` preflight is extended to assert that each patched row is present and carries the expected fields; a missing row or an unaccepted field name fails closed with an explicit error naming the row id. This guards the case where a patch is syntactically accepted but the runtime ignores it.

- Why: reuses DSH's implementation and the module's existing "patch known rows only" safety property, and reuses the existing fail-closed preflight as the proof that the configuration actually landed.
- Alternative rejected: a plugin-side compactor. Duplicates behavior, diverges from DSH's accounting, and mutates transcript state the plugin does not own.

### 6. Compaction observability is capability-gated

The ACP surface exposes `usage_update` but no compaction-specific update. The projector therefore derives a display state of `disabled`, `not observable`, or `observed`, and only the last requires a verified runtime capability for the pinned version. Default is `not observable` when compaction is enabled.

- Why: reporting a compaction event the protocol never sent would be fabricated telemetry. Verifying the pinned runtime version is an implementation-time task, not an assumption.
- Alternative rejected: inferring compaction from a sudden drop in reported prompt/usage tokens. That is a heuristic over unrelated numbers and would mislabel provider behavior as compaction.

### 7. The terminal reason flows from the ACP stop reason through the projector to the result and the client

The ACP `stopReason` travels unchanged in meaning through three seams:

1. `dsh_acp_events.py` reads `stopReason` and emits it as a terminal reason on `dsh/v1/run.finished`, keeping the existing `status` for compatibility while distinguishing `max_tokens` (budget exhausted), `cancelled`, `end_turn` (completed), and any other/unrecognized value (failed). It no longer collapses `max_tokens` into `failed`.
2. `agent.py` reads that terminal reason and puts it on the `result` event, preserving any assistant text already projected.
3. `src/agent/workspace.ts` renders the reason when a finished turn has no body, and persists it with the turn state so a reopened detached turn shows the same reason.

- Why: `isError: true` with `text: ""` is unactionable; `failed` alone hides a budget-limited stop. A carried reason is backward compatible with clients that only read `isError`.
- Alternative rejected: synthesizing assistant text describing the failure. It would contaminate the transcript and be indistinguishable from model output.

### 8. Application boundary is the next shared-runtime process start, and the snapshot is process-level

Budget and compaction values are resolved from settings when a shared runtime process starts. The runtime records that immutable snapshot as its **active configuration** together with a monotonically increasing **runtime generation**. Saving settings computes the new **desired configuration**; when it differs from the active snapshot, the UI marks it `pending-next-runtime`. The pending configuration becomes active only when a shared runtime process next starts normally (for example after a Jupyter server restart). New sessions created on an already-running shared runtime reuse the active snapshot and do not apply the pending one.

The first transport prepared for the shared runtime is the authoritative source of the active snapshot; reconnects and new sessions read from that recorded snapshot rather than re-reading settings. The existing first-session path initializes the transport inside `DshAcpSession.start()` before handing it to the host. The host therefore exposes `adopt_initialized_transport(transport, snapshot, preflight_proven)` to record that successful initialization and activate the first snapshot without issuing another `initialize` or starting another process. Repeated adoption is idempotent; a different transport cannot replace the authoritative one. An invalid snapshot must fail before partial binding. Generation is monotonic within a runtime-host lifetime, identified separately in reports. This change never restarts or kills the runtime, never interrupts active or detached turns, never hot-patches a live profile, and never starts a second runtime. A future administrator maintenance window may explicitly restart the Jupyter server to activate a pending configuration; that explicit restart is a documented operational step, not part of this change.

- Why: the shared runtime hosts multiple ACP sessions from one process and one patch, so a per-session or per-save application boundary cannot exist without restarting the process; restarting would invalidate in-flight and detached turns.
- Alternative rejected: propagating changes to live sessions or starting a second runtime for new settings. Neither is expressible safely over the current ACP surface and both break the concurrency guarantees the previous change established.
- Alternative rejected: re-reading settings for each new session. The session has no configuration surface; the value would be ignored while appearing applied.

### 9. Settings schema uses explicit optional fields

`schema/plugin.json` gains explicit numeric/boolean properties. Ratio fields use `exclusiveMinimum: 0` and `maximum: 1`. Headroom uses `minimum: 0`; the tighter `pressure > 0` constraint is enforced by the joint validator. Budget fields use positive-integer bounds with `maxOutputTokens <= contextWindow` enforced jointly. `additionalProperties: false` stays. Absent fields mean "derive/default", not zero.

- Why: explicit bounds keep rejection at the settings boundary, before the Python parser and before a session starts, while the cross-field constraints stay in the one joint validator that also knows DSH's formulas.

## Risks / Trade-offs

- [Removing the 4096 cap may let a provider reject a request that previously silently got a smaller budget] → the effective value is displayed before it is applied, and a provider rejection surfaces through the distinct failure reason; the plugin no longer claims a larger budget repairs gateway-side truncation.
- [DSH formula and load-time invariant drift between the local checkout and the pinned remote runtime] → all formulas and the `retainRatio < thresholdRatio` invariant live in one function with the DSH file/line reference in a definition comment; a tasks item verifies them against the pinned version before the observability claim is made.
- [Legacy settings may now error where they previously ran] → deliberate and specified; the error names both conflicting values, and derived-default migration is attempted first so untouched legacy files keep working.
- [A saved configuration stays pending because no runtime restart happens] → the UI states `pending-next-runtime` and names the explicit Jupyter restart as the activation step; the plugin never restarts the runtime automatically, so detached and active turns are never interrupted.
- [Compaction may remain unobservable on the pinned runtime] → reported as a capability limit; the honest state is the specified behavior, not a defect.
- [`contextWindow` is declared metadata and can be set wrongly high] → presentation states it is declared configuration, not a measurement; no capacity claim is derived from it.
- [Unarchived dependency on `shared-dsh-detached-sessions`] → this change builds on that change's current working-tree baseline (`dsh_runtime_host.py`, supplied-transport attachment) and re-specifies none of its detached-session semantics. Implementation starts from that baseline and is rebased on it if it lands first; the dependency is recorded in tasks so offline/detached continuity is preserved and not regressed.
- [The pinned remote runtime may accept `compaction-basic` configuration only through the bundle overlay applied at runtime start, not through per-session ACP profile patch rows] → task 1.2 records the evidence and task 4.3 extends the existing dump-config preflight to assert the patched rows actually landed; a missing row fails closed with an explicit row-named error rather than running unconfigured.

## Migration Plan

1. Settings schema adds the optional fields; existing files without them still parse.
2. Parser derives defaults; when the derived configuration fails DSH's formulas or invariants it attempts a derived valid replacement and reports it as `derived`, otherwise raises a configuration error naming the conflicting values.
3. Effective-configuration presentation shows the desired values, the active runtime snapshot, their differences and runtime generation, each value's provenance, and the `pending-next-runtime` state with the explicit Jupyter restart as the activation step.
4. Rollback: the fields are additive and the cap removal is localized to one budget derivation; reverting the commit restores the previous constants without a settings-format change, because no persisted document field is added.
