# BTW runtime: tool-free evidence

BTW side chats run on a **dedicated** DSH process that is not the main agent
runtime. The boundary is configuration, verified at startup, not a prompt.

## Profile overlay

`jupyter_aiterminal/btw_config.py` patches the shipped `acp` profile by row id:

- provider, default model, ACP model, and `compaction-basic` rows are reused
  verbatim from the main overlay, so the declared context window and compaction
  budget have exactly one arithmetic authority (`DerivedBudget`);
- `approval.policy` is `never` and `sandbox-policy.mode` is `read-only`. These
  are posture settings, not a deny path: `never` means the host is never asked
  for approval, so a leaked tool call would run under the read-only sandbox
  without any prompt. The actual barrier is that the model request carries no
  `tools` field at all (see the loopback evidence below);
- every row that can register a model-facing tool is `disabled: true`:

  `tool-fs`, `tool-fs-search`, `tool-bash`, `tool-pwsh`, `tool-jobs`,
  `tool-web`, `web`, `web-search-deepseek`, `web-deepseek-api`,
  `web-fetch-http`, `tool-skill`, `skill`, `skill-filesystem`, `commands`,
  `command-feedback`, `command-compact`, `command-goal`, `tool-todo`,
  `tool-working-directory`, `working-directory`, `tool-goal`, `goal`,
  `goal-round-driver`, `plan-mode`, `tool-subagent`,
  `tool-subagent-fork`, `tool-subagent-control`, `tool-subagent-list-agents`,
  `subagent`, `subagent-spawn-in-process`, `subagent-fork-in-process`,
  `tool-workflow`, `workflow-ptc`, `mcp-resources`, `user-questions`,
  `attachment-local`, `agent-instructions`, `repeat-tool-reminder`,
  `tool-result-pruner`, `image-offload`, `session-title`, `session-title-llm`.

`session/new` is still built by the fixed params builder, which rejects
client-supplied MCP servers.

## Startup verification (fail closed)

`dsh_btw.BtwRuntime` runs the same standalone `--dump-config` preflight as the
main runtime with the BTW argv/env/cwd. `verify_btw_dump` requires:

1. each disabled row appears exactly once with `disabled: true`;
2. `approval.policy: never` (posture only; it does not intercept a leaked tool);
3. `sandbox-policy.mode: read-only`;
4. `compaction-basic` equal to the effective budget;
5. the shipped `token-meter` row present and enabled;
6. no `patch: entry ... not found` warning in stdout/stderr.

Any failure raises before the child is spawned. There is no prompt-only
fallback.

## Loopback evidence

`probe_btw_no_tools.py` (kept with the change evidence, run against
`deepseek-harness-runtime-bin==0.2.1rc2`) starts a fake OpenAI-completions
server on `127.0.0.1`, launches the runtime with a profile patch, drives
`initialize` → `session/new` → `session/prompt`, and records the exact model
request body. No real upstream is contacted.

Observed results:

| Configuration                | `tools` field | Tools seen                                                   |
| ---------------------------- | ------------- | ------------------------------------------------------------ |
| BTW overlay                  | absent        | 0                                                            |
| Main `acp` profile (control) | present       | 25 (`bash`, `edit`, `read`, `exit_plan_mode`, `subagent`, …) |

The control run proves the probe actually detects tools. Two early BTW
attempts failed this check and grew the disabled list: disabling only the
obvious filesystem/shell rows still advertised `exit_plan_mode` (hence
`plan-mode`), and a later run still advertised one working-directory tool
(hence `tool-working-directory`). `docs/btw-probe-no-tools.py runtime` drives
the production `BtwRuntime` and its startup preflight, so the shipped code
path — not a copy of it — is what the evidence covers.

## Send-back queue

A confirmed send-back is stored server-side and delivered into a **new main
input cell**, never into history. Delivery is claim/acknowledge:

- at most one entry per notebook may be `delivering` (claimed) at a time; a
  second `claim` returns no entry with `inFlight: true`;
- a claim writes a `claimId`; only the holder of that id may acknowledge or
  cancel the entry;
- the client acknowledges `delivered` only after the main session accepted the
  run **and** the notebook document flushed, otherwise `failed` (nothing
  inserted) or `unknown` (explicit user confirmation before resending, never an
  automatic retry).

Queued deliveries are claimed when the BTW panel for that thread is open (or
restored) and the main session is idle; an entry left in a page that never
reopens the panel stays `queued` until the panel is restored.

## Session behaviour

One BTW runtime process serves many BTW sessions. `SharedDshRuntime` rejects a
second concurrent prompt on the same session and addresses `session/cancel` by
session id, so cancelling one side chat leaves the other BTW sessions and the
main runtime untouched. Closing the panel only hides it; a BTW session is kept
so the next message resumes the same conversation. A saved session that cannot
be resumed is an explicit error and is never replaced silently.
