import type { ChatBlock, WorkspaceMode } from './protocol';
import type { HistoryBridgeCapsule } from './history-bridge';
import type { ChatTurn } from './turn';

export type CellKind = WorkspaceMode;
export type CellStatus = 'idle' | 'queued' | 'running' | 'done' | 'interrupted';
export type EditorMode = 'command' | 'edit';

export interface RunRequest {
  id: string;
  cellId: string;
  kind: CellKind;
  source: string;
  executionSource: string;
  advance: boolean;
  historyBridge?: HistoryBridgeCapsule;
  agentContextGeneration: number | null;
  contextCommitted: boolean;
}

export interface AgentContextBridge {
  generation: number;
  cellIds: string[];
}

export interface WorkspaceCell {
  id: string;
  kind: CellKind;
  source: string;
  output: string;
  blocks: ChatBlock[];
  turn: ChatTurn | null;
  status: CellStatus;
  executionCount: number | null;
  outputCollapsed: boolean;
  agentContextGeneration: number | null;
}

let cellCounter = 0;
let executionCounter = 0;
let runCounter = 0;

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
    turn: null,
    status: 'idle',
    executionCount: null,
    outputCollapsed: false,
    agentContextGeneration: null
  };
}

export function isShellEscapeSource(source: string): boolean {
  return /^\s*!/.test(source);
}

function executionSource(source: string): string {
  const input = source.trim();
  return isShellEscapeSource(input) ? input.slice(1).trim() : input;
}

export class WorkspaceNotebook {
  cells: WorkspaceCell[] = [createWorkspaceCell('ai')];
  active = 0;
  mode: EditorMode = 'edit';
  agentSessionId: string | null = null;
  agentContextGeneration = 0;
  agentContextBridges: AgentContextBridge[] = [];
  private runQueue: RunRequest[] = [];
  private activeRequest: RunRequest | null = null;

  get activeRun(): RunRequest | null {
    return this.activeRequest;
  }

  get queuedRuns(): readonly RunRequest[] {
    return this.runQueue;
  }

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
  }

  insertAbove(): WorkspaceCell {
    if (this.empty) {
      return this.appendCell();
    }
    const cell = createWorkspaceCell();
    this.cells.splice(this.active, 0, cell);
    this.mode = 'edit';
    return cell;
  }

  insertBelow(): WorkspaceCell {
    if (this.empty) {
      return this.appendCell();
    }
    const cell = createWorkspaceCell();
    this.cells.splice(this.active + 1, 0, cell);
    this.active += 1;
    this.mode = 'edit';
    return cell;
  }

  prepareRetry(index = this.active): WorkspaceCell | null {
    const source = this.cells[index];
    if (!source || !source.source.trim()) return null;
    const retry = createWorkspaceCell(source.kind, source.source);
    this.cells.splice(index + 1, 0, retry);
    this.active = index + 1;
    this.mode = 'edit';
    return retry;
  }

  deleteActive(): boolean {
    if (this.empty) {
      return false;
    }
    const cell = this.current;
    if (this.activeRequest?.cellId === cell.id) {
      return false;
    }
    this.cancelQueuedRuns(cell.id);
    const index = this.active;
    this.cells.splice(index, 1);
    this.mode = 'command';
    if (this.cells.length === 0) {
      this.active = 0;
      return true;
    }
    this.active = Math.min(index, this.cells.length - 1);
    return true;
  }

  appendCell(): WorkspaceCell {
    const cell = createWorkspaceCell();
    this.cells.push(cell);
    this.active = this.cells.length - 1;
    this.mode = 'edit';
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

  enqueueRun(
    index = this.active,
    advance = false,
    historyBridge?: HistoryBridgeCapsule
  ): RunRequest | null {
    const cell = this.cells[index];
    const source = cell?.source.trim();
    if (!cell || !source) return null;
    const kind: CellKind = isShellEscapeSource(source) ? 'command' : 'ai';
    const executableSource = executionSource(source);
    if (!executableSource) return null;
    const request: RunRequest = {
      id: `run-${++runCounter}`,
      cellId: cell.id,
      kind,
      source,
      executionSource: executableSource,
      advance,
      ...(historyBridge ? { historyBridge } : {}),
      agentContextGeneration:
        kind === 'ai' ? this.agentContextGeneration : null,
      contextCommitted: kind !== 'ai'
    };
    if (kind === 'command') cell.agentContextGeneration = null;
    this.runQueue.push(request);
    if (this.activeRequest?.cellId !== cell.id) {
      cell.status = 'queued';
    }
    return request;
  }

  promoteNextRun(): RunRequest | null {
    if (this.activeRequest) return null;
    while (this.runQueue.length) {
      const request = this.runQueue.shift() as RunRequest;
      const cell = this.cells.find(
        candidate => candidate.id === request.cellId
      );
      if (!cell) continue;
      this.activeRequest = request;
      cell.kind = request.kind;
      cell.status = 'running';
      cell.output = '';
      cell.blocks = [];
      cell.turn = null;
      cell.executionCount = ++executionCounter;
      cell.outputCollapsed = false;
      return request;
    }
    return null;
  }

  finishRun(
    requestId: string,
    output: string,
    status: CellStatus = 'done'
  ): boolean {
    if (this.activeRequest?.id !== requestId) return false;
    const cell = this.cells.find(
      candidate => candidate.id === this.activeRequest?.cellId
    );
    if (cell) {
      cell.output = output;
      cell.status = status;
    }
    this.activeRequest = null;
    return true;
  }

  setBlocks(blocks: ChatBlock[]): void {
    if (this.empty) return;
    this.current.blocks = blocks;
  }

  setTurn(turn: ChatTurn | null): void {
    if (this.empty) return;
    this.current.turn = turn;
  }

  updateTurn(cellId: string, update: (turn: ChatTurn) => ChatTurn): boolean {
    const cell = this.cells.find(candidate => candidate.id === cellId);
    if (!cell?.turn) return false;
    cell.turn = update(cell.turn);
    return true;
  }

  busy(): boolean {
    return this.activeRequest !== null;
  }

  clearRuns(): void {
    this.runQueue = [];
    this.activeRequest = null;
    this.cells.forEach(cell => {
      if (cell.status === 'queued') {
        cell.status = 'idle';
      } else if (cell.status === 'running') {
        cell.status = 'interrupted';
      }
    });
  }

  startNewAgentContext(cellIds: string[] | null = []): number {
    this.agentContextGeneration += 1;
    this.agentSessionId = null;
    if (cellIds !== null) {
      this.agentContextBridges.push({
        generation: this.agentContextGeneration,
        cellIds: [...cellIds]
      });
    }
    return this.agentContextGeneration;
  }

  setAgentContextBridge(
    cellIds: string[],
    generation = this.agentContextGeneration
  ): void {
    this.agentContextBridges = this.agentContextBridges.filter(
      bridge => bridge.generation !== generation
    );
    this.agentContextBridges.push({
      generation,
      cellIds: [...cellIds]
    });
  }

  commitRunContext(requestId: string): boolean {
    const request = this.activeRequest;
    if (
      !request ||
      request.id !== requestId ||
      request.kind !== 'ai' ||
      request.contextCommitted ||
      request.agentContextGeneration === null
    ) {
      return false;
    }
    const cell = this.cells.find(candidate => candidate.id === request.cellId);
    if (!cell) return false;
    cell.agentContextGeneration = request.agentContextGeneration;
    if (request.historyBridge) {
      this.setAgentContextBridge(
        request.historyBridge.turns.map(turn => turn.cellId),
        request.agentContextGeneration
      );
    }
    request.contextCommitted = true;
    return true;
  }

  cancelQueuedRuns(cellId: string): void {
    this.runQueue = this.runQueue.filter(request => request.cellId !== cellId);
    if (this.activeRequest?.cellId === cellId) return;
    const cell = this.cells.find(candidate => candidate.id === cellId);
    if (cell?.status === 'queued') {
      cell.status = 'idle';
    }
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
    const cell = createWorkspaceCell();
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
    return this.current;
  }
}

/** @deprecated Use WorkspaceNotebook */
export const CommandNotebook = WorkspaceNotebook;
export const createCommandCell = createWorkspaceCell;
export type CommandCell = WorkspaceCell;
