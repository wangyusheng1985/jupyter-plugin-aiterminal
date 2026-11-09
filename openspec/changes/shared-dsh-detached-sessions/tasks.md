## 1. Runtime feasibility gate

- [x] 1.1 Add a live probe that starts one pinned DSH runtime, creates two ACP sessions with different cwd values, and overlaps their prompts; verify it asserts one process, distinct session ids, correctly tagged notifications, and no cross-cwd writes.
- [x] 1.2 Run the probe against `deepseek-harness-runtime-bin==0.2.1rc2` and record the result; verify implementation stops here if a second session, concurrent prompt, or cwd boundary fails.

## 2. Shared runtime and session multiplexing

- [x] 2.1 Separate runtime process ownership from ACP session ownership so one transport can host many sessions; verify a unit test shows `initialize` happens once and `session/new` happens once per workspace.
- [x] 2.2 Route notifications and prompt responses by ACP `sessionId`; verify events from one session cannot update another session's projector.
- [x] 2.3 Remove the cross-session prompt lock while keeping one active prompt per session; verify two sessions can run while a second prompt on one session is rejected.
- [x] 2.4 Limit interrupt and explicit session close to the addressed session; verify the other session and the shared process remain alive.

## 3. Browser detach and document continuity

- [x] 3.1 Change WebSocket close to detach its sink without sending `session/cancel` or `session/close`; verify a disconnect test leaves the prompt running.
- [x] 3.2 Add an explicit workspace-shutdown message that cancels and closes only that workspace session; verify disconnect and explicit shutdown produce different outcomes.
- [x] 3.3 Persist detached turn snapshots and terminal results into the owning `.agentnb` atomically, without writing while an attached client has a newer revision; verify the saved document shows completion after a detached prompt finishes.
- [x] 3.4 Reattach an opened workspace to its live session and reconcile the saved snapshot before live events; verify reopen preserves the session id and displays progress produced while detached.
- [x] 3.5 Reject a second browser attachment to a session that already has a live sink; verify the first viewer and running turn are unchanged.

## 4. Failure and regression coverage

- [x] 4.1 Restart one shared runtime after child exit and resume each live session by its saved id; verify one failed resume does not replace or terminate sessions that resume successfully.
- [x] 4.2 Cover three open workspaces with one runtime process, per-session interrupt, browser close, and reopen in the integration tests; verify the shared-runtime, detached-continuity, and lifecycle scenarios pass.
- [x] 4.3 Preserve Command-cell behavior by regression test; verify closing its WebSocket still ends only that bash process and does not stop AI sessions.
