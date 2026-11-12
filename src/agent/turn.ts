import type { AgentServerEvent, ChatBlock, TerminalReason } from './protocol';
import { presentTool, type ToolPresentation } from './tool-presenter';

export type TurnStatus =
  'running' | 'pending' | 'done' | 'interrupted' | 'error';
export type TraceDisclosure = 'expanded' | 'collapsed';
export type OutcomeKind = 'result' | 'assistant' | 'tool' | 'none';

export interface TurnMetrics {
  durationMs?: number;
  apiDurationMs?: number;
  numTurns?: number;
  costUsd?: number | null;
  usage?: Record<string, unknown> | null;
}

export interface TurnPresentationState {
  trace: TraceDisclosure;
  expandedActivityIds: string[];
  fullEvidenceActivityIds: string[];
}

export interface AssistantActivity {
  kind: 'text';
  id: string;
  blockId: string;
  text: string;
  status: 'done';
}

export interface ThinkingActivity {
  kind: 'thinking';
  id: string;
  blockId: string;
  status: 'started' | 'finished';
  /** Cumulative streamed reasoning text; absent for legacy markers. */
  text?: string;
}

export interface ToolActivity {
  kind: 'tool';
  id: string;
  blockId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  input: unknown;
  output: string;
  durationMs?: number;
  presentation: ToolPresentation;
}

export interface NoticeActivity {
  kind: 'install' | 'denied' | 'error' | 'unknown';
  id: string;
  blockId: string;
  status: 'started' | 'ok' | 'failed' | 'error' | 'info';
  title: string;
  detail: string;
  code?: string;
}

export type TurnActivity =
  AssistantActivity | ThinkingActivity | ToolActivity | NoticeActivity;

export interface TurnDiagnostic {
  id: string;
  activityId: string;
  tone: 'error' | 'warning';
  title: string;
  detail: string;
}

export interface TurnChange {
  path: string;
  additions: number | null;
  deletions: number | null;
  sourceIds: string[];
}

export interface ChatTurn {
  id: string;
  status: TurnStatus;
  outcome: string;
  outcomeKind: OutcomeKind;
  timeline: TurnActivity[];
  diagnostics: TurnDiagnostic[];
  changes: TurnChange[];
  metrics: TurnMetrics;
  presentation: TurnPresentationState;
  resultText: string;
  resultIsError: boolean;
  /** Stable runtime outcome; absent for legacy turns and partial results. */
  terminalReason?: TerminalReason;
  revision: number;
  /** Wall-clock stamp updated when turn content changes (for merge ties). */
  updatedAt: string;
}

export interface PersistedTurn {
  id: string;
  status: Exclude<TurnStatus, 'pending'>;
  resultText: string;
  resultIsError: boolean;
  terminalReason?: TerminalReason;
  metrics: TurnMetrics;
  presentation: TurnPresentationState;
  /** Last writer's wall-clock stamp; used by the detached writer to merge. */
  updatedAt?: string;
}

export function createTurn(id: string): ChatTurn {
  return {
    id,
    status: 'running',
    outcome: '',
    outcomeKind: 'none',
    timeline: [],
    diagnostics: [],
    changes: [],
    metrics: {},
    presentation: {
      trace: 'collapsed',
      expandedActivityIds: [],
      fullEvidenceActivityIds: []
    },
    resultText: '',
    resultIsError: false,
    revision: 0,
    updatedAt: new Date().toISOString()
  };
}

export function applyTurnEvent(
  turn: ChatTurn,
  blocks: ChatBlock[],
  event: AgentServerEvent
): ChatTurn {
  const eventTurnId = 'turnId' in event ? event.turnId : undefined;
  if (eventTurnId && eventTurnId !== turn.id) return turn;
  const next = { ...turn };
  switch (event.type) {
    case 'result':
      next.status = event.isError ? 'error' : 'done';
      next.resultText = event.text.trim();
      next.resultIsError = Boolean(event.isError);
      next.metrics = {
        ...next.metrics,
        ...eventMetrics(event)
      };
      next.terminalReason = normalizeTerminalReason(event.reason);
      break;
    case 'error':
      next.status = 'error';
      break;
    case 'text':
    case 'thinking':
    case 'tool_start':
    case 'tool_end':
    case 'install':
    case 'denied':
      if (next.status !== 'error' && next.status !== 'interrupted') {
        next.status = 'running';
      }
      break;
    case 'ready':
    case 'accepted':
    case 'exec_output':
    case 'exec_done':
    case 'exec_error':
      return turn;
  }
  return deriveTurn(next, blocks);
}

export interface DeriveTurnOptions {
  /**
   * Whether this derivation represents a content change. Hydrating a document
   * from disk must pass ``false`` so merely opening it does not mint a new
   * ``updatedAt``/revision and dirty the file for a save.
   */
  touch?: boolean;
}

export function deriveTurn(
  turn: ChatTurn,
  blocks: ChatBlock[],
  options: DeriveTurnOptions = {}
): ChatTurn {
  const touch = options.touch !== false;
  const timeline = timelineFromBlocks(blocks);
  const outcome = resolveOutcome(turn, timeline);
  const consumedActivityIds = outcome.consumedActivityId
    ? new Set([outcome.consumedActivityId])
    : new Set<string>();
  const visibleTimeline = timeline.filter(
    activity => !consumedActivityIds.has(activity.id)
  );
  return {
    ...turn,
    outcome: outcome.text,
    outcomeKind: outcome.kind,
    timeline: visibleTimeline,
    diagnostics: deriveDiagnostics(visibleTimeline),
    changes: deriveChanges(visibleTimeline),
    revision: touch ? turn.revision + 1 : turn.revision,
    ...(touch ? { updatedAt: new Date().toISOString() } : {})
  };
}

/** Rebuild derived turn fields without treating a disk load as an edit. */
export function hydrateTurn(turn: ChatTurn, blocks: ChatBlock[]): ChatTurn {
  return deriveTurn(turn, blocks, { touch: false });
}

export function setTurnStatus(
  turn: ChatTurn,
  status: TurnStatus,
  blocks: ChatBlock[]
): ChatTurn {
  return deriveTurn(
    { ...turn, status, updatedAt: new Date().toISOString() },
    blocks
  );
}

export function preserveTurnPresentation(
  incoming: ChatTurn,
  previous: ChatTurn | null | undefined
): ChatTurn {
  if (!previous) return incoming;
  const presentation = previous.presentation;
  const userAdjusted =
    presentation.trace === 'expanded' ||
    presentation.expandedActivityIds.length > 0 ||
    presentation.fullEvidenceActivityIds.length > 0;
  if (!userAdjusted) return incoming;
  if (previous.id !== incoming.id && !previous.id.startsWith('legacy-')) {
    return incoming;
  }
  return { ...incoming, presentation };
}

export function toPersistedTurn(turn: ChatTurn): PersistedTurn {
  return {
    id: turn.id,
    status: turn.status === 'pending' ? 'running' : turn.status,
    resultText: turn.resultText,
    resultIsError: turn.resultIsError,
    ...(turn.terminalReason === undefined
      ? {}
      : { terminalReason: turn.terminalReason }),
    metrics: turn.metrics,
    presentation: turn.presentation,
    // Legacy documents have no timestamp. Preserve that absence instead of
    // writing "now" just because the file was opened; a real turn change sets
    // the field through deriveTurn/setTurnStatus.
    ...(turn.updatedAt ? { updatedAt: turn.updatedAt } : {})
  };
}

export function restoreTurn(
  value: PersistedTurn | null | undefined
): ChatTurn | null {
  if (!value || typeof value.id !== 'string') return null;
  const turn = createTurn(value.id);
  const terminalReason = normalizeTerminalReason(
    (value as { terminalReason?: unknown }).terminalReason
  );
  return {
    ...turn,
    status: value.status,
    resultText: typeof value.resultText === 'string' ? value.resultText : '',
    resultIsError: Boolean(value.resultIsError),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    metrics: {
      ...(value.metrics && typeof value.metrics === 'object'
        ? value.metrics
        : {})
    },
    presentation: normalizePresentation(value.presentation),
    // Keep an absent legacy stamp absent. A fabricated timestamp would make a
    // clean round-trip differ from disk and trigger an unnecessary save.
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : ''
  };
}

/**
 * True only for the stable reasons the backend emits. Unknown or legacy values
 * (including non-strings) are dropped so a stale document cannot smuggle a
 * new state into the renderer.
 */
function normalizeTerminalReason(value: unknown): TerminalReason | undefined {
  return value === 'completed' ||
    value === 'cancelled' ||
    value === 'budget-exhausted' ||
    value === 'failed'
    ? value
    : undefined;
}

/**
 * User-facing explanation of how a turn ended. Rendered as its own notice, never
 * appended to the assistant text. `completed` only needs a message when the run
 * produced no output; every other terminal reason is worth stating even when a
 * partial answer was already streamed.
 */
export function terminalReasonMessage(
  turn: Pick<ChatTurn, 'terminalReason' | 'resultText' | 'outcomeKind'>
): string | null {
  const reason = turn.terminalReason;
  if (!reason) return null;
  // ACP streams assistant text into `text` blocks while `result.text` stays
  // empty, so the runtime result string alone cannot prove an answer exists.
  // The derived outcome kind is the source of truth for visible assistant text;
  // `tool`/`none` outcomes are activity or silence, never an answer.
  const hasResult =
    turn.resultText.trim().length > 0 ||
    turn.outcomeKind === 'assistant' ||
    turn.outcomeKind === 'result';
  switch (reason) {
    case 'completed':
      return hasResult ? null : 'Run completed without producing a response.';
    case 'cancelled':
      return hasResult
        ? 'Run cancelled before finishing.'
        : 'Run cancelled before producing a response.';
    case 'budget-exhausted':
      return hasResult
        ? 'Run stopped early: token budget exhausted.'
        : 'Run stopped before producing a response: token budget exhausted.';
    case 'failed':
      return hasResult
        ? 'Run failed before finishing.'
        : 'Run failed before producing a response.';
  }
}

/**
 * Raw Markdown an outcome copy control may place on the clipboard. Only a real
 * final answer qualifies: `result` from the runtime and `assistant` from the
 * last streamed text block. A `tool` fallback is execution evidence, never an
 * answer, and `none` has no text; both must stay uncopyable so a copy can never
 * leak tool output. Returns the exact source string, never DOM text.
 */
export function copyableOutcomeText(
  turn: Pick<ChatTurn, 'outcome' | 'outcomeKind'>
): string | null {
  if (turn.outcomeKind !== 'result' && turn.outcomeKind !== 'assistant') {
    return null;
  }
  return turn.outcome.trim().length > 0 ? turn.outcome : null;
}

export function isTraceExpanded(turn: ChatTurn): boolean {
  // The execution record stays hidden until the user explicitly opens it.
  // Running and failed turns never expand it on their own; terminal errors
  // stay visible through the terminal notice and the failure summary instead.
  return turn.presentation.trace === 'expanded';
}

export function toggleTrace(turn: ChatTurn): ChatTurn {
  const expanded = isTraceExpanded(turn);
  return {
    ...turn,
    presentation: {
      ...turn.presentation,
      trace: expanded ? 'collapsed' : 'expanded'
    },
    revision: turn.revision + 1
  };
}

export function revealFailedActivity(
  turn: ChatTurn,
  activityId: string
): ChatTurn {
  const expanded = new Set(turn.presentation.expandedActivityIds);
  expanded.add(activityId);
  return {
    ...turn,
    presentation: {
      ...turn.presentation,
      trace: 'expanded',
      expandedActivityIds: [...expanded]
    },
    revision: turn.revision + 1
  };
}

export function toggleActivity(turn: ChatTurn, activityId: string): ChatTurn {
  const expanded = new Set(turn.presentation.expandedActivityIds);
  if (expanded.has(activityId)) expanded.delete(activityId);
  else expanded.add(activityId);
  return {
    ...turn,
    presentation: {
      ...turn.presentation,
      expandedActivityIds: [...expanded]
    },
    revision: turn.revision + 1
  };
}

export function toggleEvidence(turn: ChatTurn, activityId: string): ChatTurn {
  const expanded = new Set(turn.presentation.fullEvidenceActivityIds);
  if (expanded.has(activityId)) expanded.delete(activityId);
  else expanded.add(activityId);
  return {
    ...turn,
    presentation: {
      ...turn.presentation,
      fullEvidenceActivityIds: [...expanded]
    },
    revision: turn.revision + 1
  };
}

export function timelineFromBlocks(blocks: ChatBlock[]): TurnActivity[] {
  const activities: TurnActivity[] = [];
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'text':
        activities.push({
          kind: 'text',
          id: `activity-${block.id}`,
          blockId: block.id,
          text: block.text,
          status: 'done'
        });
        break;
      case 'thinking':
        activities.push({
          kind: 'thinking',
          id: `activity-${block.id}`,
          blockId: block.id,
          status: block.status,
          ...(block.text === undefined ? {} : { text: block.text })
        });
        break;
      case 'tool':
        activities.push({
          kind: 'tool',
          id: `activity-${block.id}`,
          blockId: block.id,
          name: block.name,
          status: block.status,
          input: block.input,
          output: block.output,
          ...(block.durationMs === undefined
            ? {}
            : { durationMs: block.durationMs }),
          presentation: presentTool(block)
        });
        break;
      case 'install':
        activities.push({
          kind: 'install',
          id: `activity-${block.id}`,
          blockId: block.id,
          status: block.status,
          title: `Install ${block.command}`,
          detail: block.detail
        });
        break;
      case 'denied':
        activities.push({
          kind: 'denied',
          id: `activity-${block.id}`,
          blockId: block.id,
          status: 'failed',
          title: `Denied: ${block.command}`,
          detail: block.reason
        });
        break;
      case 'error':
        activities.push({
          kind: 'error',
          id: `activity-${block.id}`,
          blockId: block.id,
          status: 'error',
          title: block.code === 'config' ? 'Configuration error' : 'Error',
          detail: block.message,
          code: block.code
        });
        break;
      case 'user':
        break;
      default: {
        const legacy = block as unknown as {
          id?: unknown;
          kind?: unknown;
          status?: unknown;
          title?: unknown;
          text?: unknown;
          message?: unknown;
        };
        const kind = typeof legacy.kind === 'string' ? legacy.kind : 'block';
        const blockId =
          typeof legacy.id === 'string' ? legacy.id : `legacy-${index}`;
        activities.push({
          kind: 'unknown',
          id: `activity-${blockId}`,
          blockId,
          status: 'info',
          title: `Unsupported ${kind} activity`,
          detail: legacyDetail(legacy)
        });
      }
    }
  });
  return activities;
}

function resolveOutcome(
  turn: ChatTurn,
  timeline: TurnActivity[]
): {
  text: string;
  kind: OutcomeKind;
  consumedActivityId?: string;
} {
  if (turn.resultText) {
    const lastText = lastActivity(timeline, 'text');
    const consumedActivityId =
      lastText &&
      normalizeText(lastText.text) === normalizeText(turn.resultText)
        ? lastText.id
        : undefined;
    return {
      text: turn.resultText,
      kind: 'result',
      ...(consumedActivityId ? { consumedActivityId } : {})
    };
  }
  if (turn.status === 'running' || turn.status === 'pending') {
    return { text: '', kind: 'none' };
  }
  const lastText = lastActivity(timeline, 'text');
  if (lastText) {
    return {
      text: lastText.text,
      kind: 'assistant',
      consumedActivityId: lastText.id
    };
  }
  const lastTool = lastActivity(timeline, 'tool');
  if (lastTool) {
    const text =
      lastTool.presentation.preview ||
      lastTool.presentation.detail ||
      lastTool.presentation.title;
    return { text, kind: 'tool' };
  }
  return { text: '', kind: 'none' };
}

function deriveDiagnostics(timeline: TurnActivity[]): TurnDiagnostic[] {
  const diagnostics: TurnDiagnostic[] = [];
  const seen = new Set<string>();
  for (const activity of timeline) {
    let diagnostic: TurnDiagnostic | null = null;
    if (activity.kind === 'tool' && activity.status === 'error') {
      diagnostic = {
        id: `diagnostic-${activity.id}`,
        activityId: activity.id,
        tone: 'error',
        title: `${activity.presentation.title} failed`,
        detail: activity.presentation.preview || activity.presentation.detail
      };
    } else if (activity.kind === 'install' && activity.status === 'failed') {
      diagnostic = {
        id: `diagnostic-${activity.id}`,
        activityId: activity.id,
        tone: 'warning',
        title: 'Installation failed',
        detail: activity.detail || activity.title
      };
    } else if (activity.kind === 'denied') {
      diagnostic = {
        id: `diagnostic-${activity.id}`,
        activityId: activity.id,
        tone: 'warning',
        title: 'Action denied',
        detail: activity.detail
      };
    } else if (activity.kind === 'error') {
      diagnostic = {
        id: `diagnostic-${activity.id}`,
        activityId: activity.id,
        tone: 'error',
        title: activity.title,
        detail: activity.detail
      };
    }
    if (!diagnostic) continue;
    const key = `${diagnostic.title}\n${diagnostic.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function deriveChanges(timeline: TurnActivity[]): TurnChange[] {
  const changes = new Map<string, TurnChange>();
  timeline.forEach(activity => {
    if (activity.kind !== 'tool' || !activity.presentation.change) return;
    const change = activity.presentation.change;
    const current = changes.get(change.path);
    if (!current) {
      changes.set(change.path, {
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        sourceIds: [activity.id]
      });
      return;
    }
    current.additions = sumNullable(current.additions, change.additions);
    current.deletions = sumNullable(current.deletions, change.deletions);
    current.sourceIds.push(activity.id);
  });
  return [...changes.values()];
}

function eventMetrics(
  event: Extract<AgentServerEvent, { type: 'result' }>
): TurnMetrics {
  return {
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.apiDurationMs === undefined
      ? {}
      : { apiDurationMs: event.apiDurationMs }),
    ...(event.numTurns === undefined ? {} : { numTurns: event.numTurns }),
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
    ...(event.usage === undefined ? {} : { usage: event.usage })
  };
}

function normalizePresentation(
  value: TurnPresentationState | null | undefined
): TurnPresentationState {
  // Legacy documents may persist an `auto` trace or an `outcomeExpanded`
  // flag; both resolve to the current default of a collapsed record.
  return {
    trace: value?.trace === 'expanded' ? 'expanded' : 'collapsed',
    expandedActivityIds: Array.isArray(value?.expandedActivityIds)
      ? value.expandedActivityIds.filter(
          (id): id is string => typeof id === 'string'
        )
      : [],
    fullEvidenceActivityIds: Array.isArray(value?.fullEvidenceActivityIds)
      ? value.fullEvidenceActivityIds.filter(
          (id): id is string => typeof id === 'string'
        )
      : []
  };
}

function lastActivity<K extends TurnActivity['kind']>(
  timeline: TurnActivity[],
  kind: K
): Extract<TurnActivity, { kind: K }> | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const activity = timeline[index];
    if (activity.kind === kind) {
      return activity as Extract<TurnActivity, { kind: K }>;
    }
  }
  return null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function legacyDetail(value: {
  status?: unknown;
  title?: unknown;
  text?: unknown;
  message?: unknown;
}): string {
  const parts = [value.status, value.title, value.text, value.message]
    .filter((part): part is string => typeof part === 'string' && Boolean(part))
    .join('\n');
  return parts.length > 500 ? `${parts.slice(0, 497)}...` : parts;
}

function sumNullable(
  current: number | null,
  next: number | null
): number | null {
  if (current === null && next === null) return null;
  return (current ?? 0) + (next ?? 0);
}
