## 1. Output Rendering

- [x] 1.1 Add a presentation-only running-output indicator helper in `src/agent/workspace.ts` and verify it renders a three-dot cue without mutating `WorkspaceCell.output` or `blocks`.
- [x] 1.2 Update expanded AI and Command output rendering to append the indicator after the newest visible content, use it as the empty-output placeholder, and remove it for completed/interrupted states; verify with DOM-focused workspace tests.
- [x] 1.3 Preserve collapsed-output and output-placeholder behavior while running; verify collapsed cells do not render an additional animated indicator in the visible output body.

## 2. Styling and Accessibility

- [x] 2.1 Add scoped CSS for the output-tail indicator, including inherited typography/color, non-selectable presentation styling, and a cyclic ellipsis animation; verify the generated stylesheet contains the indicator and keyframe rules.
- [x] 2.2 Add a `prefers-reduced-motion: reduce` override that leaves a static three-dot cue; verify via CSS inspection and a browser/style test if available.

## 3. Verification

- [x] 3.1 Extend frontend tests for AI and Command cells with existing output, empty output, streamed updates, completion, and interruption scenarios; verify `yarn test` passes.
- [x] 3.2 Verify persistence and copy paths remain free of indicator characters by running the document/selection-copy test suites and checking serialized snapshots contain only actual cell output.
- [x] 3.3 Run the project validation/build command (`yarn build` or the repository's documented equivalent) and confirm the extension bundle includes the updated rendering and styles without TypeScript or lint errors.
