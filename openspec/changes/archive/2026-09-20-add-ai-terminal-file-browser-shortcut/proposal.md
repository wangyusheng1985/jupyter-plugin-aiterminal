## Why

AI Terminal can currently be created from the Launcher, but users working in the left file browser must leave their folder workflow to do so. Adding the same kind of context-menu creation entry used by notebook workflows makes `.agentnb` workspaces discoverable and lets users create them directly in the intended folder.

## What Changes

- Add an **AI Terminal** creation action to the default JupyterLab file browser context menu.
- Create an untitled `.agentnb` workspace in the directory that the user invoked the action for: the clicked directory when a directory item is targeted, otherwise the file browser's current directory.
- Open and activate the newly created AI Terminal through the existing document manager and Agent Workspace factory, preserving JupyterLab's normal collision-safe untitled naming.
- Keep the existing Launcher action and existing-workspace open/restore behavior unchanged.

## Capabilities

### New Capabilities

- `file-browser-workspace-creation`: Create and open an AI Terminal workspace from the JupyterLab file browser context menu in the user-selected directory context.

### Modified Capabilities

None.

## Impact

- Frontend activation and command registration in `src/index.ts` will gain file-browser context-menu integration and target-directory resolution.
- Frontend tests in `src/index.spec.ts` will cover menu registration, current-directory creation, directory-target creation, and unchanged Launcher behavior.
- The change uses existing JupyterLab application, file browser, document manager, translation, and terminal icon APIs; it adds no backend endpoint, document-format change, migration, or runtime dependency.
