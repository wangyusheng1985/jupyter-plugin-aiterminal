## Context

See `proposal.md` for motivation. Cell output is rendered by `CellView.syncOutput` in `src/agent/workspace.ts`. The renderer already creates a `Running…` placeholder only when an AI cell has no blocks or a Command cell has no text; once content arrives, there is no output-local running cue. Cell status and output content are already included in the render key, while theme styles live in `style/base.css`.

The indicator must work for both output representations: AI cells render a sequence of block nodes, whereas Command cells render a single `<pre>` containing streamed text. It must remain transient UI state rather than becoming part of `WorkspaceCell.output`, AI blocks, or the `.agentnb` snapshot.

## Goals / Non-Goals

**Goals:**

- Use one presentation-only indicator element for both AI and Command output paths.
- Keep the indicator at the end of the currently rendered content during streaming updates.
- Make lifecycle behavior deterministic from `cell.status` and accessible under reduced-motion preferences.
- Preserve existing output, protocol, persistence, and execution behavior.

**Non-Goals:**

- Changing the input/output prompt's existing `[*]` running marker.
- Adding progress percentages, elapsed time, cancellation controls, or backend heartbeat events.
- Showing animation while a cell's output is collapsed; the collapsed placeholder remains the sole output representation.
- Redesigning tool-level running labels inside AI output blocks.

## Decisions

### Append a dedicated indicator element during output rendering

After rendering the current AI blocks or Command `<pre>`, `syncOutput` will append a dedicated running-indicator element whenever the expanded cell status is `running`. For empty output, the same element becomes the only output-body child, replacing the special `Running…` node.

This keeps a single DOM contract across output types and naturally moves the indicator after newly streamed content whenever the output key triggers a rerender. The alternative of adding dots to strings or blocks was rejected because it would contaminate persisted/copyable output and require cleanup at every completion path.

### Implement the animation in CSS

The indicator element will expose three literal visual dots through markup or CSS and use a class-scoped keyframe animation to reveal or pulse them. Styling will use inherited output font/color and avoid timers or component-level animation state. A `prefers-reduced-motion: reduce` rule will disable the animation while retaining a static `...` cue.

CSS animation is preferred over a JavaScript interval because it avoids execution-time timers, extra rerenders, cleanup races, and notebook persistence concerns.

### Keep the indicator out of selectable output text

The indicator will be a sibling of the rendered output content, marked presentation-only for assistive technology and styled as non-selectable. The existing prompt and status bar continue to communicate state semantically; the dots are a visual reinforcement rather than a new status announcement.

This is preferred over embedding an animated text node inside `<pre>`, which would make selection behavior inconsistent and could place the dots on an unintended line when streamed output ends with a newline.

### Preserve collapsed-output behavior

When output is collapsed, the existing placeholder remains unchanged and the output body stays hidden. The indicator is rendered only in the expanded output body, preventing animation in hidden content and avoiding a second signal in the collapsed row.

## Risks / Trade-offs

- [A Command output ending in a newline can make “after the output” visually ambiguous] → Render the indicator as its own inline-sized element after the `<pre>` and cover newline-ending output in DOM/style tests.
- [Frequent streamed updates recreate the indicator and restart its CSS animation] → Use a short cyclic animation whose restart is not visually disruptive; avoid JavaScript phase tracking.
- [Theme colors or font metrics can reduce visibility] → Inherit the output area's typography and foreground color, using opacity rather than fixed colors.
- [Animation can distract motion-sensitive users] → Disable keyframes under `prefers-reduced-motion` and keep a static indicator.

## Migration Plan

No data or protocol migration is required. Ship the frontend bundle and styles together. Rollback consists of reverting the indicator markup, related tests, and CSS; saved notebooks remain compatible because their schema is unchanged.
