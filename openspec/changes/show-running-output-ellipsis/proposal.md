## Why

Cells can stream output for a long time, but once some content has appeared there is no visual cue at the end of the output showing that execution is still active. A lightweight animated ellipsis at the output tail makes the running state visible where users are already looking.

## What Changes

- While an AI or Command cell is running, show an animated `...` indicator after the cell's last visible output item.
- Show the indicator in the empty-output state as well, so a newly started cell still communicates progress.
- Remove the indicator immediately when execution completes or is interrupted, without adding it to the cell's persisted output or copyable command/result text.
- Keep the indicator visually compatible with JupyterLab themes and non-disruptive to streamed output layout.

## Capabilities

### New Capabilities

- `running-output-indicator`: Defines the visible animated ellipsis attached to the end of a running cell's output.

### Modified Capabilities

None.

## Impact

- Frontend cell-output rendering and running-state synchronization in `src/agent/workspace.ts`.
- Extension styling and animation in `style/base.css`.
- Frontend tests covering AI and Command cells, streamed/empty output, and completion or interruption transitions.
- No backend protocol, persisted `.agentnb` format, or external API changes.
