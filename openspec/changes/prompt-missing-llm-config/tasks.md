## 1. Configuration Error Contract

- [x] 1.1 Review missing-file, malformed-JSON, and incomplete-key messages in `jupyter_aiterminal/settings.py` and ensure each `code: "config"` event provides stable, secret-free guidance to **Settings → AI Terminal**; verify with the Python settings and agent-session tests.
- [x] 1.2 Preserve the configuration-error short-circuit before Agent SDK construction/querying; verify a missing-settings test confirms no model turn is started and the emitted event remains classified as `config`.

## 2. Frontend Feedback

- [x] 2.1 Update frontend session/workspace handling so a `config` error in an AI run renders an actionable, visually distinct output message naming Base URL, Model, and API Token; verify the message is visible in the cell output without inspecting logs.
- [x] 2.2 Keep configuration feedback scoped to AI cells and preserve normal Command-cell execution when LLM settings are absent; verify mixed AI/Command workspace tests cover both paths.
- [x] 2.3 Ensure a later run on a newly opened/configured session replaces the prior configuration-error state with the normal response or runtime error; verify retry/session lifecycle tests.

## 3. Presentation and Safety

- [x] 3.1 Add or adjust styling/translation strings for the configuration guidance while retaining the existing error details; verify lint/prettier checks and rendered output classes.
- [x] 3.2 Verify the guidance never includes API token values and that the error presentation does not alter persisted cell data or command output; verify serialization and selection-copy tests.

## 4. Verification

- [x] 4.1 Run the complete Python and frontend test suites (`python -m pytest -q` and `jlpm test`) and confirm all configuration-feedback scenarios pass.
- [x] 4.2 Run frontend typecheck/lint and the documented build command, confirming no protocol, TypeScript, or packaging regressions.
