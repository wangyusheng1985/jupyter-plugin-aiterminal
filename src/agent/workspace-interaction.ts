import type { CellStatus, WorkspaceCell } from './notebook';
import type { AgentContextState } from './protocol';
import type { ContextMembership } from './history-bridge';
import type { SavePhase } from './save-coordinator';

export interface CellNavigationEntry {
  id: string;
  index: number;
  source: string;
  preview: string;
  status: CellStatus;
  executionCount: number | null;
  failureCount: number;
  contextMembership: ContextMembership;
  selected: boolean;
}

export interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

export type SegmenterFactory = () => SegmenterLike | null;

export function navigationEntries(
  cells: readonly WorkspaceCell[],
  activeIndex: number,
  contextMembershipByCellId: ReadonlyMap<string, ContextMembership> = new Map()
): CellNavigationEntry[] {
  const entries: CellNavigationEntry[] = [];
  cells.forEach((cell, index) => {
    if (!isNavigableCell(cell)) return;
    entries.push({
      id: cell.id,
      index,
      source: cell.source,
      preview: inputPreview(cell.source),
      status: cell.status,
      executionCount: cell.executionCount,
      failureCount: cell.turn?.diagnostics.length ?? 0,
      contextMembership: contextMembershipByCellId.get(cell.id) ?? 'none',
      selected: index === activeIndex
    });
  });
  return entries;
}

export function isNavigableCell(cell: WorkspaceCell): boolean {
  return (
    cell.status === 'queued' ||
    cell.status === 'running' ||
    cell.executionCount !== null
  );
}

export function normalizeInput(source: string): string {
  return source.trim().replace(/\s+/gu, ' ');
}

export function inputPreview(
  source: string,
  limit = 10,
  segmenterFactory: SegmenterFactory = browserSegmenter
): string {
  const input = normalizeInput(source);
  if (!input || limit <= 0) return '';
  const segments = graphemes(input, segmenterFactory);
  const text = segments.slice(0, limit).join('');
  return segments.length > limit ? `${text}…` : text;
}

export function navigationLabel(entry: CellNavigationEntry): string {
  const position = entry.executionCount ?? entry.index + 1;
  const state =
    entry.status === 'queued' || entry.status === 'running'
      ? `, ${entry.status}`
      : '';
  const failures = entry.failureCount ? `, ${entry.failureCount} failed` : '';
  const context = contextMembershipLabel(entry.contextMembership);
  return `Cell ${position}${state}${failures}${context}: ${entry.preview || 'Empty input'}`;
}

function contextMembershipLabel(membership: ContextMembership): string {
  switch (membership) {
    case 'native':
      return ', native context';
    case 'bridged':
      return ', bridged history';
    case 'outside':
      return ', outside current context';
    case 'draft':
    case 'none':
      return '';
  }
}

function graphemes(
  input: string,
  segmenterFactory: SegmenterFactory
): string[] {
  const segmenter = segmenterFactory();
  if (!segmenter) return Array.from(input);
  return Array.from(segmenter.segment(input), item => item.segment);
}

function browserSegmenter(): SegmenterLike | null {
  const intl = Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: 'grapheme' }
    ) => SegmenterLike;
  };
  return intl.Segmenter
    ? new intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
}

export interface ProximityResult {
  targetIndex: number;
  weights: number[];
}

export function markerProximity(
  centers: readonly number[],
  pointerY: number
): ProximityResult {
  if (!centers.length) return { targetIndex: -1, weights: [] };
  let targetIndex = 0;
  let distance = Math.abs(pointerY - centers[0]);
  centers.slice(1).forEach((center, offset) => {
    const candidate = Math.abs(pointerY - center);
    if (candidate >= distance) return;
    distance = candidate;
    targetIndex = offset + 1;
  });
  return {
    targetIndex,
    weights: centers.map((_, index) => {
      const separation = Math.abs(index - targetIndex);
      return separation === 0 ? 1 : separation === 1 ? 0.5 : 0;
    })
  };
}

export function retainRovingId(
  ids: readonly string[],
  currentId: string | null,
  preferredId: string | null
): string | null {
  if (!ids.length) return null;
  if (currentId && ids.includes(currentId)) return currentId;
  if (preferredId && ids.includes(preferredId)) return preferredId;
  return ids[0];
}

export function moveRovingId(
  ids: readonly string[],
  currentId: string | null,
  delta: -1 | 1
): string | null {
  if (!ids.length) return null;
  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
}

export type FollowMode = 'inactive' | 'following' | 'detached';

export interface FollowState {
  requestId: string | null;
  mode: FollowMode;
}

export const INACTIVE_FOLLOW_STATE: FollowState = {
  requestId: null,
  mode: 'inactive'
};

export function syncFollowRequest(
  state: FollowState,
  requestId: string | null
): FollowState {
  if (!requestId) return INACTIVE_FOLLOW_STATE;
  if (state.requestId === requestId) return state;
  return { requestId, mode: 'following' };
}

export function detachFollow(state: FollowState): FollowState {
  return state.requestId ? { ...state, mode: 'detached' } : state;
}

export function resumeFollow(state: FollowState): FollowState {
  return state.requestId ? { ...state, mode: 'following' } : state;
}

export function shouldFollowUpdate(
  state: FollowState,
  requestId: string,
  nearTail: boolean,
  editingAnotherCell: boolean
): boolean {
  return (
    state.requestId === requestId &&
    state.mode === 'following' &&
    nearTail &&
    !editingAnotherCell
  );
}

export interface WorkspaceUiInput {
  connected: boolean;
  error: string | null;
  cwd: string | null;
  selectedCellId: string | null;
  activeRun: { id: string; cellId: string } | null;
  queueCount: number;
  contextState: AgentContextState;
  contextNativeCount?: number;
  contextBridgedCount?: number;
  contextOutsideCount?: number;
  savePhase?: SavePhase;
}

export interface WorkspaceUiState extends WorkspaceUiInput {
  interruptAvailable: boolean;
  connectionLabel: string;
  executionLabel: string;
  contextLabel: string;
  savePhase: SavePhase;
  saveLabel: string;
  saveRetryAvailable: boolean;
}

export function workspaceUiState(input: WorkspaceUiInput): WorkspaceUiState {
  const connectionLabel = input.connected
    ? 'Connected'
    : input.error
      ? 'Connection error'
      : 'Disconnected';
  const executionLabel = input.activeRun
    ? `Running ${input.activeRun.cellId}${
        input.queueCount ? ` · Queue ${input.queueCount}` : ''
      }`
    : input.queueCount
      ? `Queue ${input.queueCount}`
      : 'Ready';
  const contextLabel = contextStateLabel(
    input.contextState,
    input.contextBridgedCount ?? 0,
    input.contextOutsideCount ?? 0
  );
  const savePhase = input.savePhase ?? 'saved';
  return {
    ...input,
    savePhase,
    interruptAvailable: input.activeRun !== null,
    connectionLabel,
    executionLabel,
    contextLabel,
    saveLabel: saveStateLabel(savePhase),
    saveRetryAvailable: savePhase === 'error'
  };
}

export function workspaceUiStateKey(state: WorkspaceUiState): string {
  return JSON.stringify({
    connected: state.connected,
    error: state.error,
    cwd: state.cwd,
    selectedCellId: state.selectedCellId,
    activeRun: state.activeRun,
    queueCount: state.queueCount,
    contextState: state.contextState,
    contextNativeCount: state.contextNativeCount ?? 0,
    contextBridgedCount: state.contextBridgedCount ?? 0,
    contextOutsideCount: state.contextOutsideCount ?? 0,
    savePhase: state.savePhase
  });
}

export function saveStateLabel(phase: SavePhase): string {
  switch (phase) {
    case 'saved':
      return 'Saved';
    case 'pending':
    case 'saving':
      return 'Saving…';
    case 'error':
      return 'Not saved';
  }
}

export interface WorkspaceOverview {
  submittedCount: number;
  aiCount: number;
  commandCount: number;
  queuedCount: number;
  runningCount: number;
  interruptedCount: number;
  failureCount: number;
  firstFailureCellId: string | null;
  firstInterruptedCellId: string | null;
  summaryLabel: string;
}

export function workspaceOverview(
  cells: readonly WorkspaceCell[]
): WorkspaceOverview {
  const submitted = cells.filter(isNavigableCell);
  const interrupted = submitted.filter(cell => cell.status === 'interrupted');
  const failed = submitted.filter(
    cell => (cell.turn?.diagnostics.length ?? 0) > 0
  );
  const failureCount = failed.reduce(
    (total, cell) => total + (cell.turn?.diagnostics.length ?? 0),
    0
  );
  const parts = [
    `${submitted.length} ${submitted.length === 1 ? 'turn' : 'turns'}`
  ];
  if (interrupted.length) parts.push(`${interrupted.length} interrupted`);
  if (failureCount) parts.push(`${failureCount} failed`);
  return {
    submittedCount: submitted.length,
    aiCount: submitted.filter(cell => cell.kind === 'ai').length,
    commandCount: submitted.filter(cell => cell.kind === 'command').length,
    queuedCount: submitted.filter(cell => cell.status === 'queued').length,
    runningCount: submitted.filter(cell => cell.status === 'running').length,
    interruptedCount: interrupted.length,
    failureCount,
    firstFailureCellId: failed[0]?.id ?? null,
    firstInterruptedCellId: interrupted[0]?.id ?? null,
    summaryLabel: submitted.length ? parts.join(' · ') : 'No submitted turns'
  };
}

export function workspaceOverviewKey(overview: WorkspaceOverview): string {
  return JSON.stringify(overview);
}

export function contextStateLabel(
  state: AgentContextState,
  bridgedCount = 0,
  outsideCount = 0
): string {
  const coverage = bridgedCount
    ? ` · ${bridgedCount} bridged`
    : outsideCount
      ? ` · ${outsideCount} outside`
      : '';
  switch (state) {
    case 'connecting':
      return `Context: Connecting${coverage}`;
    case 'new':
      return `Context: New${coverage}`;
    case 'live':
      return `Context: Live${coverage}`;
    case 'resumed':
      return `Context: Resumed${coverage}`;
    case 'unavailable':
      return `Context: Unavailable${coverage}`;
    case 'reset':
      return `Context: Reset${coverage}`;
  }
}
