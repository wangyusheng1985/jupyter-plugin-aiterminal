## Why

Users currently have to choose between AI and Command cells before typing,
even though notebook users expect one input to handle both ordinary execution
and a `!`-prefixed shell escape. The mode selector and per-cell labels add
complexity without helping the common writing flow.

## What Changes

- Treat every editable cell as one unified input whose default execution path
  is an AI instruction.
- When that input's first non-whitespace character is `!`, execute it as a
  shell command and mark it as controlled by the prefix.
- Keep the leading `!` visible in the editor, but strip it before executing the
  shell command and keep the submitted text, including `!`, in input history.
- If the user removes the leading `!`, return that input to the default AI
  instruction path.
- When a prefix-controlled Command runs with run-and-advance, keep the executed
  cell's result intact and make the next empty input start in AI mode.
- Remove the AI/Command type selector, the prompt double-click toggle, and the
  per-cell `AI`/`sh` badges.
- Normalize legacy Command cells when a workspace is restored so their source
  enters the unified input path with a visible `!` marker.
- Preserve existing queueing, history navigation, focus, and run-and-advance
  behavior.

## Capabilities

### New Capabilities

- `cell-mode-switching`: one unified editable input that defaults to AI
  instructions and treats a leading `!` as a shell escape, without exposing an
  AI/Command mode switch.

### Modified Capabilities

None.

## Impact

Affected code includes editable cell source handling, execution classification,
run-request source preparation, toolbar and prompt rendering, legacy workspace
normalization, and their tests. The server API and input-history storage format
remain compatible. New saves use the unified input source; marker state is
derived or kept ephemeral rather than requiring a new persisted document field.
