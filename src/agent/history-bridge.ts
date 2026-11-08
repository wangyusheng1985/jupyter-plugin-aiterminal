import type { ChatBlock } from './protocol';
import type { AgentContextBridge, WorkspaceCell } from './notebook';

export type BackgroundTaskState =
  'running' | 'completed' | 'failed' | 'killed' | 'unknown';

export interface BackgroundTaskReference {
  cellId: string;
  taskId: string;
  outputPath: string;
  state: BackgroundTaskState;
  sourceBlockId: string;
  stateBlockId?: string;
}

export const HISTORY_BRIDGE_VERSION = 1 as const;
export const HISTORY_BRIDGE_MAX_TURNS = 8;
export const HISTORY_BRIDGE_MAX_CHARACTERS = 12_000;
const HISTORY_BRIDGE_MAX_SOURCE = 1_000;
const HISTORY_BRIDGE_MAX_OUTCOME = 2_400;
const HISTORY_BRIDGE_MAX_TASK_PATH = 1_024;

export interface HistoryBridgeTurn {
  cellId: string;
  source: string;
  status: 'done' | 'interrupted';
  outcome: string;
  taskIds: string[];
}

export interface HistoryBridgeTask {
  cellId: string;
  taskId: string;
  outputPath: string;
  state: BackgroundTaskState;
}

export interface HistoryBridgeCapsule {
  version: typeof HISTORY_BRIDGE_VERSION;
  turns: HistoryBridgeTurn[];
  tasks: HistoryBridgeTask[];
  omittedTurnCount: number;
  omittedTaskCount: number;
  truncatedFieldCount: number;
}

export type ContextMembership =
  'native' | 'bridged' | 'outside' | 'draft' | 'none';

export interface ContextMembershipEntry {
  cellId: string;
  membership: ContextMembership;
}

export interface ContextMembershipProjection {
  generation: number;
  entries: ContextMembershipEntry[];
  nativeCount: number;
  bridgedCount: number;
  outsideCount: number;
  draftCount: number;
  policyChosen: boolean;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BACKGROUND_START_PATTERN =
  /^Command running in background with ID: ([A-Za-z0-9][A-Za-z0-9_-]{0,63})\. Output is being written to: (\/[^\r\n\0]{1,4095})\. You will be notified/m;
const TASK_OUTPUT_ID_PATTERN = /<task_id>([^<>]+)<\/task_id>/;
const TASK_OUTPUT_STATE_PATTERN =
  /<status>(running|completed|failed|killed|unknown)<\/status>/;

export function backgroundTaskReferences(
  cells: readonly WorkspaceCell[]
): BackgroundTaskReference[] {
  const references = new Map<string, BackgroundTaskReference>();
  cells.forEach(cell => {
    if (cell.kind !== 'ai') return;
    cell.blocks.forEach(block => {
      const started = backgroundTaskStart(cell.id, block);
      if (started) {
        references.set(started.taskId, started);
        return;
      }
      const update = backgroundTaskUpdate(block);
      if (!update) return;
      const current = references.get(update.taskId);
      if (!current) return;
      references.set(update.taskId, {
        ...current,
        state: update.state,
        stateBlockId: block.id
      });
    });
  });
  return [...references.values()];
}

export function buildHistoryBridge(
  cells: readonly WorkspaceCell[],
  draftCellId: string
): HistoryBridgeCapsule | null {
  const draftIndex = cells.findIndex(cell => cell.id === draftCellId);
  if (draftIndex < 0) return null;
  const historyEnd = isEligibleHistoryCell(cells[draftIndex])
    ? draftIndex + 1
    : draftIndex;
  const eligible = cells.slice(0, historyEnd).filter(isEligibleHistoryCell);
  if (!eligible.length) return null;
  let omittedTurnCount = Math.max(
    0,
    eligible.length - HISTORY_BRIDGE_MAX_TURNS
  );
  const selected = eligible.slice(-HISTORY_BRIDGE_MAX_TURNS);
  let truncatedFieldCount = 0;
  const taskReferences = backgroundTaskReferences(selected);
  let tasks = taskReferences.map(reference => {
    const outputPath = truncateField(
      reference.outputPath,
      HISTORY_BRIDGE_MAX_TASK_PATH
    );
    if (outputPath.truncated) truncatedFieldCount += 1;
    return {
      cellId: reference.cellId,
      taskId: reference.taskId,
      outputPath: outputPath.value,
      state: reference.state
    } satisfies HistoryBridgeTask;
  });
  let turns = selected.map(cell => {
    const source = truncateField(cell.source.trim(), HISTORY_BRIDGE_MAX_SOURCE);
    const outcome = truncateField(
      canonicalOutcome(cell),
      HISTORY_BRIDGE_MAX_OUTCOME
    );
    if (source.truncated) truncatedFieldCount += 1;
    if (outcome.truncated) truncatedFieldCount += 1;
    return {
      cellId: cell.id,
      source: source.value,
      status: cell.status === 'interrupted' ? 'interrupted' : 'done',
      outcome: outcome.value,
      taskIds: tasks
        .filter(task => task.cellId === cell.id)
        .map(task => task.taskId)
    } satisfies HistoryBridgeTurn;
  });
  let omittedTaskCount = 0;
  let capsule = bridgeCapsule(
    turns,
    tasks,
    omittedTurnCount,
    omittedTaskCount,
    truncatedFieldCount
  );
  while (
    turns.length > 1 &&
    serializedHistoryBridgeLength(capsule) > HISTORY_BRIDGE_MAX_CHARACTERS
  ) {
    const removed = turns.shift() as HistoryBridgeTurn;
    const removedTaskIds = new Set(removed.taskIds);
    omittedTurnCount += 1;
    omittedTaskCount += tasks.filter(task =>
      removedTaskIds.has(task.taskId)
    ).length;
    tasks = tasks.filter(task => !removedTaskIds.has(task.taskId));
    capsule = bridgeCapsule(
      turns,
      tasks,
      omittedTurnCount,
      omittedTaskCount,
      truncatedFieldCount
    );
  }
  while (
    tasks.length &&
    serializedHistoryBridgeLength(capsule) > HISTORY_BRIDGE_MAX_CHARACTERS
  ) {
    const removed = tasks.shift() as HistoryBridgeTask;
    omittedTaskCount += 1;
    turns = turns.map(turn => ({
      ...turn,
      taskIds: turn.taskIds.filter(taskId => taskId !== removed.taskId)
    }));
    capsule = bridgeCapsule(
      turns,
      tasks,
      omittedTurnCount,
      omittedTaskCount,
      truncatedFieldCount
    );
  }
  if (serializedHistoryBridgeLength(capsule) > HISTORY_BRIDGE_MAX_CHARACTERS) {
    const newest = turns[turns.length - 1];
    if (!newest) return null;
    const available = Math.max(
      0,
      HISTORY_BRIDGE_MAX_CHARACTERS -
        serializedHistoryBridgeLength({
          ...capsule,
          turns: [{ ...newest, outcome: '' }]
        }) -
        32
    );
    const outcome = truncateField(newest.outcome, available);
    if (outcome.truncated) truncatedFieldCount += 1;
    turns = [{ ...newest, outcome: outcome.value }];
    capsule = bridgeCapsule(
      turns,
      tasks,
      omittedTurnCount,
      omittedTaskCount,
      truncatedFieldCount
    );
  }
  return capsule;
}

export function projectContextMembership(
  cells: readonly WorkspaceCell[],
  generation: number,
  bridges: readonly AgentContextBridge[]
): ContextMembershipProjection {
  const currentBridges = bridges.filter(
    bridge => bridge.generation === generation
  );
  const bridgedIds = new Set<string>();
  currentBridges.forEach(bridge => {
    bridge.cellIds.forEach(cellId => bridgedIds.add(cellId));
  });
  const entries = cells.map(cell => ({
    cellId: cell.id,
    membership: contextMembership(cell, generation, bridgedIds)
  }));
  return {
    generation,
    entries,
    nativeCount: membershipCount(entries, 'native'),
    bridgedCount: membershipCount(entries, 'bridged'),
    outsideCount: membershipCount(entries, 'outside'),
    draftCount: membershipCount(entries, 'draft'),
    policyChosen: currentBridges.length > 0
  };
}

export function serializedHistoryBridgeLength(
  capsule: HistoryBridgeCapsule
): number {
  return JSON.stringify(capsule).length;
}

function bridgeCapsule(
  turns: HistoryBridgeTurn[],
  tasks: HistoryBridgeTask[],
  omittedTurnCount: number,
  omittedTaskCount: number,
  truncatedFieldCount: number
): HistoryBridgeCapsule {
  return {
    version: HISTORY_BRIDGE_VERSION,
    turns,
    tasks,
    omittedTurnCount,
    omittedTaskCount,
    truncatedFieldCount
  };
}

function isEligibleHistoryCell(cell: WorkspaceCell): boolean {
  return (
    cell.kind === 'ai' &&
    (cell.status === 'done' || cell.status === 'interrupted') &&
    Boolean(cell.source.trim())
  );
}

function contextMembership(
  cell: WorkspaceCell,
  generation: number,
  bridgedIds: ReadonlySet<string>
): ContextMembership {
  if (cell.kind !== 'ai') return 'none';
  if (
    cell.status === 'idle' &&
    cell.executionCount === null &&
    cell.turn === null &&
    cell.blocks.length === 0
  ) {
    return 'draft';
  }
  if (cell.agentContextGeneration === generation) return 'native';
  if (bridgedIds.has(cell.id)) return 'bridged';
  return 'outside';
}

function membershipCount(
  entries: readonly ContextMembershipEntry[],
  membership: ContextMembership
): number {
  return entries.filter(entry => entry.membership === membership).length;
}

function canonicalOutcome(cell: WorkspaceCell): string {
  const outcome = cell.turn?.outcome.trim();
  if (outcome) return outcome;
  const result = cell.turn?.resultText.trim();
  if (result) return result;
  for (let index = cell.blocks.length - 1; index >= 0; index -= 1) {
    const block = cell.blocks[index];
    if (block.kind === 'text' && block.text.trim()) return block.text.trim();
  }
  return cell.output.trim();
}

function truncateField(
  value: string,
  maxLength: number
): { value: string; truncated: boolean } {
  if (value.length <= maxLength) return { value, truncated: false };
  if (maxLength <= 1)
    return { value: value.slice(0, maxLength), truncated: true };
  return {
    value: `${value.slice(0, maxLength - 1)}…`,
    truncated: true
  };
}

function backgroundTaskStart(
  cellId: string,
  block: ChatBlock
): BackgroundTaskReference | null {
  if (
    block.kind !== 'tool' ||
    block.name !== 'Bash' ||
    block.status !== 'done'
  ) {
    return null;
  }
  const match = BACKGROUND_START_PATTERN.exec(block.output);
  if (!match) return null;
  const taskId = match[1];
  const outputPath = match[2];
  if (!validTaskId(taskId) || !validOutputPath(outputPath)) return null;
  return {
    cellId,
    taskId,
    outputPath,
    state: 'running',
    sourceBlockId: block.id
  };
}

function backgroundTaskUpdate(
  block: ChatBlock
): { taskId: string; state: BackgroundTaskState } | null {
  if (
    block.kind !== 'tool' ||
    block.name !== 'TaskOutput' ||
    block.status !== 'done'
  ) {
    return null;
  }
  const inputTaskId = taskIdFromInput(block.input);
  const outputTaskId = TASK_OUTPUT_ID_PATTERN.exec(block.output)?.[1];
  const state = TASK_OUTPUT_STATE_PATTERN.exec(block.output)?.[1] as
    BackgroundTaskState | undefined;
  if (!inputTaskId || !outputTaskId || inputTaskId !== outputTaskId || !state) {
    return null;
  }
  return { taskId: inputTaskId, state };
}

function taskIdFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = (input as Record<string, unknown>).task_id;
  return validTaskId(value) ? value : null;
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

function validOutputPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r')
  );
}
