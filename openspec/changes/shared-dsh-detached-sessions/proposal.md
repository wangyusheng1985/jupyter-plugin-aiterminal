## Why

Each open `.agentnb` currently starts its own DSH runtime process, and closing or refreshing the browser closes that process. DSH is designed as one runtime hosting many ACP sessions that can keep running after the browser disconnects; the plugin currently prevents both behaviors, so parallel notebooks waste processes and in-flight results disappear.

## What Changes

- Host every AI session for one Jupyter server process on a single shared DSH runtime, with one ACP session per `.agentnb` and parallel prompts across those sessions.
- Keep an AI session and its in-flight turn alive when the browser tab is closed, refreshed, or the WebSocket drops. Reopening the same `.agentnb` shows the turn result, including progress that happened while no browser was attached.
- Persist detached turn progress into the owning `.agentnb` on the server. Reopen loads that document instead of depending on a live socket to have saved it.
- Cancel only the addressed session's current turn when the user interrupts. Do not stop the shared runtime or any other session.
- Close one ACP session only for an explicit workspace shutdown. Stop the shared runtime only when the Jupyter server shuts down.
- **BREAKING**: A browser disconnect no longer cancels the AI turn or terminates its runtime. Command-cell bash processes remain tied to their WebSocket and are out of scope.

## Capabilities

### New Capabilities

- `shared-dsh-runtime`: One Jupyter server process owns one DSH runtime and multiplexes one ACP session per workspace, including parallel prompts and per-session cancellation.
- `detached-session-continuity`: AI sessions survive browser disconnect, persist their progress into `.agentnb`, and present the completed or still-running result when the workspace reopens.

### Modified Capabilities

- `agent-session-lifecycle`: Connection ownership moves from one WebSocket to the shared runtime host. A dropped socket no longer makes the AI session unusable or cancels its turn, and startup must attach to the existing session instead of creating another runtime.

## Impact

- DSH process ownership in `jupyter_aiterminal/dsh_acp_transport.py` and `jupyter_aiterminal/dsh_acp_session.py`.
- WebSocket attach and detach in `jupyter_aiterminal/handlers.py` and `jupyter_aiterminal/agent.py`.
- Server-side document updates for detached turns, plus reopen handling in `src/agent/workspace.ts` and `src/agent/session.ts`.
- Python and TypeScript tests for multiplexing, disconnect survival, per-session cancel, and reopen.
- No change to Command-cell shell lifetime, credential storage, or the DSH runtime version pin. The pinned runtime must be verified to accept concurrent sessions before implementation proceeds.
