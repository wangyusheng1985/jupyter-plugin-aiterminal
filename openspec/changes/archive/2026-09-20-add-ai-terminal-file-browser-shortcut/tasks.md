## 1. File Browser Context Resolution

- [x] 1.1 Add the dedicated file-browser creation command identifier, directory-listing selector, and event-time target-directory resolver in the frontend activation layer; verify focused unit tests resolve a clicked directory to its own path and resolve a clicked file, blank listing area, or unmapped event to the current browser path, including the empty root path.
- [x] 1.2 Capture and consume the right-click target without relying on file-browser selection state; verify unit tests cover a directory clicked within a multi-selection, refresh the capture on consecutive context-menu events, clear consumed state, and fall back to the live current directory when no capture exists.

## 2. Context Menu Creation Flow

- [x] 2.1 Register the translated **AI Terminal** command and terminal-icon context-menu item only when `IDefaultFileBrowser` is available; verify `src/index.spec.ts` asserts the directory-listing selector, menu rank/command wiring, command presentation, and successful activation with and without the optional file browser.
- [x] 2.2 Route the context command through the existing untitled Agent Workspace create/open/activate pipeline; verify tests assert the resolved `path` is passed to `newUntitled`, the returned collision-safe path is opened with the Agent Workspace factory, the new widget is activated, and existing files are never opened through the creation branch.
- [x] 2.3 Preserve existing Launcher and saved-workspace behavior while updating user-facing usage/plugin description text to mention file-browser creation; verify the current Launcher-current-directory and explicit-path open/restore regression tests remain green and the README documents both entry points.

## 3. Verification and Delivery

- [x] 3.1 Run `jlpm test --runInBand`, `jlpm typecheck`, and `jlpm lint`; verify all frontend tests pass and TypeScript, ESLint, and Prettier report no errors or warnings.
- [x] 3.2 Run `jlpm build:prod`; verify the production JupyterLab extension bundle succeeds without a new runtime dependency or `.agentnb` schema change.
- [x] 3.3 In a running JupyterLab instance, right-click a directory, a file, blank listing space, and the root listing; verify the **AI Terminal** item appears with its icon, creates the collision-safe `.agentnb` in the specified directory context, opens and activates the tab, and leaves Launcher creation unchanged.
