import type { ChatBlock, WorkspaceMode } from './protocol';

export type CellKind = WorkspaceMode;
export type CellStatus = 'idle' | 'running' | 'done' | 'interrupted';
export type EditorMode = 'command' | 'edit';

export interface WorkspaceCell {
  id: string;
  kind: CellKind;
  source: string;
  output: string;
  blocks: ChatBlock[];
  status: CellStatus;
  executionCount: number | null;
  outputCollapsed: boolean;
}

let cellCounter = 0;
let executionCounter = 0;

export function restoreCounters(cells: WorkspaceCell[]): void {
  cells.forEach(cell => {
    const match = /^cell-(\d+)$/.exec(cell.id);
    if (match) {
      cellCounter = Math.max(cellCounter, Number(match[1]));
    }
    if (typeof cell.executionCount === 'number') {
      executionCounter = Math.max(executionCounter, cell.executionCount);
    }
  });
}

export function createWorkspaceCell(
  kind: CellKind = 'ai',
  source = ''
): WorkspaceCell {
  return {
    id: `cell-${++cellCounter}`,
    kind,
    source,
    output: '',
    blocks: [],
    status: 'idle',
    executionCount: null,
    outputCollapsed: false
  };
}

export class WorkspaceNotebook {
  cells: WorkspaceCell[] = [createWorkspaceCell('ai')];
  active = 0;
  mode: EditorMode = 'edit';
  insertKind: CellKind = 'ai';

  get current(): WorkspaceCell {
    if (this.empty) {
      throw new Error('Workspace notebook has no cells.');
    }
    return this.cells[this.active];
  }

  get empty(): boolean {
    return this.cells.length === 0;
  }

  select(index: number): void {
    if (this.cells.length === 0) {
      this.active = 0;
      return;
    }
    if (index < 0 || index >= this.cells.length) return;
    this.active = index;
    this.insertKind = this.current.kind;
  }

  setKind(kind: CellKind): void {
    this.insertKind = kind;
    if (this.empty) return;
    const cell = this.current;
    if (cell.kind === kind) return;
    cell.kind = kind;
    cell.output = '';
    cell.blocks = [];
    cell.status = 'idle';
    cell.executionCount = null;
    cell.outputCollapsed = false;
  }

  toggleKind(): CellKind {
    if (this.empty) {
      this.insertKind = this.insertKind === 'ai' ? 'command' : 'ai';
      return this.insertKind;
    }
    const kind = this.current.kind === 'ai' ? 'command' : 'ai';
    this.setKind(kind);
    return kind;
  }

  insertAbove(kind: CellKind = this.insertKind): WorkspaceCell {
    if (this.empty) {
      return this.appendCell(kind);
    }
    const cell = createWorkspaceCell(kind);
    this.cells.splice(this.active, 0, cell);
    this.mode = 'edit';
    this.insertKind = kind;
    return cell;
  }

  insertBelow(kind: CellKind = this.insertKind): WorkspaceCell {
    if (this.empty) {
      return this.appendCell(kind);
    }
    const cell = createWorkspaceCell(kind);
    this.cells.splice(this.active + 1, 0, cell);
    this.active += 1;
    this.mode = 'edit';
    this.insertKind = kind;
    return cell;
  }

  deleteActive(): boolean {
    if (this.empty) {
      return false;
    }
    const cell = this.current;
    if (cell.status === 'running') {
      return false;
    }
    const kind = cell.kind;
    const index = this.active;
    this.cells.splice(index, 1);
    this.mode = 'command';
    this.insertKind = kind;
    if (this.cells.length === 0) {
      this.active = 0;
      return true;
    }
    this.active = Math.min(index, this.cells.length - 1);
    this.insertKind = this.current.kind;
    return true;
  }

  appendCell(kind: CellKind = this.insertKind): WorkspaceCell {
    const cell = createWorkspaceCell(kind);
    this.cells.push(cell);
    this.active = this.cells.length - 1;
    this.mode = 'edit';
    this.insertKind = kind;
    return cell;
  }

  enterEdit(): void {
    this.mode = 'edit';
  }

  exitEdit(): void {
    this.mode = 'command';
  }

  setSource(source: string): void {
    if (this.empty) return;
    this.current.source = source;
  }

  beginRun(): WorkspaceCell {
    if (this.empty) {
      throw new Error('Workspace notebook has no cells.');
    }
    const cell = this.current;
    cell.status = 'running';
    cell.output = '';
    cell.blocks = [];
    cell.executionCount = ++executionCounter;
    cell.outputCollapsed = false;
    return cell;
  }

  finishRun(output: string, status: CellStatus = 'done'): void {
    if (this.empty) return;
    this.current.output = output;
    this.current.status = status;
  }

  setBlocks(blocks: ChatBlock[]): void {
    if (this.empty) return;
    this.current.blocks = blocks;
  }

  busy(): boolean {
    return this.cells.some(cell => cell.status === 'running');
  }

  toggleOutputCollapsed(index = this.active): void {
    const cell = this.cells[index];
    if (!cell) return;
    cell.outputCollapsed = !cell.outputCollapsed;
  }

  ensureTrailingInput(): WorkspaceCell {
    if (this.empty) {
      return this.appendCell();
    }
    const last = this.cells[this.cells.length - 1];
    if (
      last.status === 'idle' &&
      last.source === '' &&
      last.output === '' &&
      last.blocks.length === 0
    ) {
      return last;
    }
    const cell = createWorkspaceCell(last.kind);
    this.cells.push(cell);
    return cell;
  }

  advanceAfterRun(): WorkspaceCell {
    if (this.active === this.cells.length - 1) {
      this.ensureTrailingInput();
    }
    if (this.active < this.cells.length - 1) {
      this.active += 1;
    }
    this.mode = 'edit';
    this.insertKind = this.current.kind;
    return this.current;
  }
}

/** @deprecated Use WorkspaceNotebook */
export const CommandNotebook = WorkspaceNotebook;
export const createCommandCell = createWorkspaceCell;
export type CommandCell = WorkspaceCell;
