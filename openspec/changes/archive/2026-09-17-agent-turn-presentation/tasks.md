## 1. Event Contract

- [x] 1.1 Extend the frontend Agent event and client-message types with `turnId`, thinking activities, tool timing/size metadata, result metrics, and diagnostic metadata; verify the new contract with `jlpm test protocol.spec.ts`
- [x] 1.2 Update the Python event bridge to emit thinking state without raw reasoning, measure tool duration and output size, and expose available `ResultMessage` metrics/errors; verify with `pytest tests/test_agent_events.py`
- [x] 1.3 Carry the active cell's Turn identifier through workspace submission, session messages, and server event emission; verify queued and active cells cannot receive each other's events with focused session/workspace tests
- [x] 1.4 Coalesce streamed assistant text by message identity and prevent a final runtime result from rendering as a duplicate assistant activity; verify duplicate, empty, differing, and error-result cases with protocol tests

## 2. Turn Model And Presentation Logic

- [x] 2.1 Add the Turn domain types for outcome, timeline activities, diagnostics, changes, metrics, status, and disclosure state; verify typecheck rejects incomplete runtime states
- [x] 2.2 Implement a Turn assembler that reduces server events into the Turn model while retaining the raw `blocks` evidence ledger; verify text, thinking, tool, install, denied, error, and result event sequences
- [x] 2.3 Implement deterministic tool presenters for `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`, and unknown tools with bounded preview and raw-detail metadata; verify each presenter with representative inputs and outputs
- [x] 2.4 Derive merged file Changes and actionable Diagnostics from Turn activities, including repeated edits and failed tools; verify merge, status, and no-duplicate behavior
- [x] 2.5 Implement outcome resolution using runtime result, final assistant text, final meaningful tool output, and failure diagnostic fallbacks; verify every fallback and successful-result deduplication scenario
- [x] 2.6 Implement automatic, explicitly expanded, and explicitly collapsed trace resolution, plus per-activity and long-outcome expansion state; verify user choices override automatic folding and reset on rerun

## 3. Turn Rendering And Interaction

- [x] 3.1 Replace the AI-cell block loop with the three-layer Turn renderer for Outcome, actionable summaries, and Activity trace; verify completed turns show the outcome before the collapsed trace
- [x] 3.2 Render the compact trace summary with activity count, duration, changed-file count, and available metrics while omitting absent values; verify partial and complete metric combinations
- [x] 3.3 Render activity rows with status, deterministic summary, step disclosure, bounded input/output preview, and explicit complete-output disclosure; verify the full DOM is not created in collapsed or preview states
- [x] 3.4 Implement the running presentation window so the newest activity remains visible, older rows are compact, and the running indicator stays at the output tail; verify streaming updates, long traces, completion, and interruption
- [x] 3.5 Preserve user-expanded activity and trace state during event updates, including focus and scroll position; verify with focused DOM interaction tests
- [x] 3.6 Make Turn controls keyboard accessible with real buttons, `aria-expanded`, Enter/Space activation, and cell-selection side-effect prevention; verify with keyboard and assistive-state DOM tests
- [x] 3.7 Integrate the Turn renderer with the existing cell output collapser so the whole result remains bounded and scrollable while nested disclosure state is preserved; verify compact and expanded cell states
- [x] 3.8 Add Focus View and evidence styles using JupyterLab theme tokens, responsive summary tracks, wrapping for long content, and reduced-motion behavior; verify with `jlpm lint`, `jlpm typecheck`, and narrow/desktop visual checks

## 4. Persistence And Migration

- [x] 4.1 Add version 2 snapshot support with an optional Turn overlay while retaining the existing raw `blocks` array; verify save/load round trips outcome, metrics, changes, and disclosure state
- [x] 4.2 Migrate version 1 flat-block documents into the Turn presentation without dropping text, tool, install, denied, or error content; verify with representative v1 fixtures and unknown legacy blocks
- [x] 4.3 Persist trace, activity, and outcome disclosure choices and restore them after reload; verify rerunning a cell creates a new `auto` Turn instead of inheriting prior choices
- [x] 4.4 Preserve partial Turn evidence when a running workspace is saved and restored as interrupted; verify no running animation or active request is restored
- [x] 4.5 Keep version 1 compatibility expectations documented in snapshot tests, including raw evidence remaining readable if the document is opened by an older plugin

## 5. Integration And Regression Verification

- [x] 5.1 Verify AI, Command, queued, interrupted, and error turns still cooperate with the existing FIFO queue and `[*]` prompt behavior using workspace tests
- [x] 5.2 Verify input history, cell editing, selection, copy, output prompt numbering, and compact output behavior remain unchanged with the new renderer
- [x] 5.3 Run the complete automated suite with `jlpm test`, `pytest`, `jlpm typecheck`, `jlpm lint`, and `jlpm build:prod`
- [x] 5.4 Perform an end-to-end multi-step AI turn in JupyterLab and verify result visibility, trace collapse, per-step expansion, raw evidence, diagnostics, changes, reload restoration, and narrow-panel usability
