## Why

Command history currently activates only in Command cells, but users expect one
tab-level history to be available from any later cell. A command entered in an
earlier cell should be recallable from another Command, AI, or newly created
cell in the same tab.

## What Changes

- Make the tab's command history available from every editable cell kind.
- Allow `ArrowUp` and `ArrowDown` to recall commands from earlier cells while
  preserving the current cell as a draft.
- Keep command submission recording limited to accepted Command cell requests.
- Preserve multiline caret behavior when the caret is not at the history
  navigation boundary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cell-input-history`: History navigation is changed from Command-only inputs
  to every editable cell in the workspace tab.

## Impact

Affected code is limited to workspace editor key handling and its tests. The
history source and tab-level lifecycle remain unchanged.
