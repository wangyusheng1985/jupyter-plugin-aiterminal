## Context

See `proposal.md` for motivation and the three delta specs for observable behavior.

`AgentWorkspaceContent` is currently a vertical Lumino `Panel` containing one scrollable `NotebookView` and a bottom `StatusBar`; the `DocumentWidget` owns the toolbar. `NotebookView` reconciles stable `CellView` instances by Cell ID, while a running Turn can rerender its output body frequently. Cell snapshots already persist stable IDs, current source, execution count, output state, and Turn presentation state in `.agentnb` version 2. Shared input recall is separate browser-local history and does not map entries back to Cells.

The implementation must remain native to JupyterLab 4.5, reuse its theme variables and toolbar components, preserve notebook command/edit semantics, and avoid new runtime or animation dependencies. The main notebook remains the only page-level scroll surface; bounded output previews and raw evidence keep their existing local scroll regions.

## Goals / Non-Goals

**Goals:**

- Introduce a stable workspace body that gives structured results usable width while reserving a small, non-shifting region for Cell navigation.
- Reconcile navigation markers incrementally from stable Cell identities and keep them independent from high-frequency Turn revisions.
- Make pointer proximity, direct navigation, streaming follow, toolbar feedback, and status feedback feel immediate without taking scroll or focus ownership away from the user.
- Preserve readable prose, bounded evidence, saved disclosure state, light/dark theme compatibility, keyboard access, and reduced-motion behavior.
- Keep the change testable with deterministic state helpers even where the browser supplies scrolling and geometry.

**Non-Goals:**

- Persisting individual execution attempts or changing one-marker-per-Cell into one-marker-per-run.
- Changing Agent SDK events, the WebSocket protocol, FIFO execution semantics, input-history storage, or `.agentnb` version 2.
- Adding a minimap of rendered output, search, drag-to-scroll, Cell reordering, a global design-system preference, or a separate workspace mode.
- Importing external fonts, colors, animation libraries, or a general tooltip framework.
- Forcing automatic output following while the user edits another Cell or reads earlier content.

## Decisions

### Add a two-column workspace body beneath the document toolbar

`AgentWorkspaceContent` will contain a new body widget between the external toolbar and bottom status bar:

```text
DocumentWidget toolbar
Workspace body
  NotebookView       main scroll surface, minmax(0, 1fr)
  CellNavigatorView  reserved compact rail
StatusBar
```

The body uses grid or flex layout with a shrinkable notebook column and a fixed navigation column. The rail width is always reserved in wide mode, so marker emphasis and tooltip visibility never change Cell width. The tooltip is an overlay that opens toward the notebook and does not participate in layout.

At narrow container widths, container-query styling replaces the rail with a compact control owned by `CellNavigatorView`. Activating it exposes an ordered list of the same destinations in an anchored popover within the workspace body. Keeping the fallback inside the navigator avoids coupling responsive body state to the `DocumentWidget` toolbar lifecycle.

An absolute rail over the existing notebook was rejected because it would obscure wide results and focused controls. Making the rail a child of the notebook scroll flow was rejected because it would move with Cell content rather than remain available as navigation.

### Derive navigation entries from Cells rather than input history

The navigation model is a presentation-only projection of `WorkspaceNotebook.cells`. A Cell is eligible when it is currently queued or running, or when it has a numeric execution count from a started request. This includes completed and interrupted Cells, excludes unsubmitted drafts and the automatic trailing empty input, and naturally loses an ephemeral queued-only item after reload because queue state is not persisted.

Each entry contains stable Cell ID, current document index, normalized current source preview, execution/status metadata, and selected state. Reconciliation is keyed by Cell ID. Re-executing one Cell updates one entry; deleting the Cell removes it; inserting other Cells changes order without breaking identity.

`WorkspaceInputHistory` was rejected as the source because it deduplicates consecutive submissions, can outlive the visible Cell state, and has no Cell-ID association. Adding a persisted execution-history collection was rejected because the requested navigation target is a Cell and the existing rerun contract intentionally replaces that Cell's result.

### Maintain selected, viewport, interaction, and execution states separately

The navigator tracks four orthogonal dimensions:

- selected Cell ID from `WorkspaceNotebook.active`;
- viewport-current Cell ID from observation of visible Cell nodes;
- targeted Cell ID from pointer proximity or roving keyboard focus;
- queued/running status from the notebook execution model.

Manual scrolling updates only viewport-current state. It never calls notebook selection and therefore cannot move edit focus. Pointer hover affects only targeted presentation until activation. Activation resolves the stable Cell ID to its current index, selects it in command mode, and asks `NotebookView` to reveal that Cell.

An `IntersectionObserver` rooted at the notebook scroll node tracks visible Cell nodes. From the current intersection set, the navigator chooses the Cell whose center is closest to the scroll viewport center. Resize and Cell reconciliation refresh observation. This avoids a geometry read for every Cell on every scroll event. If observer support is unavailable in a test or restricted environment, selection remains functional and viewport-current decoration can fall back to the selected Cell.

Conflating viewport-current and selected state was rejected because ordinary reading would unexpectedly change the editing target. Encoding every state with color was rejected because it is inaccessible and visually ambiguous; marker length, an endpoint glyph or shape, accessible text, and theme color work together.

### Use semantic marker buttons with roving focus

Each marker is a native `button` with at least a 24 by 24 CSS-pixel pointer target. Its visual line is a pseudo-element or child that can scale horizontally inside that stable target. Only one marker has `tabIndex=0`; the rest use `-1`. Directional keys move the roving focus in document order, and Enter or Space activates the focused marker. Accessible names include execution position/state and the normalized input preview.

When markers exceed the available rail height, the rail scrolls its focused or targeted item into view and retains every entry. The main notebook does not scroll merely because keyboard focus moves among markers; it scrolls only on activation.

Putting every marker in the page tab order was rejected because a long workspace would require dozens of Tab presses. Clickable `div` elements and hover-only previews were rejected because they lose native keyboard semantics and accessible naming.

### Compute proximity feedback once per animation frame

The navigator owns one `pointermove` listener. It stores the latest pointer coordinate and schedules at most one `requestAnimationFrame` callback. Marker center positions are cached when the pointer enters, entries change, the rail scrolls, or a `ResizeObserver` invalidates geometry. The frame callback finds the closest marker and assigns normalized proximity values to it and its immediate neighbors.

CSS consumes the proximity values through `transform: scaleX(...)` and opacity/theme-state changes. Stable button bounds and transform origins prevent layout changes. Pointer tracking itself has no intentional transition delay; tooltip opacity/content may cross-fade briefly, and all transitions remain replaceable by newer state.

One reusable tooltip node displays beside the current target. Preview normalization trims the source, collapses whitespace, and takes ten grapheme clusters using `Intl.Segmenter` when available with an `Array.from` fallback. The tooltip is also shown for roving keyboard focus and is linked with accessible description semantics where appropriate.

Animating marker `width`, creating one tooltip per marker, or reading every marker rectangle for every raw pointer event was rejected because each option increases layout work and visible lag.

### Reveal Cells through a stable-ID NotebookView API

`NotebookView` will expose Cell-node lookup and `revealCell(cellId, options)`. Activation first updates selection without focusing the editor, renders selected state immediately, and then reveals the target only if it is not sufficiently visible. Normal motion uses native interruptible smooth scrolling with `block: 'center'`; reduced-motion mode uses immediate scrolling. A new activation supersedes the previous target, and wheel, trackpad, touch, or keyboard scrolling remains under browser control.

Navigation will not reuse `focusActive()` because that method is editor-oriented and can enter or preserve edit focus. Failure navigation remains scoped to a Turn activity and continues using its existing focus-preserving path.

### Make the outcome root wide and constrain prose descendants

The fixed `max-width: 78ch` moves off `.jp-AgentWorkspace-outcomeBody`. The outcome body becomes a full-width, shrinkable container. Direct prose descendants—headings, paragraphs, lists, and blockquotes—retain the readable measure, while tables, preformatted blocks, media, and the audit record can use the full container width.

Wide tables and preformatted content receive a scoped overflow strategy so they scroll within their own result region at narrow widths instead of creating workspace-level horizontal scrolling. Existing long-outcome preview height, output collapse behavior, evidence bounds, and scroll preservation remain unchanged.

Removing every line-length limit was rejected because it would solve the screenshot's table width at the cost of unreadable prose. Keeping the limit on the Markdown root was rejected because mixed outcomes cannot let structured content use otherwise empty space.

### Add an ephemeral streaming-follow controller

Follow state belongs to the current running request and is not persisted. It has two modes:

```text
following  -> user moves away or edits elsewhere -> detached
detached   -> user activates Return to latest    -> following
any mode   -> request terminates                  -> cleared
```

Before a running Cell output rerender, the controller determines whether its tail is within a small threshold of the notebook viewport end and whether focus is not inside another Cell editor. If following remains allowed, the post-render phase reveals the new tail. If the user scrolls away, interacts with another Cell, or edits elsewhere, the controller detaches and captures no forced main-scroll update.

A stable overlay button near the lower edge of the workspace body exposes `Return to latest` while detached. It does not change notebook padding or status-bar height. Activation reveals the running tail and reenables following. Existing output-render state capture continues to preserve bounded outcome and evidence scroll positions and focused Turn controls.

Always following was rejected because streamed output would repeatedly pull users away from earlier evidence. Never following was rejected because users monitoring active output would have to scroll manually after every update.

### Derive one workspace UI state for toolbar, navigator, and status

`AgentWorkspaceContent` will derive a compact UI snapshot from `AgentSession` and `WorkspaceNotebook`: connection state, selected Cell ID, active run, queued count, working directory, and whether interrupt is available. Consumers subscribe to changes and compare their last relevant snapshot before touching DOM.

`installAgentToolbar` will keep JupyterLab `ToolbarButton` components, group insert actions separately from run/interrupt actions, and return a small controller or disposable subscription that synchronizes enabled state and tooltips. Interrupt is disabled without an active request. Run acceptance updates UI state synchronously before server output arrives.

`StatusBar` becomes a fixed-height three-region layout: connection/ready state, truncatable working directory, and active-run/queue summary. Text accompanies status colors. At constrained width the directory yields first; connection and execution state remain visible. Frequent token content is excluded from the UI snapshot so the status bar is not rewritten for every streamed fragment.

Duplicating state calculations independently in toolbar, status, and navigator was rejected because their feedback could diverge at queue transitions. Replacing JupyterLab toolbar controls was rejected because it would lose native theme and accessibility behavior.

### Reconcile high-frequency output separately from navigation

The existing stable `CellView` map remains. `CellNavigatorView` computes a signature only from eligible Cell ID/order/source/status, selection, viewport ID, and responsive mode; Turn outcome text and revision are excluded. Streaming updates may still synchronize the running `CellView`, but unchanged navigator entries and toolbar/status regions are not recreated.

Pointer and scroll handlers batch writes through animation frames. Geometry reads occur only during cache rebuild phases and are separated from transform writes. The implementation will use native CSS, Pointer Events, `IntersectionObserver`, `ResizeObserver`, and browser scrolling; no GSAP or rendering framework is added.

Virtualizing the Cell notebook or navigator is deferred. The navigator contains small marker buttons, and incremental keyed reconciliation plus overflow scrolling is sufficient for the current workspace scale. Tests and profiling should revisit virtualization only if realistic histories demonstrate frame-budget violations.

### Centralize restrained motion and reduced-motion behavior

CSS variables scoped to the workspace define short feedback, disclosure, and navigation timings. Pointer tracking applies transforms directly per frame; brief opacity transitions are reserved for tooltip and state acknowledgement; disclosure changes use the existing semantic controls. Every transition changes only transform, opacity, color, or background and does not drive surrounding layout.

`prefers-reduced-motion: reduce` removes proximity scaling transitions, tooltip fading, smooth Cell reveal, and other nonessential motion while keeping selected, current, queued, running, focus, and preview information visible in final form.

Broad entrance animations, staggered Cell loading, spring overshoot, and external motion presets were rejected because this is a dense developer workspace rather than a marketing surface.

## Risks / Trade-offs

**[Dense histories exceed the rail height]** -> Keep stable 24-pixel targets in a scrollable rail, automatically reveal the roving-focus item, and expose the ordered narrow-mode list without dropping entries.

**[Proximity effects feel decorative or lag behind the pointer]** -> Apply direct per-frame transforms with no hover delay, limit influence to the closest marker and immediate neighbors, and profile with realistic Cell counts.

**[Several marker states become visually ambiguous]** -> Keep state dimensions orthogonal, use length/shape/text as well as color, document precedence, and test selected-plus-running and selected-plus-hover combinations in light and dark themes.

**[Intersection observation identifies an unexpected current Cell]** -> Define viewport-current as closest visible Cell center, test partial Cells and tall outputs, and keep the state presentational so it never changes selection.

**[Automatic follow steals scroll position]** -> Require proximity to the running tail, detach on deliberate movement or editing elsewhere, and test streaming while the user reads older Cells and bounded evidence.

**[Full-width Markdown leaks horizontal overflow]** -> Constrain prose descendants, scope overflow to structured elements, retain `min-width: 0`, and test large tables, long paths, code, images, and math at container breakpoints.

**[Toolbar or status feedback churns on every token]** -> Derive a coarse UI snapshot that excludes output content and update consumers only when their relevant state changes.

**[Browser observers are awkward in unit tests]** -> Isolate entry projection, current-Cell selection, preview formatting, proximity calculation, follow-state transitions, and UI-state derivation as pure helpers; use adapter fakes for observers and scrolling.

**[The narrow-mode popover introduces a second navigation pattern]** -> Reuse the same entry model, selection action, preview text, roving semantics, and state labels; switch presentation only at the workspace container boundary.

## Migration Plan

1. Add pure navigation, preview, follow, and workspace-UI state helpers with unit tests before connecting DOM behavior.
2. Introduce the workspace body and navigator in wide mode while retaining the current notebook and status rendering.
3. Add stable-ID reveal, viewport observation, pointer proximity, keyboard operation, overflow behavior, and the narrow-mode fallback.
4. Move the fixed outcome measure from the Markdown root to prose descendants and verify structured content under light, dark, wide, and narrow layouts.
5. Add streaming follow/detach and return-to-latest behavior on top of existing output scroll/focus preservation.
6. Synchronize toolbar and bottom status consumers from the shared UI snapshot and add fixed-dimension responsive styling.
7. Run unit tests, typecheck, lint, production build, and manual JupyterLab validation with long histories, queued work, streaming Turns, wide tables, keyboard-only use, reduced motion, and split-panel resizing.

The rollout requires no document or backend migration. Rollback consists of restoring the prior workspace composition and styles; `.agentnb` version 2 content, Turn evidence, input history, and backend session behavior remain compatible.
