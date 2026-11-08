## Why

Input history currently disappears when JupyterLab or the browser reloads, and
AI submissions are excluded from history even though users expect AI and
Command cells in one workspace tab to share the inputs they have executed.
Automatic cell advance can also leave keyboard focus on the previous cell
instead of the new editable input.

## What Changes

- Maintain one shared input history per workspace document for every accepted,
  non-empty AI or Command submission.
- Persist that history in browser storage and restore it when the same
  workspace document is opened again.
- Keep history isolated by workspace document and scoped to the current browser
  origin, with bounded storage and graceful fallback when storage is
  unavailable.
- Allow AI cells, Command cells, and newly created cells in the same workspace
  tab to navigate the shared history with `ArrowUp`/`ArrowDown`.
- Ensure automatic cell advance after Command execution synchronizes and focuses
  the new editable input before the user continues typing.
- Add regression coverage for the real run-and-advance keyboard flow and for
  shared AI/Command history after reopening a workspace or restarting
  JupyterLab.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cell-input-history`: AI and Command submissions become one persistent,
  per-workspace input history, and automatic cell advance must leave the new
  cell ready for immediate arrow-key history navigation.

## Impact

Affected code is limited to the workspace history lifecycle, automatic cell
advance/focus handling, and their tests. Browser `localStorage` is used as a
session-independent client-side store and will now contain both AI input text
and Command text; no server API or workspace document format change is
required.
