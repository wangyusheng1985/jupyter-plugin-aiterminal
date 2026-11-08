import type { AgentServerEvent, ChatBlock } from './protocol';
import { presentTool, type ToolPresentation } from './tool-presenter';

export type TurnStatus = 'running' | 'done' | 'interrupted' | 'error';
export type TraceDisclosure = 'auto' | 'expanded' | 'collapsed';
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
  outcomeExpanded: boolean;
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
  revision: number;
}

export interface PersistedTurn {
  id: string;
  status: Exclude<TurnStatus, 'running'>;
  resultText: string;
  resultIsError: boolean;
  metrics: TurnMetrics;
  presentation: TurnPresentationState;
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
      trace: 'auto',
      expandedActivityIds: [],
      fullEvidenceActivityIds: [],
      outcomeExpanded: false
    },
    resultText: '',
    resultIsError: false,
    revision: 0
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

export function deriveTurn(turn: ChatTurn, blocks: ChatBlock[]): ChatTurn {
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
    revision: turn.revision + 1
  };
}

export function setTurnStatus(
  turn: ChatTurn,
  status: TurnStatus,
  blocks: ChatBlock[]
): ChatTurn {
  return deriveTurn({ ...turn, status }, blocks);
}

export function toPersistedTurn(turn: ChatTurn): PersistedTurn {
  return {
    id: turn.id,
    status: turn.status === 'running' ? 'interrupted' : turn.status,
    resultText: turn.resultText,
    resultIsError: turn.resultIsError,
    metrics: turn.metrics,
    presentation: turn.presentation
  };
}

export function restoreTurn(
  value: PersistedTurn | null | undefined
): ChatTurn | null {
  if (!value || typeof value.id !== 'string') return null;
  const turn = createTurn(value.id);
  return {
    ...turn,
    status: value.status,
    resultText: typeof value.resultText === 'string' ? value.resultText : '',
    resultIsError: Boolean(value.resultIsError),
    metrics: {
      ...(value.metrics && typeof value.metrics === 'object'
        ? value.metrics
        : {})
    },
    presentation: normalizePresentation(value.presentation)
  };
}

export function isTraceExpanded(turn: ChatTurn): boolean {
  if (turn.presentation.trace === 'expanded') return true;
  if (turn.presentation.trace === 'collapsed') return false;
  return turn.status === 'running';
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

export function toggleOutcome(turn: ChatTurn): ChatTurn {
  return {
    ...turn,
    presentation: {
      ...turn.presentation,
      outcomeExpanded: !turn.presentation.outcomeExpanded
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
          status: block.status
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
  if (turn.status === 'running') {
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
  const trace =
    value?.trace === 'expanded' || value?.trace === 'collapsed'
      ? value.trace
      : 'auto';
  return {
    trace,
    expandedActivityIds: Array.isArray(value?.expandedActivityIds)
      ? value.expandedActivityIds.filter(
          (id): id is string => typeof id === 'string'
        )
      : [],
    fullEvidenceActivityIds: Array.isArray(value?.fullEvidenceActivityIds)
      ? value.fullEvidenceActivityIds.filter(
          (id): id is string => typeof id === 'string'
        )
      : [],
    outcomeExpanded: Boolean(value?.outcomeExpanded)
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
