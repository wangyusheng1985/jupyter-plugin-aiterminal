## 1. Interaction State Foundations

- [x] 1.1 Add pure helpers that project eligible navigation entries from workspace Cells by stable ID and verify unit tests cover queued, running, completed, interrupted, draft, rerun, insertion, deletion, and document-order cases.
- [x] 1.2 Add Unicode-aware ten-character preview normalization and accessible-label helpers and verify unit tests cover whitespace, short text, long text, multiline input, shell escapes, CJK text, emoji graphemes, and the segmentation fallback.
- [x] 1.3 Add pure proximity and roving-focus state helpers and verify unit tests cover closest-marker selection, neighbor weighting, boundary keys, activation, entry removal, and retained focus after reconciliation.
- [x] 1.4 Add ephemeral streaming follow/detach state helpers and verify unit tests cover near-tail updates, manual movement away, editing another Cell, return-to-latest, run replacement, completion, failure, and interruption.
- [x] 1.5 Derive a coarse workspace UI snapshot for connection, cwd, selected Cell, active run, queue count, and interrupt availability and verify it changes for execution transitions but not for output-only Turn revisions.

## 2. Workspace Layout and Adaptive Output

- [x] 2.1 Introduce a workspace body that composes the existing notebook scroll surface with a reserved navigator region and verify workspace tests confirm the notebook remains the only page-level scroller and the status bar remains a separate fixed-height sibling.
- [x] 2.2 Make the Turn outcome root use the available width while constraining direct prose descendants to a readable measure and verify renderer/style tests cover wide paragraphs, wide tables, code blocks, media, and audit records.
- [x] 2.3 Add scoped overflow and container-responsive rules for tables, preformatted content, long paths, audit rows, and status content and verify a narrow-container DOM/style fixture has no workspace-level horizontal overflow.
- [x] 2.4 Preserve long-outcome preview height, compact Cell output, bounded evidence, and saved disclosure behavior and verify the existing Turn, workspace, compact-output, and document round-trip tests remain green.

## 3. Cell History Navigator

- [x] 3.1 Implement a keyed `CellNavigatorView` with one marker per eligible Cell and verify component tests cover incremental add, update, reorder, rerun, status change, deletion, and stable node identity during unrelated streaming updates.
- [x] 3.2 Render semantic marker buttons with stable hit areas, non-color selected/current/queued/running cues, one roving tab stop, visible focus, and accessible names and verify keyboard-only tests cover Tab entry, directional traversal, Enter, and Space.
- [x] 3.3 Implement animation-frame-batched pointer proximity, cached marker geometry, neighbor scaling through transforms, and a single reusable preview tooltip and verify fake-frame tests show at most one update per frame and no marker-bound layout changes.
- [x] 3.4 Observe viewport-current Cells independently from notebook selection and verify scroll/observer tests cover partial Cells, tall outputs, split-panel resize, observer fallback, and no selection or editor-focus changes from manual scrolling.
- [x] 3.5 Add stable-ID Cell reveal that selects in command mode, avoids unnecessary movement for visible targets, uses interruptible smooth scrolling otherwise, and uses immediate reveal under reduced motion; verify reveal and focus tests cover each path.
- [x] 3.6 Handle histories taller than the rail with navigator overflow and focused-item reveal, then add the narrow-container compact history control and verify every represented Cell remains reachable in both presentations.

## 4. Streaming and Scroll Ownership

- [x] 4.1 Integrate the follow controller around running-output rerenders and verify streaming tests follow the tail only when near it and do not move the main scroll position after manual detachment.
- [x] 4.2 Add the stable overlay `Return to latest` control and verify activation reveals the running tail, reenables following, does not resize notebook content, and disappears when the run terminates.
- [x] 4.3 Preserve active editor focus, text selection, selected Cell, main scroll state, bounded output scroll, evidence scroll, and Turn-control focus across streaming updates and verify focused and detached-reading regression tests.
- [x] 4.4 Ensure selecting Cell chrome, output, or a navigation marker remains distinct from entering edit mode and verify existing notebook keyboard behavior plus new pointer-navigation regression tests.

## 5. Toolbar and Status Coordination

- [x] 5.1 Expose workspace UI-state subscription to external toolbar consumers and verify the subscription emits immediate accepted-action and queue-transition state without emitting for output-only changes.
- [x] 5.2 Group insert and execution actions using existing JupyterLab toolbar components, synchronize enabled/tooltips state, disable interrupt while idle, and verify toolbar unit tests cover idle, running, queued, interrupted, and disposed states.
- [x] 5.3 Replace the single status message with fixed-height connection, truncatable cwd, and execution/queue regions and verify status tests cover connected, disconnected, ready, running, queued, error, and constrained-width content.
- [x] 5.4 Synchronize Cell prompt, navigator, toolbar, and status feedback from the same accepted run and queue transitions and verify an integration test observes consistent state before any streamed output arrives.

## 6. Motion, Theme, and Responsive Styling

- [x] 6.1 Add scoped motion tokens and transform/opacity-based hover, focus, pressed, selection, tooltip, and running treatments and verify computed styles do not animate marker dimensions or move adjacent controls.
- [x] 6.2 Add reduced-motion overrides for proximity feedback, tooltip fading, and smooth Cell reveal while preserving final selected/current/status/focus cues and verify match-media tests cover both preference modes.
- [x] 6.3 Use only JupyterLab theme tokens for light/dark surfaces, text, borders, focus, brand, warning, and error states and verify light and dark manual checks retain readable text and non-text contrast without external fonts or hard-coded product colors.
- [x] 6.4 Add workspace-container breakpoints for wide rail, constrained rail, narrow history control, audit-row reflow, and status truncation and verify fixtures at representative narrow, medium, and wide panel widths preserve all primary controls.

## 7. Verification and Delivery

- [x] 7.1 Run `jlpm test --runInBand` and verify all existing and new frontend unit tests pass without leaked observers, animation frames, event listeners, or timers.
- [x] 7.2 Run `jlpm typecheck` and `jlpm lint` and verify TypeScript, ESLint, and Prettier checks complete without errors or warnings.
- [x] 7.3 Run `jlpm build:prod` and verify the production JupyterLab extension bundle completes without adding runtime dependencies or changing the `.agentnb` schema version.
- [x] 7.4 Manually validate JupyterLab with long Cell histories, rerun Cells, queued AI and Command work, rapid streaming, wide tables, long prose, compact outputs, light/dark themes, keyboard-only navigation, reduced motion, and split-panel resizing; verify feedback remains responsive and user scroll/focus ownership is preserved.
- [x] 7.5 Profile pointer movement and frequent streaming with a realistic long workspace and verify proximity feedback normally lands by the next frame, accepted controls respond within 100ms, and unchanged navigator/status DOM is not reconstructed.
