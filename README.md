# jupyter-aiterminal

AI Terminal for JupyterLab. Mixed **AI** and **Command** cells in a notebook-like workspace, saved as `.agentnb` files, powered by the **DeepSeek Harness (DSH)** Agent Client Protocol (ACP) runtime.

## What it does

- **AI cells** run an autonomous AI Agent powered by DSH over the Agent Client Protocol (ACP v1) on the Jupyter server. The agent reads, writes, and edits files, runs shell commands in the workspace, and renders streaming Markdown responses with collapsable execution traces.
- **Command cells** run non-interactive bash with a persistent working directory and streaming output.
- **In-cell shell execution**: type `!<command>` (e.g. `!git status`, `!ls -lh`) in any cell to run shell commands directly without switching modes.
- **Isolated execution counters**: each notebook document tracks its own execution count starting from `[1]:`, completely isolated across tabs and documents.
- New workspaces appear in the file browser as `Untitled.agentnb`. Content autosaves continuously. Closing the tab closes the document; a full Jupyter refresh restores opened tabs.

It does **not** include a classic SSH terminal or interactive TUI (vim / ssh / full-screen apps).

## Engine

AI cells use **DeepSeek Harness (DSH)** through ACP v1 over stdio. The extension ships its own stdlib-only ACP transport and pins the runtime wheel `deepseek-harness-runtime-bin==0.2.1rc2`.

- No Python SDK facade is required.
- No Node.js, npm, or globally installed `dsh` CLI is required on the server.
- No external packages are installed automatically at runtime.

## Security warning

**Command cells and AI tool calls can run arbitrary commands as the Jupyter server user.** Treat access to this extension as equivalent to a shell on that machine.

- DSH tool calls run with automated server-side approvals within the workspace sandbox, and all actions, file modifications, and bash outputs are logged transparently within the execution record inside the cell.
- Command cells execute arbitrary bash in a long-lived shell as the user running Jupyter.
- Any user who can authenticate to the Jupyter server can reach this extension.

Recommended precautions:

- Never expose a Jupyter server running this extension to an untrusted network, and do not share an instance with people you would not give a shell.
- Run it inside a container or VM you are willing to lose.
- Keep Jupyter's own authentication enabled.

## Requirements

- Python 3.10+
- JupyterLab 4.5 (4.x `<5`)
- An OpenAI-compatible or Anthropic-compatible API

The pinned runtime wheel contains platform executables:

- Linux: `manylinux` with glibc >= 2.28 (x86_64 and aarch64).
- macOS: >= 14 (arm64 and x86_64).

The same release also publishes a Windows amd64 wheel, but Windows is not part of the current validation scope.

## Install

Install the prebuilt wheel from PyPI; end users do not need Node.js or npm:

```bash
pip install jupyter-aiterminal
```

Restart JupyterLab (`sudo systemctl restart jupyter.service` for the usual single-service deployment) after install.

Uninstall:

```bash
pip uninstall jupyter-aiterminal
```

Older versions were installed through the Pi/Claude agent path and could require a separately installed CLI. That is no longer the current install path; see the migration note below.

## Configure

Open **Settings → AI Terminal** and set:

| Setting      | Meaning                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| API Protocol | `openai-completions` or `anthropic-messages`                                               |
| Base URL     | API root for that protocol, e.g. `https://api.anthropic.com` or an OpenAI-compatible relay |
| Model        | Model id passed to the provider                                                            |
| API Token    | API key / token                                                                            |

Base URL, Model, and API Token are required; API Protocol defaults to `anthropic-messages` for settings written before the selector existed. Empty required values produce a config error that points back to Settings. Changing them takes effect the next time you open AI Terminal (a new WebSocket).

The token is stored in JupyterLab user settings on the server (`~/.jupyter/lab/user-settings/jupyter-aiterminal/`) and is visible in the Settings UI. Do not commit that file or put a real token in a command line, log, or README.

### Budget and compaction

Seven optional settings control the effective token budget and automatic compaction. Leave them empty to use the plugin's derived defaults.

| Setting                          | Meaning                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Context Window                   | Declared context window in input tokens. This is configuration metadata, not a measurement of real model capacity. |
| Maximum Output Tokens            | Output-token budget for a single model turn. Used as configured, with no narrower implicit cap.                    |
| Automatic Compaction             | Turn automatic context compaction on or off in the shared runtime.                                                 |
| Compaction Threshold Ratio       | Fraction of the usable message budget at which compaction triggers. Must be greater than the retain ratio.         |
| Compaction Retain Ratio          | Fraction of the message budget kept after compaction. Must be strictly below the threshold ratio.                  |
| Compaction Headroom Tokens       | Tokens reserved below the message budget so compaction can still trigger.                                          |
| Compaction Summary Output Tokens | Output-token budget for the compaction summary.                                                                    |

Defaults and derived values:

- The built-in defaults are `8192` context window and `4096` maximum output tokens. These are conservative defaults, **not caps**: a configured maximum output token value is written through unchanged, and the old fixed `4096` output cap is gone.
- When compaction values are omitted, the plugin derives them from the effective budget following DSH's own formulas (single source of truth in `jupyter_aiterminal/dsh_config.py`): threshold ratio `0.8`, retain ratio `min(0.16, thresholdRatio / 2)`, headroom `floor(messageBudget * 0.25)`, and summary budget `max(1, min(maxOutputTokens, headroom))`.
- The plugin validates the whole configuration against DSH's formulas (`messageBudget = C - O`, `pressure = C - O - H`, `threshold = floor(min(C * thresholdRatio, pressure))`, `retain = floor((C - O) * retainRatio)`, plus `retainRatio < thresholdRatio`) before any connection. A combination DSH would reject or silently warn about becomes a named configuration error instead of a quiet degradation.

How the configuration is applied:

- The **active** configuration is the snapshot captured when the shared runtime process starts. The **desired** configuration is what the saved settings ask for.
- Saving settings never reconfigures a running runtime or its live sessions. A changed value shows as `pending-next-runtime` and applies only when the shared runtime next starts normally. Opening a new workspace or session on an already-running runtime keeps the active values.
- The plugin never restarts, kills, or replaces the runtime, and never interrupts an active or detached task. To activate a pending configuration, an administrator confirms all active and detached tasks have finished, schedules a maintenance window, and explicitly restarts Jupyter (for example `sudo systemctl restart jupyter.service`). That restart is a manual operational step, not an automatic one.
- The status bar's **Effective configuration** disclosure shows the active snapshot, the desired values, their differences, and each value's provenance (`user`, `default`, or `derived`).

Honest limits:

- Compaction is fundamentally **not observable** over ACP: the protocol sends usage updates but no compaction event, so the panel reports `not observable` rather than claiming compaction happened. A configuration being active is not evidence that compaction occurred.
- A turn that stops at `max-tokens` is labeled as budget-exhausted; the plugin never auto-continues or replays the request to extend an answer.
- Raising the configured budget does not repair truncation produced by a gateway or provider outside this plugin. The plugin makes its own budget explicit and the stop reason identifiable; it cannot fix upstream truncation.

## Sessions and old workspaces

- A DSH ACP **session** is durable and independent of the runtime process. Resuming a saved session id restores the conversation; restarting the runtime process does not erase the session.
- If a saved session cannot be resumed, the extension reports the saved context as unavailable and does not silently replace it with a fresh session. Starting a new context is an explicit user action.
- Workspaces created by older Pi/Claude-era builds still open and keep their visible cells and history. Their old agent session ids are not resumable through DSH, so they start without a linked runtime context. A bounded read-only history bridge is the intended migration path, but that migration is not released or fully verified in this branch.

## Use

1. Create an AI Terminal workspace with either entry point:
   - Open the Launcher → **Other** → **AI Terminal** to create it in the current file-browser directory.
   - In the left file browser, right-click a folder and choose **AI Terminal** to create it inside that folder. Right-clicking a file or blank listing space creates it in the current directory.
2. A collision-safe `Untitled.agentnb` file is created and opened automatically.
3. Type in a cell:
   - For **AI Agent tasks**: type your prompt or question in plain language.
   - For **Shell commands**: type `!<command>` (e.g., `!pytest` or `!ls -lh`) directly in the cell, or double-click the prompt / use the toolbar dropdown to explicitly switch to Command mode.
   - The cell input area expands dynamically to fit multiline input.
4. Run with `Shift+Enter` (run and advance) or `Ctrl/Cmd+Enter` (run in place).
5. Review results:
   - Execution records can be expanded/collapsed without jumping your viewport.
   - Select text in a cell to display a floating copy button; standard shortcuts (`Cmd/Ctrl+C`, `Cmd/Ctrl+V`) work as expected. In command mode, `dd` deletes the cell.

Command cells share one bash session per tab, so `cd` persists. AI cells use the server-side DSH runtime with full workspace awareness.

## Deploy

- The change is limited to the Jupyter server process (`jupyter.service` in the usual deployment); restart it after installing the new wheel.
- Back up `.agentnb` workspaces and the server-side Jupyter settings before upgrading, and keep the previous wheel so rollback is a reinstall plus settings restore.
- Do not put API tokens or other secrets in deployment scripts, unit files, logs, or documentation. The target host does not need this README to run the extension.

## Develop

```bash
jlpm install
jlpm lint         # ESLint and Prettier check
jlpm typecheck    # TypeScript compiler check
jlpm test         # Jest frontend unit tests
pytest            # Python backend tests
python -m build   # Build distribution packages
```

## License

BSD-3-Clause
