## Context

See `proposal.md` for why one shared runtime and browser-independent sessions are needed. The current server creates one DSH subprocess per WebSocket: `DshAcpTransport` owns that process, `DshAcpSession` stores one session id and rejects a second prompt, and `AgentWebSocketHandler.on_close` closes both the ACP session and its process. The frontend writes `.agentnb` only while the browser is connected, so progress produced after a disconnect is lost even if the process survived.

The pinned runtime is `deepseek-harness-runtime-bin==0.2.1rc2`. ACP requests already carry `sessionId`, and notifications carry `params.sessionId`, but no test proves that one process accepts two `session/new` calls or runs their prompts concurrently. The sandbox patch also has one process-level `workspaceRoot`; the session cwd is supplied separately and is documented as the write boundary.

## Goals / Non-Goals

**Goals:**

- One DSH process per Jupyter server, with one ACP session per `.agentnb` and truly parallel prompts.
- Browser close, refresh, and WebSocket loss detach the viewer without cancelling AI work.
- Detached progress and terminal results are durable in the owning `.agentnb`.
- Interrupt and explicit workspace shutdown stay per session.

**Non-Goals:**

- Surviving a Jupyter server restart. The runtime remains a child of that process.
- Detaching Command-cell bash sessions from their WebSocket.
- Multiplexing several workspaces through one browser WebSocket.
- Changing the runtime version pin or approval behavior.

## Decisions

### 1. Prove multiplexing before changing ownership

The first implementation task runs two `session/new` calls with different cwd values on one live runtime, then overlaps their `session/prompt` calls. It checks that notifications stay tagged with the correct `sessionId` and that neither session writes outside its cwd.

Alternative considered: start the refactor and mock the runtime. That can pass while the pinned runtime rejects the second session or applies one sandbox to both. A failed probe stops the change; the specs are not weakened to one-process-but-serial execution.

### 2. Split process ownership from session ownership

A server-scoped runtime host owns one transport and its `initialize` handshake. Each workspace gets a session object that sends `session/new` or `session/resume`, `session/prompt`, and `session/cancel` through that transport. The transport demultiplexes notifications by `params.sessionId` to the matching session projector. One session still has at most one active prompt; different sessions do not share that lock.

Alternative considered: keep one `DshAcpSession` and add a session map inside it. The current class mixes process lifetime, policy preflight, permissions, and one run lock, so a separate host keeps process shutdown from looking like session cancellation.

### 3. WebSocket attach is separate from session lifetime

The host registry keys live sessions by their ACP session id and records the `.agentnb` path that owns each one. Socket open attaches a sink; socket close removes that sink. It does not send `session/cancel` or `session/close`. Explicit workspace shutdown is a distinct client message and is the only per-workspace path that cancels and closes a session. Jupyter server shutdown closes the host and terminates the child.

A second browser attaching to a session that already has a live sink is rejected. This avoids two viewers driving one turn. The first viewer keeps the session.

Alternative considered: reference-count sockets and close at zero. That recreates today's data loss whenever the last tab closes.

### 4. The server writes detached progress into `.agentnb`

The host reuses the existing notebook snapshot format. On each bounded turn update and on terminal result, it updates the running cell's blocks, turn, and status in the owning document and writes atomically. While a browser is attached, the current client save path remains authoritative and the host does not write over a newer client revision. While detached, the host is authoritative. Reopening the document shows the saved state; if the turn is still running, the new socket attaches and receives only subsequent events plus the current snapshot needed to reconcile.

The document stores no credentials and no raw ACP transcript beyond the existing product blocks.

Alternative considered: replay a server ring buffer after reopen. A buffer does not survive a long detachment and duplicates the document, which is already the audit record.

### 5. Runtime failure resumes the same sessions

If the shared child exits, the host starts one replacement and resumes every live session by its saved id. It does not create replacement sessions. A session whose resume fails reports the existing resume-unavailable error to its attached client and remains saved in its document. One failed resume does not take down sessions that resumed successfully.

## Risks / Trade-offs

- [Pinned runtime rejects concurrent sessions or isolates cwd incorrectly] → The probe is a hard gate; stop before shipping the host.
- [Process-level `workspaceRoot` conflicts with per-session cwd] → Probe writes a sentinel in each cwd and asserts no cross-write. If it fails, the change stops rather than broadening the sandbox.
- [Host and browser save the same `.agentnb` concurrently] → Client revision wins while attached; host writes only while detached, using atomic replacement.
- [Shared runtime failure affects every workspace] → Restart once and resume independently; surface per-session resume failure without replacing identity.
- [Long detached runs consume memory] → Bound persisted snapshots to the existing product block model; do not retain raw ACP frames.
- [Users expect closing the tab to stop work] → This is the accepted breaking change. Explicit shutdown remains available and interrupt remains per session.

## Migration Plan

1. Add the runtime probe and run it against the pinned runtime.
2. Deploy the host behind the existing WebSocket route without changing `.agentnb` version: it writes the current snapshot fields only.
3. Existing documents reconnect by their saved DSH session id. If the old per-connection process already exited, resume uses the existing failure path; no document rewrite is required.
4. Roll back by restoring per-socket process ownership. Documents saved by the host remain valid because they use the current snapshot schema.

## Open Questions

None. The runtime probe can disprove feasibility, but its outcome is an implementation gate, not a deferred product choice.
