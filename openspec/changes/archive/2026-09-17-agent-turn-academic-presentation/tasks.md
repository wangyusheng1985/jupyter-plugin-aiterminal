## 1. Turn Presentation State

- [x] 1.1 Add an atomic `revealFailedActivity` Turn transition that expands the audit record and the identified failed activity without changing persisted state shape; verify with focused tests in `src/agent/turn.spec.ts`
- [x] 1.2 Extend the Turn render handlers and workspace update path with failure navigation while retaining the existing trace, activity, evidence, and outcome handlers; verify the new handler is wired without reducing existing disclosure behavior in `src/agent/workspace.spec.ts`
- [x] 1.3 Confirm rerun behavior resets the new presentation to automatic disclosure and that existing version 2 round trips remain unchanged; verify with `jlpm test turn.spec.ts document.spec.ts`

## 2. Result-First Renderer

- [x] 2.1 Replace the visible Outcome, Diagnostics, Changes, and Trace section stack with unframed outcome prose followed by one audit summary; verify renderer tests assert that separate top-level diagnostic, change, and execution sections are absent
- [x] 2.2 Render the audit summary with an independent record disclosure, available step/duration/file metrics, and an explicit failure-navigation control when failures exist; verify every metric combination and the no-failure case in `src/agent/turn-renderer.spec.ts`
- [x] 2.3 Render the expanded record as one chronological responsive row list with sequence, action, target or summary, result or status, and duration; verify repeated activity types, failed rows, and diagnostics remain associated with the correct activity
- [x] 2.4 Keep per-activity input and output behind disclosure with bounded, internally scrollable evidence in both preview and full-output states; verify collapsed rows create no raw evidence DOM and expanded rows preserve scroll state
- [x] 2.5 Preserve the newest-activity window and running indicator semantics while a Turn is running and collapse automatic records on completion; verify running, interrupted, successful completion, and explicit-expansion cases

## 3. Workspace Interaction

- [x] 3.1 Implement one-shot failure navigation that applies the Turn state change, focuses the revealed failed row, and scrolls it into view after the next render; verify pointer and keyboard activation in workspace tests
- [x] 3.2 Respect reduced-motion preferences during failure navigation and ensure the one-shot scroll target is not reapplied by later streaming updates; verify with focused DOM interaction tests
- [x] 3.3 Verify existing focus, evidence scroll, output-collapse, cell-selection, copy, and compact-output behavior still work after the renderer refactor using `src/agent/workspace.spec.ts` and `src/agent/notebook.spec.ts`

## 4. Academic Notebook Styling

- [x] 4.1 Replace section-oriented Trace and diagnostic styles with scoped outcome, audit summary, chronological row, and evidence styles using JupyterLab theme tokens; verify `jlpm lint` and `jlpm typecheck`
- [x] 4.2 Apply the intended typographic hierarchy with readable result prose, UI-font controls and metrics, code-font evidence, and tabular durations without overriding arbitrary rendered Markdown
- [x] 4.3 Implement responsive row reflow for long paths and commands, avoid horizontal overflow and nested record scrolling, and retain visible keyboard focus states; verify with light/dark, desktop, and narrow visual checks
- [x] 4.4 Preserve reduced-motion behavior for running indicators, disclosure controls, and failure navigation; verify the reduced-motion presentation remains complete without animation

## 5. Verification

- [x] 5.1 Run focused renderer, Turn, workspace, notebook, document, and protocol tests and resolve regressions caused by the renderer contract change
- [x] 5.2 Run `jlpm test`, `pytest`, `jlpm typecheck`, `jlpm lint`, and `jlpm build:prod` successfully
- [x] 5.3 In JupyterLab, verify successful, failed, running, and queued Turns; audit-record expansion; failure navigation; per-step evidence; keyboard operation; output collapse; reload restoration; and narrow, light, and dark layouts
- [x] 5.4 Confirm version 2 workspace save/load produces the academic presentation without a new snapshot migration and that version 1 or pre-change version 2 workspaces preserve all raw evidence
