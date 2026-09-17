import type { ChatBlock } from './protocol';
import {
  createWorkspaceCell,
  isShellEscapeSource,
  restoreCounters,
  type CellKind,
  type CellStatus,
  type WorkspaceCell,
  type WorkspaceNotebook
} from './notebook';

export const AGENT_WORKSPACE_VERSION = 1;
export const AGENT_FILE_TYPE = 'agent-workspace';
export const AGENT_FILE_EXT = '.agentnb';
export const AGENT_FACTORY = 'Agent Workspace';
export const AGENT_MODEL_NAME = 'agent-workspace';

export interface CellSnapshot {
  id: string;
  kind: CellKind;
  source: string;
  output: string;
  blocks: ChatBlock[];
  status: CellStatus;
  executionCount: number | null;
  outputCollapsed: boolean;
}

export interface WorkspaceSnapshot {
  version: number;
  active: number;
  cells: CellSnapshot[];
}

export function snapshotFromNotebook(
  notebook: WorkspaceNotebook
): WorkspaceSnapshot {
  return {
    version: AGENT_WORKSPACE_VERSION,
    active: notebook.active,
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
  try {
    return normalizeSnapshot(JSON.parse(trimmed) as Partial<WorkspaceSnapshot>);
  } catch {
    return emptySnapshot();
  }
}

export function restoreNotebook(
  notebook: WorkspaceNotebook,
  text: string
): void {
  const snapshot = parseWorkspaceSnapshot(text);
  notebook.cells = snapshot.cells.map(cellFromSnapshot);
  if (!notebook.cells.length) {
    notebook.active = 0;
    notebook.mode = 'command';
    restoreCounters(notebook.cells);
    return;
  }
  notebook.active = clamp(snapshot.active, 0, notebook.cells.length - 1);
  notebook.mode = 'edit';
  restoreCounters(notebook.cells);
}

function snapshotFromCell(cell: WorkspaceCell): CellSnapshot {
  const input = normalizeInput(cell.source, cell.kind);
  return {
    id: cell.id,
    kind: input.kind,
    source: input.source,
    output: cell.output,
    blocks: cell.blocks,
    status: persistStatus(cell.status),
    executionCount: cell.executionCount,
    outputCollapsed: Boolean(cell.outputCollapsed)
  };
}

function cellFromSnapshot(cell: CellSnapshot): WorkspaceCell {
  const input = normalizeInput(cell.source, cell.kind);
  return {
    id: cell.id,
    kind: input.kind,
    source: input.source,
    output: cell.output,
    blocks: Array.isArray(cell.blocks) ? cell.blocks : [],
    status: persistStatus(cell.status),
    executionCount:
      typeof cell.executionCount === 'number' ? cell.executionCount : null,
    outputCollapsed: Boolean(cell.outputCollapsed)
  };
}

function normalizeSnapshot(
  value: Partial<WorkspaceSnapshot> | null | undefined
): WorkspaceSnapshot {
  if (!Array.isArray(value?.cells)) {
    return emptySnapshot();
  }
  return {
    version: AGENT_WORKSPACE_VERSION,
    active: typeof value?.active === 'number' ? value.active : 0,
    cells: value.cells.map(normalizeCell)
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
    status: persistStatus(cell.status),
    executionCount:
      typeof cell.executionCount === 'number' ? cell.executionCount : null,
    outputCollapsed: Boolean(cell.outputCollapsed)
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
    cells: [snapshotFromCell(cell)]
  };
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

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
