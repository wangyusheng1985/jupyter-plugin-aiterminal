import type { ChatBlock } from './protocol';
import {
  createTurn,
  deriveTurn,
  restoreTurn,
  setTurnStatus,
  toPersistedTurn,
  type ChatTurn,
  type PersistedTurn
} from './turn';
import {
  createWorkspaceCell,
  isShellEscapeSource,
  type AgentContextBridge,
  type CellKind,
  type CellStatus,
  type WorkspaceCell,
  type WorkspaceNotebook
} from './notebook';

export const AGENT_WORKSPACE_VERSION = 5;
export const AGENT_FILE_TYPE = 'agent-workspace';
export const AGENT_FILE_EXT = '.agentnb';
export const AGENT_FACTORY = 'Agent Workspace';
export const AGENT_MODEL_NAME = 'agent-workspace';

/**
 * Thrown when a document was written by a newer workspace format than this
 * build understands. Parsing and restoring reject it outright instead of
 * normalizing it down to {@link AGENT_WORKSPACE_VERSION}: a best-effort rebuild
 * would silently drop unknown fields, and any later save would overwrite the
 * newer document with the lossy version.
 */
export class UnsupportedWorkspaceVersionError extends Error {
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number) {
    super(
      `Workspace version ${foundVersion} is newer than supported version ${AGENT_WORKSPACE_VERSION}.`
    );
    this.name = 'UnsupportedWorkspaceVersionError';
    this.foundVersion = foundVersion;
    this.supportedVersion = AGENT_WORKSPACE_VERSION;
  }
}

/** Durable engine that owns an agent session reference. */
export type AgentSessionEngine = 'dsh';

/**
 * Durable, serializable reference to an agent session. This is deliberately
 * separate from {@link WorkspaceNotebook.agentSessionId}, which carries the
 * legacy Pi/Claude UUID. It stores only the engine discriminator and the
 * engine-issued session id; it never stores a runtime id, live connection, or
 * "running" state, because those are transient and must not be resumed.
 */
export interface AgentSessionReference {
  engine: AgentSessionEngine;
  sessionId: string;
}

export interface CellSnapshot {
  id: string;
  kind: CellKind;
  source: string;
  output: string;
  blocks: ChatBlock[];
  turn: PersistedTurn | null;
  status: CellStatus;
  executionCount: number | null;
  outputCollapsed: boolean;
  agentContextGeneration: number | null;
}

export interface WorkspaceSnapshot {
  version: number;
  active: number;
  agentSessionId: string | null;
  sessionReference: AgentSessionReference | null;
  agentContextGeneration: number;
  agentContextBridges: AgentContextBridge[];
  cells: CellSnapshot[];
}

export function snapshotFromNotebook(
  notebook: WorkspaceNotebook
): WorkspaceSnapshot {
  return {
    version: AGENT_WORKSPACE_VERSION,
    active: notebook.active,
    agentSessionId: normalizeAgentSessionId(notebook.agentSessionId),
    sessionReference: getAgentSessionReference(notebook),
    agentContextGeneration: normalizeGeneration(
      notebook.agentContextGeneration
    ),
    agentContextBridges: normalizeContextBridges(
      notebook.agentContextBridges,
      notebook.cells,
      normalizeGeneration(notebook.agentContextGeneration)
    ),
    cells: notebook.cells.map(snapshotFromCell)
  };
}

export function serializeNotebook(notebook: WorkspaceNotebook): string {
  return `${JSON.stringify(snapshotFromNotebook(notebook), null, 2)}\n`;
}

export function parseWorkspaceSnapshot(text: string): WorkspaceSnapshot {
  const trimmed = text.trim();
  if (!trimmed) {
    return emptySnapshot();
  }
  let value: Partial<WorkspaceSnapshot> | null;
  try {
    value = JSON.parse(trimmed) as Partial<WorkspaceSnapshot> | null;
  } catch {
    // Unreadable JSON yields an empty document (historical behavior).
    return emptySnapshot();
  }
  // Outside the JSON try/catch: a newer-format document must surface as a
  // typed rejection, never as an empty snapshot that would be saved over it.
  return normalizeSnapshot(value);
}

/**
 * Restores a notebook in place. Parsing happens first, so a document from a
 * newer workspace format throws {@link UnsupportedWorkspaceVersionError} while
 * the target notebook and its session reference remain untouched.
 */
export function restoreNotebook(
  notebook: WorkspaceNotebook,
  text: string
): void {
  const snapshot = parseWorkspaceSnapshot(text);
  notebook.cells = snapshot.cells.map(cellFromSnapshot);
  notebook.agentSessionId = snapshot.agentSessionId;
  if (snapshot.sessionReference) {
    sessionReferences.set(notebook, { ...snapshot.sessionReference });
  } else {
    sessionReferences.delete(notebook);
  }
  notebook.agentContextGeneration = snapshot.agentContextGeneration;
  notebook.agentContextBridges = snapshot.agentContextBridges.map(bridge => ({
    generation: bridge.generation,
    cellIds: [...bridge.cellIds]
  }));
  if (!notebook.cells.length) {
    notebook.active = 0;
    notebook.mode = 'command';
    notebook.restoreCounters(notebook.cells);
    return;
  }
  notebook.active = clamp(snapshot.active, 0, notebook.cells.length - 1);
  notebook.mode = 'edit';
  notebook.restoreCounters(notebook.cells);
}

function snapshotFromCell(cell: WorkspaceCell): CellSnapshot {
  const input = normalizeInput(cell.source, cell.kind);
  return {
    id: cell.id,
    kind: input.kind,
    source: input.source,
    output: cell.output,
    blocks: cell.blocks,
    turn: cell.turn ? toPersistedTurn(cell.turn) : null,
    status: persistStatus(cell.status),
    executionCount: cell.executionCount,
    outputCollapsed: Boolean(cell.outputCollapsed),
    agentContextGeneration:
      input.kind === 'ai'
        ? normalizeNullableGeneration(cell.agentContextGeneration)
        : null
  };
}

function cellFromSnapshot(cell: CellSnapshot): WorkspaceCell {
  const input = normalizeInput(cell.source, cell.kind);
  const blocks = Array.isArray(cell.blocks) ? cell.blocks : [];
  const status = persistStatus(cell.status);
  const restoredTurn = restoreTurn(cell.turn);
  return {
    id: cell.id,
    kind: input.kind,
    source: input.source,
    output: cell.output,
    blocks,
    turn: restoredTurn
      ? deriveTurn(restoredTurn, blocks)
      : legacyTurn(cell.id, input.kind, status, blocks),
    status,
    executionCount:
      typeof cell.executionCount === 'number' ? cell.executionCount : null,
    outputCollapsed: Boolean(cell.outputCollapsed),
    agentContextGeneration:
      input.kind === 'ai'
        ? normalizeNullableGeneration(cell.agentContextGeneration)
        : null
  };
}

function normalizeSnapshot(
  value: Partial<WorkspaceSnapshot> | null | undefined
): WorkspaceSnapshot {
  if (
    value &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version > AGENT_WORKSPACE_VERSION
  ) {
    throw new UnsupportedWorkspaceVersionError(value.version);
  }
  if (!Array.isArray(value?.cells)) {
    return emptySnapshot();
  }
  const sourceVersion = normalizeGeneration(value.version);
  const agentSessionId = normalizeAgentSessionId(value.agentSessionId);
  // A reference is only honored from version 5 onward; legacy V1-V4 files never
  // persisted one, so an incidental field can never be resurrected as a DSH
  // resume. Newer versions are rejected above, so this only ever reads the
  // current format; unknown session engines still resolve to none.
  const sessionReference =
    sourceVersion >= 5
      ? normalizeAgentSessionReference(value.sessionReference)
      : null;
  const cells = value.cells.map(normalizeCell);
  if (sourceVersion < 4) {
    migrateLegacyContext(cells, sourceVersion, agentSessionId);
  }
  const agentContextGeneration =
    sourceVersion >= 4 ? normalizeGeneration(value.agentContextGeneration) : 0;
  cells.forEach(cell => {
    if (
      cell.agentContextGeneration !== null &&
      cell.agentContextGeneration > agentContextGeneration
    ) {
      cell.agentContextGeneration = null;
    }
  });
  let agentContextBridges =
    sourceVersion >= 4
      ? normalizeContextBridges(
          value.agentContextBridges,
          cells,
          agentContextGeneration
        )
      : [];
  if (!agentSessionId) {
    cells.forEach(cell => {
      if (cell.agentContextGeneration === agentContextGeneration) {
        cell.agentContextGeneration = null;
      }
    });
    agentContextBridges = agentContextBridges.filter(
      bridge =>
        bridge.generation !== agentContextGeneration ||
        bridge.cellIds.length === 0
    );
  }
  return {
    version: AGENT_WORKSPACE_VERSION,
    active: typeof value?.active === 'number' ? value.active : 0,
    agentSessionId,
    sessionReference,
    agentContextGeneration,
    agentContextBridges,
    cells
  };
}

function normalizeCell(cell: Partial<CellSnapshot>): CellSnapshot {
  const input = normalizeInput(
    typeof cell.source === 'string' ? cell.source : '',
    cell.kind
  );
  return {
    id:
      typeof cell.id === 'string' && cell.id
        ? cell.id
        : createWorkspaceCell().id,
    kind: input.kind,
    source: input.source,
    output: typeof cell.output === 'string' ? cell.output : '',
    blocks: Array.isArray(cell.blocks) ? cell.blocks : [],
    turn: normalizeTurn(cell.turn),
    status: persistStatus(cell.status),
    executionCount:
      typeof cell.executionCount === 'number' ? cell.executionCount : null,
    outputCollapsed: Boolean(cell.outputCollapsed),
    agentContextGeneration:
      input.kind === 'ai'
        ? normalizeNullableGeneration(cell.agentContextGeneration)
        : null
  };
}

function normalizeInput(
  source: string,
  kind: unknown
): { kind: CellKind; source: string } {
  const shell = kind === 'command' || isShellEscapeSource(source);
  if (!shell) {
    return { kind: 'ai', source };
  }
  return {
    kind: 'command',
    source: isShellEscapeSource(source) ? source : `!${source}`
  };
}

function emptySnapshot(): WorkspaceSnapshot {
  const cell = createWorkspaceCell('ai');
  return {
    version: AGENT_WORKSPACE_VERSION,
    active: 0,
    agentSessionId: null,
    sessionReference: null,
    agentContextGeneration: 0,
    agentContextBridges: [],
    cells: [snapshotFromCell(cell)]
  };
}

function migrateLegacyContext(
  cells: CellSnapshot[],
  sourceVersion: number,
  agentSessionId: string | null
): void {
  cells.forEach(cell => {
    cell.agentContextGeneration = null;
  });
  if (sourceVersion !== 3 || !agentSessionId) return;
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index];
    if (
      cell.kind === 'ai' &&
      cell.status === 'done' &&
      (!cell.turn || (cell.turn.status === 'done' && !cell.turn.resultIsError))
    ) {
      cell.agentContextGeneration = 0;
      return;
    }
  }
}

function normalizeContextBridges(
  value: unknown,
  cells: readonly Pick<
    CellSnapshot | WorkspaceCell,
    'id' | 'kind' | 'status' | 'source' | 'agentContextGeneration'
  >[],
  activeGeneration: number
): AgentContextBridge[] {
  if (!Array.isArray(value)) return [];
  const eligible = new Map(
    cells
      .filter(
        cell =>
          cell.kind === 'ai' &&
          cell.status !== 'idle' &&
          Boolean(cell.source.trim())
      )
      .map(cell => [cell.id, cell])
  );
  const order = new Map(cells.map((cell, index) => [cell.id, index]));
  const merged = new Map<number, Set<string>>();
  value.forEach(candidate => {
    if (!candidate || typeof candidate !== 'object') return;
    const bridge = candidate as Partial<AgentContextBridge>;
    const generation = normalizeNullableGeneration(bridge.generation);
    if (
      generation === null ||
      generation > activeGeneration ||
      !Array.isArray(bridge.cellIds)
    ) {
      return;
    }
    const ids = merged.get(generation) ?? new Set<string>();
    let validRecord = bridge.cellIds.length === 0;
    bridge.cellIds.forEach(id => {
      if (typeof id !== 'string') return;
      const cell = eligible.get(id);
      if (!cell || cell.agentContextGeneration === generation) return;
      validRecord = true;
      ids.add(id);
    });
    if (validRecord) merged.set(generation, ids);
  });
  return [...merged.entries()]
    .sort(([left], [right]) => left - right)
    .map(([generation, cellIds]) => ({
      generation,
      cellIds: [...cellIds].sort(
        (left, right) =>
          (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      )
    }));
}

function normalizeGeneration(value: unknown): number {
  return normalizeNullableGeneration(value) ?? 0;
}

function normalizeNullableGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function persistStatus(status: CellStatus | undefined): CellStatus {
  if (status === 'done' || status === 'interrupted' || status === 'idle') {
    return status;
  }
  if (status === 'running') {
    return 'interrupted';
  }
  if (status === 'queued') {
    return 'idle';
  }
  return 'idle';
}

function normalizeTurn(value: unknown): PersistedTurn | null {
  if (!value || typeof value !== 'object') return null;
  const restored = restoreTurn(value as PersistedTurn);
  return restored ? toPersistedTurn(restored) : null;
}

function legacyTurn(
  cellId: string,
  kind: CellKind,
  status: CellStatus,
  blocks: ChatBlock[]
): ChatTurn | null {
  if (kind !== 'ai' || !blocks.length) return null;
  const turnStatus =
    status === 'running'
      ? 'interrupted'
      : status === 'interrupted'
        ? 'interrupted'
        : 'done';
  return setTurnStatus(createTurn(`legacy-${cellId}`), turnStatus, blocks);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// The notebook model intentionally holds only display state. The serializable
// agent session reference is stored here, keyed to its notebook instance, so
// the document can round-trip it without leaking engine/runtime details into
// the notebook model or adding ad-hoc properties to it.
const sessionReferences = new WeakMap<
  WorkspaceNotebook,
  AgentSessionReference
>();

/** Store (or clear) the durable agent session reference for a notebook. */
export function setAgentSessionReference(
  notebook: WorkspaceNotebook,
  reference: AgentSessionReference | null
): void {
  const normalized = normalizeAgentSessionReference(reference);
  if (normalized) {
    sessionReferences.set(notebook, normalized);
  } else {
    sessionReferences.delete(notebook);
  }
}

/** Returns the stored reference (a copy) regardless of engine, or null. */
export function getAgentSessionReference(
  notebook: WorkspaceNotebook
): AgentSessionReference | null {
  const reference = sessionReferences.get(notebook);
  return reference ? { ...reference } : null;
}

/**
 * Returns a resume-ready DSH reference for wiring into a live session. Returns
 * null when the document is legacy/unbound or carries anything but a valid
 * `dsh` reference; callers must not fall back to the legacy `agentSessionId`.
 */
export function getResumableDshSessionReference(
  notebook: WorkspaceNotebook
): AgentSessionReference | null {
  const reference = getAgentSessionReference(notebook);
  return reference && reference.engine === 'dsh' ? reference : null;
}

/**
 * True when the value contains an ASCII control character (U+0000..U+001F) or
 * DEL (U+007F). Checked per code unit because ESLint's `no-control-regex`
 * rejects the equivalent character class in a regular expression.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates an agent session reference. DSH session ids are opaque SDK strings,
 * not UUIDs, so only clearly unsafe values are rejected: empty or oversized
 * ids, control characters, surrounding whitespace, and path-like values that
 * could escape a directory. Unknown engines yield no reference and never fall
 * back to the legacy `agentSessionId`.
 */
export function normalizeAgentSessionReference(
  value: unknown
): AgentSessionReference | null {
  if (!value || typeof value !== 'object') return null;
  const reference = value as Partial<AgentSessionReference>;
  if (reference.engine !== 'dsh') return null;
  if (typeof reference.sessionId !== 'string') return null;
  const sessionId = reference.sessionId;
  if (sessionId.length === 0 || sessionId.length > 256) return null;
  if (sessionId !== sessionId.trim()) return null;
  if (hasControlCharacter(sessionId)) return null;
  if (/[/\\]/.test(sessionId) || sessionId.includes('..')) return null;
  return { engine: 'dsh', sessionId };
}

export function normalizeAgentSessionId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 36) return null;
  const normalized = value.toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : null;
}
