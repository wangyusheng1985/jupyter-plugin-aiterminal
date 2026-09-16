## Why

Command cells currently require users to retype previous commands. A familiar
shell-style history interaction in the new command input will make repeated
commands faster while preserving independent history for each workspace tab.

## What Changes

- Record submitted Command cell source in a per-workspace-tab, session-only
  history.
- Support `ArrowUp` and `ArrowDown` in editable Command cell inputs to browse
  older and newer commands.
- Preserve the current draft when history browsing starts and restore it after
  moving past the newest history entry.
- Ignore empty submissions and collapse consecutive duplicate submissions.
- Keep AI cells and ordinary multiline text navigation unchanged.

## Capabilities

### New Capabilities

- `cell-input-history`: Per-tab Command cell history capture and keyboard
  navigation within editable inputs.

### Modified Capabilities

None.

## Impact

Affected code is limited to the workspace input/key handling, notebook or
workspace session state, and their unit tests. No file-format, dependency, or
public API changes are required.
