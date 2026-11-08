## Context

See `proposal.md` for motivation and `specs/file-browser-workspace-creation/spec.md` for the behavior contract. The extension currently registers `aiterminal:open`, exposes it in the Launcher, and creates a collision-safe untitled `.agentnb` through `IDocumentManager.newUntitled` using the default file browser's current path. `IDefaultFileBrowser` is optional, so activation must continue to work when it is absent.

JupyterLab context-menu entries are registered against DOM selectors. The command receives static menu arguments rather than the originating mouse event, while the file browser's `modelForClick` can resolve the exact item only while handling that event. Directory targeting therefore needs a small adapter between the context-menu event and the eventual command execution.

## Goals / Non-Goals

**Goals:**

- Integrate AI Terminal with the standard default-file-browser context menu and native translated command presentation.
- Resolve the invocation directory deterministically for a clicked folder, file/blank listing area, and root directory.
- Reuse the existing document creation/opening pipeline so naming, document factories, activation, and failures remain consistent with Launcher creation.
- Keep the integration optional and testable without a full browser session.

**Non-Goals:**

- Add a custom submenu, naming dialog, template picker, or kernel selection flow.
- Change `.agentnb` serialization, backend sessions, settings, or restore behavior.
- Add context-menu entries to third-party file browsers or non-file-browser surfaces.
- Change what happens when an existing `.agentnb` file is opened.

## Decisions

### Register a dedicated file-browser creation command and one context-menu item

Add an internal command for context-menu creation with the same translated **AI Terminal** label, caption, terminal icon, and document-opening result as the existing Launcher command. Register it with `app.contextMenu.addItem` for the default directory-listing content selector and rank it alongside other creation actions. Only register the command and menu item when `IDefaultFileBrowser` is present.

A dedicated command keeps context-only target state out of the public `aiterminal:open` path and avoids changing the meaning of its existing `path` argument. Registering the existing command with a source flag was considered, but it would couple Launcher/open semantics to transient context-menu state and make stale-state regressions harder to contain.

### Capture the target model at context-menu invocation time

Install one `contextmenu` listener on the default file browser node. For each invocation, call the browser's `modelForClick(event)` before the menu command runs:

- if the clicked model is a directory, capture that model's path;
- if the click targets a file, blank listing space, or cannot be mapped to a model, capture `fileBrowser.model.path`;
- preserve the empty string as the valid root-directory path.

The context-menu command consumes that captured directory and falls back to the browser's current path if no capture is available, then clears the transient value. Capturing the event-time model was chosen over reading `selectedItems()` because a right-click can preserve a multi-selection and does not reliably identify which selected directory was the invocation target. Deriving a path from rendered labels or private listing arrays was rejected as brittle.

### Share one create-open-activate pipeline

Keep `openAgentWorkspace` as the document-level primitive. Both Launcher creation and context-menu creation provide a working directory to the same sequence:

1. request a new untitled file with `type: 'file'`, `ext: '.agentnb'`, and the resolved directory path;
2. open the returned path with the Agent Workspace factory;
3. activate the returned widget in the application shell.

JupyterLab's contents/document manager remains responsible for collision-free untitled naming and error propagation. The context-menu path will not precompute `Untitled.agentnb`, probe the filesystem, overwrite a file, or duplicate document-factory logic.

Factor directory resolution and/or the shared creation flow into small helpers where that makes unit tests independent of DOM rendering. The existing explicit `path` branch for opening/revealing a saved workspace remains unchanged.

### Keep optional-service behavior explicit

When `IDefaultFileBrowser` is `null`, skip the listener, context command, and menu item. Continue registering the Launcher command exactly as today; its creation call omits the directory when no browser exists. No hard dependency is added to the plugin metadata.

This retains compatibility with stripped-down JupyterLab distributions while avoiding a visible menu action that cannot resolve its intended context.

## Risks / Trade-offs

**[JupyterLab changes directory-listing CSS selectors]** → Keep the selector in one named constant, cover registration in tests, and include a real JupyterLab context-menu smoke check in delivery validation.

**[Transient target state becomes stale]** → Refresh it on every file-browser `contextmenu` event, consume and clear it when the command runs, and fall back to the live current directory when it is absent.

**[Right-clicking within a multi-selection creates in the wrong directory]** → Resolve the exact clicked model from the originating event instead of inferring it from selection state.

**[A directory becomes unavailable between menu open and command execution]** → Let the existing `newUntitled` promise reject through normal JupyterLab command error handling; do not silently create in another directory.

**[An added listener outlives its browser widget]** → Register it once during plugin activation and tie cleanup to the browser/plugin lifecycle if the activation API exposes a disposable path; unit tests verify that duplicate activation fixtures do not multiply behavior.

## Migration Plan

1. Add the target-directory resolver and context-menu command registration without changing the existing file type or document factory.
2. Extend frontend unit tests for registration, directory/file/blank-area resolution, root-path handling, unique-name delegation, creation/open/activation, and no-browser fallback.
3. Run frontend tests, typecheck, lint, and a production extension build.
4. Manually verify the item and resulting file location in JupyterLab by right-clicking a folder, a file, blank listing space, and the root listing.

No data or backend migration is required. Rollback removes the context-menu command, registration, and listener; Launcher creation and all existing `.agentnb` files remain compatible.
