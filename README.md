# jupyter-aiterminal

AI Terminal for JupyterLab. Mixed **AI** and **Command** cells in a notebook-like workspace, saved as `.agentnb` files.

## What it does

- **AI cells** send natural language to the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python) on the Jupyter server (Read / Write / Edit / Bash / Glob / Grep). Markdown in the reply is rendered.
- **Command cells** run non-interactive bash with a persistent cwd and streaming output.
- New workspaces appear in the file browser as `Untitled.agentnb`. Content autosaves. Closing the tab closes the document; a full Jupyter refresh only restores tabs that were still open.

It does **not** include a classic SSH terminal or interactive TUI (vim / ssh / full-screen apps).

## Security warning

**This extension gives the AI agent and every Command cell the ability to run arbitrary commands as the Jupyter server user.** Treat access to it as equivalent to a shell on that machine.

- The agent runs with `permission_mode: bypassPermissions` and holds `Read`, `Write`, `Edit`, `Bash`, `Glob`, and `Grep`. There is no per-command confirmation prompt.
- Command cells execute arbitrary bash in a long-lived shell, as the user running Jupyter.
- `policy.py` blocks `apt`/`yum`/`dnf` and `curl | sh` style installs. That is a guardrail against careless damage, **not a sandbox** — it does not constrain what the agent can do.
- Any user who can authenticate to the Jupyter server can reach this extension.

Recommended precautions:

- Never expose a Jupyter server running this extension to an untrusted network, and do not share an instance with people you would not give a shell.
- Run it inside a container or VM you are willing to lose.
- Keep Jupyter's own authentication enabled.

## Requirements

- Python 3.10+
- JupyterLab 4.5 (4.x `<5`)
- `claude-agent-sdk`
- A `claude` CLI on the Jupyter **server** `PATH`
- An Anthropic-compatible API (official Anthropic or a local relay)

## Install

### pip

```bash
pip install jupyter-aiterminal
```

Restart JupyterLab after install.

### git

```bash
pip install "git+https://github.com/wangyusheng1985/jupyter-plugin-aiterminal.git"
```

### from a local clone

```bash
git clone https://github.com/wangyusheng1985/jupyter-plugin-aiterminal.git
cd jupyter-plugin-aiterminal
pip install .
```

Uninstall:

```bash
pip uninstall jupyter-aiterminal
```

## Configure

Open **Settings → AI Terminal** and set:

| Setting   | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| Base URL  | Anthropic-compatible API root, e.g. `https://api.anthropic.com` or a relay |
| Model     | Model id passed to the Agent SDK                                           |
| API Token | API key / token                                                            |

All three are required. Empty values produce a config error that points back to Settings. Changing them takes effect the next time you open AI Terminal (a new WebSocket).

The token is stored in JupyterLab user settings on the server (`~/.jupyter/lab/user-settings/jupyter-aiterminal/`) and is visible in the Settings UI. Do not commit that file. The Agent WebSocket does not send the token to the browser.

## Use

1. Open the Launcher → **Other** → **AI Terminal**.
2. A `.agentnb` file is created in the current file-browser directory.
3. Type in a cell. Double-click the prompt (or use the toolbar) to switch **AI** / **Command**.
4. Run with Shift+Enter (run and advance) or the toolbar Run button.
5. Select text in a cell to show a copy icon at the pointer; click it to copy. `Cmd/Ctrl+C` / `V` / `X` / `A` work as usual. In command mode, `dd` deletes the cell.

Command cells share one bash session per tab, so `cd` persists. AI cells use the server-side Agent SDK, not that bash session.

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
