# jupyter-aiterminal

AI Terminal for JupyterLab. Mixed **AI** and **Command** cells in a notebook-like workspace, saved as `.agentnb` files.

> **Development status:** this branch is migrating the agent backend to the DeepSeek Harness (DSH) ACP runtime. The migration is under active development and has not shipped or been fully verified. Treat the DSH instructions below as the target behaviour for this branch, not as a released migration.

## What it does

- **AI cells** run a DSH agent over the Agent Client Protocol (ACP v1) on the Jupyter server. The agent can read, write, and edit files and run shell commands in the workspace, and its Markdown reply is rendered.
- **Command cells** run non-interactive bash with a persistent cwd and streaming output.
- New workspaces appear in the file browser as `Untitled.agentnb`. Content autosaves. Closing the tab closes the document; a full Jupyter refresh only restores tabs that were still open.

It does **not** include a classic SSH terminal or interactive TUI (vim / ssh / full-screen apps).

## Engine

AI cells use **DeepSeek Harness (DSH)** through ACP v1 over stdio. The extension ships its own stdlib-only ACP transport and pins the runtime wheel `deepseek-harness-runtime-bin==0.2.1rc2`.

- No Python SDK facade is required.
- No Node.js, npm, or globally installed `dsh` CLI is required on the server.
- No tool or package is installed automatically at runtime.

## Security warning

**Command cells and AI tool calls can run arbitrary commands as the Jupyter server user.** Treat access to this extension as equivalent to a shell on that machine.

- DSH tool calls are checked by the runtime's workspace policy. A permission request is surfaced to the UI and must be approved for that request; denial, cancellation, timeout, or disconnect returns the ACP `cancelled` outcome, never an implicit approval.
- Command cells execute arbitrary bash in a long-lived shell, as the user running Jupyter.
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

## Sessions and old workspaces

- A DSH ACP **session** is durable and independent of the runtime process. Resuming a saved session id restores the conversation; restarting the runtime process does not erase the session.
- If a saved session cannot be resumed, the extension reports the saved context as unavailable and does not silently replace it with a fresh session. Starting a new context is an explicit user action.
- Workspaces created by older Pi/Claude-era builds still open and keep their visible cells and history. Their old agent session ids are not resumable through DSH, so they start without a linked runtime context. A bounded read-only history bridge is the intended migration path, but that migration is not released or fully verified in this branch.

## Use

1. Create an AI Terminal workspace with either entry point:
   - Open the Launcher → **Other** → **AI Terminal** to create it in the current file-browser directory.
   - In the left file browser, right-click a folder and choose **AI Terminal** to create it inside that folder. Right-clicking a file or blank listing space creates it in the current directory.
2. A collision-safe `Untitled.agentnb` file is created and opened automatically.
3. Type in a cell. Double-click the prompt (or use the toolbar) to switch **AI** / **Command**.
4. Run with Shift+Enter (run and advance) or the toolbar Run button.
5. Select text in a cell to show a copy icon at the pointer; click it to copy. `Cmd/Ctrl+C` / `V` / `X` / `A` work as usual. In command mode, `dd` deletes the cell.

Command cells share one bash session per tab, so `cd` persists. AI cells use the server-side DSH runtime, not that bash session.

## Deploy

- The change is limited to the Jupyter server process (`jupyter.service` in the usual deployment); restart it after installing the new wheel.
- Back up `.agentnb` workspaces and the server-side Jupyter settings before upgrading, and keep the previous wheel so rollback is a reinstall plus settings restore.
- Do not put API tokens or other secrets in deployment scripts, unit files, logs, or documentation. The target host does not need this README to run the extension.

## Develop

```bash
jlpm install
jlpm test
jlpm typecheck
jlpm eslint
pytest
python -m build
```

## License

BSD-3-Clause
