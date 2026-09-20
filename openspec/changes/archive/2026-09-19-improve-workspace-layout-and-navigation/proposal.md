## Why

AI Terminal currently leaves substantial horizontal space unused for structured results, provides no compact way to navigate a long workspace, and gives limited page-level feedback while cells stream, scroll, queue, and change focus. The workspace should feel like a responsive JupyterLab-native developer tool whose layout uses the available panel and whose interactions remain immediate, stable, and interruptible.

## What Changes

- Make AI outcomes adapt to the workspace width: keep prose readable while allowing tables, code, media, audit records, and other structured content to use the available horizontal space.
- Add a persistent right-side Cell navigation rail with one compact marker per submitted Cell, proximity-based pointer feedback, a ten-character input preview on hover or keyboard focus, and direct navigation to the corresponding Cell.
- Keep selected, viewport-current, hovered, queued, and running Cell states distinct so scrolling never changes the editing target unexpectedly.
- Add page-level streaming-follow behavior that follows new output only while the user remains near the output tail, pauses when the user reads earlier content, and offers a direct return-to-latest action.
- Coordinate toolbar, Cell, navigation, queue, connection, and bottom-status feedback so accepted actions are acknowledged immediately without changing layout dimensions.
- Define responsive alternatives for narrow JupyterLab panels, complete keyboard operation, visible focus, interruptible motion, and reduced-motion behavior.
- Establish measurable responsiveness and stability expectations for pointer tracking, click feedback, scrolling, streaming updates, and layout shift.

## Capabilities

### New Capabilities

- `cell-history-navigation`: Compact, accessible navigation among submitted workspace Cells, including pointer-proximity feedback, previews, direct reveal, state indication, and narrow-panel fallback.
- `workspace-interaction-experience`: Page-level behavior for responsive Cell selection, streaming follow/detach, coordinated toolbar and status feedback, motion preferences, and interaction-performance constraints.

### Modified Capabilities

- `agent-turn-academic-presentation`: Replace the fixed-width outcome root with an adaptive presentation that preserves readable prose while allowing structured result content to use the available workspace width.

## Impact

- Frontend workspace composition, Cell rendering and navigation in `src/agent/workspace.ts`.
- Toolbar state and grouping in `src/agent/toolbar.ts` and widget assembly in `src/agent/factory.ts`.
- Turn and Markdown presentation styles, responsive rules, motion, focus, and status styling in `style/base.css`.
- Frontend unit tests for layout classes, navigation reconciliation, pointer and keyboard behavior, scroll following, reduced motion, toolbar state, and status presentation.
- Existing `.agentnb` version 2 Cell snapshots remain the navigation source of truth; no backend protocol, document-format migration, or new runtime dependency is required.
