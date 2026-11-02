export const AGENT_WS_PATH = 'aiterminal/agent';

export type WorkspaceMode = 'ai' | 'command';
export type AgentContextState =
  'connecting' | 'new' | 'live' | 'resumed' | 'unavailable' | 'reset';

export interface AgentUserMessage {
  type: 'user';
  turnId?: string;
  text: string;
  historyBridge?: import('./history-bridge').HistoryBridgeCapsule;
}

export interface AgentInterruptMessage {
  type: 'interrupt';
}

export interface AgentExecMessage {
  type: 'exec';
  text: string;
}

export interface AgentExecInterruptMessage {
  type: 'exec_interrupt';
}

export type AgentClientMessage =
  | AgentUserMessage
  | AgentInterruptMessage
  | AgentExecMessage
  | AgentExecInterruptMessage;

export interface AgentReadyEvent {
  type: 'ready';
  sessionId: string;
  contextState?: 'new' | 'resumed';
  model: string;
  cwd: string;
}

export interface AgentAcceptedEvent {
  type: 'accepted';
  turnId?: string;
  sessionId: string;
}

export interface AgentErrorEvent {
  type: 'error';
  turnId?: string;
  code: 'config' | 'runtime' | 'denied' | 'resume' | 'context';
  message: string;
}

export interface AgentTextEvent {
  type: 'text';
  turnId?: string;
  messageId?: string;
  text: string;
}

export interface AgentThinkingEvent {
  type: 'thinking';
  turnId?: string;
  id: string;
  state?: 'started' | 'finished';
}

export interface AgentToolStartEvent {
  type: 'tool_start';
  turnId?: string;
  id: string;
  name: string;
  input: unknown;
  startedAt?: number;
}

export interface AgentToolEndEvent {
  type: 'tool_end';
  turnId?: string;
  id: string;
  name: string;
  output: string;
  isError?: boolean;
  durationMs?: number;
  lineCount?: number;
  byteCount?: number;
}

export interface AgentInstallEvent {
  type: 'install';
  turnId?: string;
  command: string;
  status: 'started' | 'ok' | 'failed';
  detail?: string;
}

export interface AgentDeniedEvent {
  type: 'denied';
  turnId?: string;
  command: string;
  reason: string;
}

export interface AgentResultEvent {
  type: 'result';
  turnId?: string;
  text: string;
  isError?: boolean;
  apiDurationMs?: number;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number | null;
  usage?: Record<string, unknown> | null;
  errors?: string[];
  permissionDenials?: unknown[];
  sessionId?: string;
}

export interface AgentExecOutputEvent {
  type: 'exec_output';
  text: string;
}

export interface AgentExecDoneEvent {
  type: 'exec_done';
  output: string;
  returncode: number;
  cwd: string;
}

export interface AgentExecErrorEvent {
  type: 'exec_error';
  message: string;
}

export type AgentServerEvent =
  | AgentReadyEvent
  | AgentAcceptedEvent
  | AgentErrorEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentToolStartEvent
  | AgentToolEndEvent
  | AgentInstallEvent
  | AgentDeniedEvent
  | AgentResultEvent
  | AgentExecOutputEvent
  | AgentExecDoneEvent
  | AgentExecErrorEvent;

export type ChatBlock =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'text';
      id: string;
      text: string;
      messageId?: string;
    }
  | {
      kind: 'thinking';
      id: string;
      status: 'started' | 'finished';
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      output: string;
      status: 'running' | 'done' | 'error';
      startedAt?: number;
      durationMs?: number;
      lineCount?: number;
      byteCount?: number;
    }
  | {
      kind: 'install';
      id: string;
      command: string;
      status: 'started' | 'ok' | 'failed';
      detail: string;
    }
  | { kind: 'denied'; id: string; command: string; reason: string }
  | {
      kind: 'error';
      id: string;
      message: string;
      code?: AgentErrorEvent['code'];
    };

export function applyServerEvent(
  blocks: ChatBlock[],
  event: AgentServerEvent
): ChatBlock[] {
  switch (event.type) {
    case 'text':
      if (event.messageId) {
        const existing = findLastTextBlock(blocks, event.messageId);
        if (existing) {
          return blocks.map(block =>
            block.kind === 'text' && block.id === existing.id
              ? { ...block, text: event.text }
              : block
          );
        }
      }
      return [
        ...blocks,
        {
          kind: 'text',
          id: event.messageId ? `text-${event.messageId}` : nextId('text'),
          text: event.text,
          ...(event.messageId ? { messageId: event.messageId } : {})
        }
      ];
    case 'thinking': {
      const id = `thinking-${event.id}`;
      const existing = blocks.find(
        block => block.kind === 'thinking' && block.id === id
      );
      if (existing) {
        return blocks.map(block =>
          block.kind === 'thinking' && block.id === id
            ? { ...block, status: event.state ?? 'finished' }
            : block
        );
      }
      return [
        ...blocks,
        {
          kind: 'thinking',
          id,
          status: event.state ?? 'finished'
        }
      ];
    }
    case 'tool_start':
      return [
        ...blocks,
        {
          kind: 'tool',
          id: event.id,
          name: event.name,
          input: event.input,
          output: '',
          status: 'running',
          ...(event.startedAt === undefined
            ? {}
            : { startedAt: event.startedAt })
        }
      ];
    case 'tool_end':
      return blocks.map(block =>
        block.kind === 'tool' && block.id === event.id
          ? {
              ...block,
              output: event.output,
              status: event.isError ? 'error' : 'done',
              ...(event.durationMs === undefined
                ? {}
                : { durationMs: event.durationMs }),
              ...(event.lineCount === undefined
                ? {}
                : { lineCount: event.lineCount }),
              ...(event.byteCount === undefined
                ? {}
                : { byteCount: event.byteCount })
            }
          : block
      );
    case 'install':
      return [
        ...blocks,
        {
          kind: 'install',
          id: nextId('install'),
          command: event.command,
          status: event.status,
          detail: event.detail ?? ''
        }
      ];
    case 'denied':
      return [
        ...blocks,
        {
          kind: 'denied',
          id: nextId('denied'),
          command: event.command,
          reason: event.reason
        }
      ];
    case 'error':
      return [
        ...blocks,
        {
          kind: 'error',
          id: nextId('error'),
          message: event.message,
          code: event.code
        }
      ];
    case 'result':
      return event.isError && event.text
        ? [
            ...blocks,
            { kind: 'error', id: nextId('result'), message: event.text }
          ]
        : blocks;
    case 'ready':
    case 'accepted':
    case 'exec_output':
    case 'exec_done':
    case 'exec_error':
      return blocks;
  }
}

let eventCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++eventCounter}`;
}

function findLastTextBlock(
  blocks: ChatBlock[],
  messageId: string
): Extract<ChatBlock, { kind: 'text' }> | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'text' && block.messageId === messageId) {
      return block;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * DSH product event contract (namespace `dsh`, version 1).
 *
 * This is the versioned boundary between the DeepSeek Harness runtime and the
 * terminal UI. It is intentionally separate from the legacy flat Pi/Claude
 * `AgentServerEvent` union above: existing consumers keep working unchanged,
 * and new consumers can route on `dsh/v1/...` without reinterpreting legacy
 * events. The parser below validates untrusted JSON at runtime instead of
 * relying on TypeScript assertions.
 *
 * Identity rules:
 * - `sessionId` is the durable DSH Session. It is not a process id and it
 *   survives runtime reconnects.
 * - `runtimeId` is the runtime connection generation. Reconnecting creates a
 *   new generation; disconnecting a runtime never deletes a Session.
 * - `runId` is one execution/prompt run inside a Session.
 * - `toolCallId` chains a tool activity to its call; `requestId` chains an
 *   interaction (question/approval) across requested/resolved/cancelled.
 *   A resolution carries only `requestId`; the consumer that correlates it
 *   back to the awaiting tool must cache the `requested` event's `toolCallId`.
 *   This contract describes interaction shape only; it does not make any
 *   approval flow available at runtime.
 * - `runId` is required for execution events (delta/activity/artifact/
 *   interaction/run lifecycle) so they project onto an exact run. It is
 *   optional only on `text.snapshot`, which may restore history with no run.
 * - A run finishing reports execution outcome only. It is not goal acceptance.
 * ------------------------------------------------------------------------- */

export const DSH_EVENT_NAMESPACE = 'dsh' as const;
export const DSH_EVENT_VERSION = 1 as const;
const DSH_EVENT_VERSION_LABEL = `v${DSH_EVENT_VERSION}`;

/** Capabilities a runtime may announce during the handshake. */
export type DshCapabilityName =
  | 'text_stream'
  | 'tool_events'
  | 'artifacts'
  | 'questions'
  | 'approval'
  | 'cancel'
  | 'session_resume'
  | 'jobs'
  | 'subagents';

/**
 * `unverified` means the capability was not exercised, which is not the same
 * as `unavailable` (known to be unsupported). Never report the former as the
 * latter.
 */
export type DshCapabilityStatus = 'available' | 'unavailable' | 'unverified';

export interface DshCapability {
  status: DshCapabilityStatus;
  reason?: string;
}

/** Capabilities announced by the runtime handshake; absent names are unknown. */
export type DshCapabilityManifest = Partial<
  Record<DshCapabilityName, DshCapability>
>;

export type DshConnectionPhase =
  'connected' | 'disconnected' | 'reconnecting' | 'replaced';
export type DshSessionPhase = 'attached' | 'resumed' | 'detached';
export type DshRunStatus = 'completed' | 'failed' | 'cancelled';
export type DshActivityPhase = 'started' | 'updated' | 'finished';
/** Execution outcome of a finished tool activity; never a user-goal verdict. */
export type DshActivityStatus = 'ok' | 'error';
export type DshArtifactPhase = 'created' | 'updated' | 'deleted';
/**
 * Where an artifact came from. `presented` means the runtime surfaced it,
 * `workspace_change` means a tool changed a workspace file. This is a product
 * schema enum; do not infer new values from unobserved DSH events.
 */
export type DshArtifactSource = 'presented' | 'workspace_change';
export type DshInteractionKind = 'question' | 'approval';
export type DshInteractionResolution = 'answered' | 'approved' | 'rejected';

export interface DshSessionScope {
  /** Durable Session identity; survives reconnects and is never a process id. */
  sessionId: string;
  /** Runtime connection generation. Distinct from the durable Session. */
  runtimeId: string;
}

export interface DshOptionalRunScope extends DshSessionScope {
  /** Run reference; absent only where history may be restored without a run. */
  runId?: string;
}

export interface DshRunScope extends DshSessionScope {
  /** Execution identity for one run; required for run-scoped events. */
  runId: string;
}

export interface DshTextSnapshotEvent extends DshOptionalRunScope {
  type: 'dsh/v1/text.snapshot';
  messageId: string;
  text: string;
}

export interface DshTextDeltaEvent extends DshRunScope {
  type: 'dsh/v1/text.delta';
  messageId: string;
  delta: string;
}

export interface DshActivityEvent extends DshRunScope {
  type: 'dsh/v1/activity';
  activityId: string;
  phase: DshActivityPhase;
  /** Tool call this activity belongs to, when it is tool activity. */
  toolCallId?: string;
  label?: string;
  /** Tool name, when this is tool activity (e.g. `bash`, `write`). */
  toolName?: string;
  /** Execution outcome, normally present on `finished`. */
  status?: DshActivityStatus;
  /** Short human-readable output summary; never a raw private payload. */
  outputSummary?: string;
  /** Wall-clock duration in milliseconds; finite and non-negative. */
  durationMs?: number;
}

export interface DshArtifactEvent extends DshRunScope {
  type: 'dsh/v1/artifact';
  artifactId: string;
  phase: DshArtifactPhase;
  name?: string;
  /**
   * Locator for created/updated artifacts. This is text-validated only; it is
   * NOT proof that opening it is safe. Consumers must apply their own safe
   * path/protocol rules and must not treat arbitrary schemes (e.g.
   * `javascript:` or `data:`) as clickable by default.
   */
  uri?: string;
  mediaType?: string;
  /** Explicit product source; not guessed from unobserved runtime events. */
  source?: DshArtifactSource;
  /**
   * Why a created/updated artifact has no `uri` (e.g. `uri_unavailable`). A
   * created/updated artifact must carry either `uri` or this reason; deleted
   * artifacts may be identified by `artifactId` alone.
   */
  unavailableReason?: string;
}

export interface DshInteractionOption {
  id: string;
  label: string;
}

export interface DshInteractionRequestedEvent extends DshRunScope {
  type: 'dsh/v1/interaction.requested';
  requestId: string;
  kind: DshInteractionKind;
  /** Tool call awaiting the decision, when applicable. */
  toolCallId?: string;
  /** Required non-empty prompt shown to the user. */
  prompt: string;
  /** Selectable choices; ids must be non-empty and unique within the event. */
  options?: DshInteractionOption[];
  /** Whether a free-text answer is also allowed alongside `options`. */
  allowFreeText?: boolean;
  /**
   * For approvals only: a short action label (e.g. `bash`) and a human-readable
   * target description. Never raw command text or secrets.
   */
  action?: string;
  target?: string;
}

export interface DshInteractionResolvedEvent extends DshRunScope {
  type: 'dsh/v1/interaction.resolved';
  requestId: string;
  resolution: DshInteractionResolution;
}

export interface DshInteractionCancelledEvent extends DshRunScope {
  type: 'dsh/v1/interaction.cancelled';
  requestId: string;
}

export interface DshRunStartedEvent extends DshRunScope {
  type: 'dsh/v1/run.started';
  runId: string;
}

/**
 * Run lifecycle terminal event. `status` describes how the run ended and does
 * not assert that the user's goal was verified or accepted.
 */
export interface DshRunFinishedEvent extends DshRunScope {
  type: 'dsh/v1/run.finished';
  runId: string;
  status: DshRunStatus;
}

/** Connection generation lifecycle; `disconnected` does not delete sessions. */
export interface DshConnectionEvent {
  type: 'dsh/v1/connection';
  runtimeId: string;
  phase: DshConnectionPhase;
}

/**
 * Session attachment lifecycle. `resumed` restores durable session state; it
 * does not promise restored shells, processes, or jobs.
 */
export interface DshSessionEvent extends DshSessionScope {
  type: 'dsh/v1/session';
  phase: DshSessionPhase;
}

/** Runtime handshake capability declaration. */
export interface DshCapabilitiesEvent {
  type: 'dsh/v1/capabilities';
  runtimeId: string;
  capabilities: DshCapabilityManifest;
}

export type DshProductEvent =
  | DshTextSnapshotEvent
  | DshTextDeltaEvent
  | DshActivityEvent
  | DshArtifactEvent
  | DshInteractionRequestedEvent
  | DshInteractionResolvedEvent
  | DshInteractionCancelledEvent
  | DshRunStartedEvent
  | DshRunFinishedEvent
  | DshConnectionEvent
  | DshSessionEvent
  | DshCapabilitiesEvent;

export type DshEventParseFailureReason =
  | 'not_object'
  | 'unknown_namespace'
  | 'unsupported_version'
  | 'unknown_event'
  | 'invalid_payload';

export type DshEventParseResult =
  | { ok: true; event: DshProductEvent }
  | { ok: false; reason: DshEventParseFailureReason };

const DSH_CAPABILITY_NAMES: readonly DshCapabilityName[] = [
  'text_stream',
  'tool_events',
  'artifacts',
  'questions',
  'approval',
  'cancel',
  'session_resume',
  'jobs',
  'subagents'
];

const DSH_CAPABILITY_STATUSES: readonly DshCapabilityStatus[] = [
  'available',
  'unavailable',
  'unverified'
];
const DSH_CONNECTION_PHASES: readonly DshConnectionPhase[] = [
  'connected',
  'disconnected',
  'reconnecting',
  'replaced'
];
const DSH_SESSION_PHASES: readonly DshSessionPhase[] = [
  'attached',
  'resumed',
  'detached'
];
const DSH_RUN_STATUSES: readonly DshRunStatus[] = [
  'completed',
  'failed',
  'cancelled'
];
const DSH_ACTIVITY_PHASES: readonly DshActivityPhase[] = [
  'started',
  'updated',
  'finished'
];
const DSH_ACTIVITY_STATUSES: readonly DshActivityStatus[] = ['ok', 'error'];
const DSH_ARTIFACT_PHASES: readonly DshArtifactPhase[] = [
  'created',
  'updated',
  'deleted'
];
const DSH_ARTIFACT_SOURCES: readonly DshArtifactSource[] = [
  'presented',
  'workspace_change'
];
const DSH_INTERACTION_KINDS: readonly DshInteractionKind[] = [
  'question',
  'approval'
];
const DSH_INTERACTION_RESOLUTIONS: readonly DshInteractionResolution[] = [
  'answered',
  'approved',
  'rejected'
];

class DshPayloadError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DshPayloadError(key);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new DshPayloadError(key);
  }
  return value;
}

/** Omit the key entirely when the optional run reference is absent. */
function optionalRun(
  source: Record<string, unknown>
): { runId?: string } | Record<string, never> {
  const runId = optionalString(source, 'runId');
  return runId === undefined ? {} : { runId };
}

/** Omit the key entirely when the optional field is absent. */
function optionalField<K extends string>(
  source: Record<string, unknown>,
  key: K
): Record<K, string> | Record<string, never> {
  const value = optionalString(source, key);
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Omit the key entirely when the optional enum is absent; reject bad values. */
function optionalEnumField<K extends string, T extends string>(
  source: Record<string, unknown>,
  key: K,
  allowed: readonly T[]
): Record<K, T> | Record<string, never> {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DshPayloadError(key);
  }
  return { [key]: value as T } as Record<K, T>;
}

/** Omit the key entirely when the optional number is absent; reject bad ones. */
function optionalNonNegativeNumber<K extends string>(
  source: Record<string, unknown>,
  key: K
): Record<K, number> | Record<string, never> {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DshPayloadError(key);
  }
  return { [key]: value } as Record<K, number>;
}

/** Omit the key entirely when the optional boolean is absent; reject bad ones. */
function optionalBoolean<K extends string>(
  source: Record<string, unknown>,
  key: K
): Record<K, boolean> | Record<string, never> {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'boolean') {
    throw new DshPayloadError(key);
  }
  return { [key]: value } as Record<K, boolean>;
}

/**
 * Rebuild a choice list from untrusted data. Rejects non-arrays, empty lists,
 * non-object entries, empty ids/labels, and duplicate ids.
 */
function parseInteractionOptions(value: unknown): DshInteractionOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DshPayloadError('options');
  }
  const seen = new Set<string>();
  const options: DshInteractionOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new DshPayloadError('options');
    }
    const id = requireString(entry, 'id');
    const label = requireString(entry, 'label');
    if (seen.has(id)) {
      throw new DshPayloadError('options');
    }
    seen.add(id);
    options.push({ id, label });
  }
  return options;
}

/** Rebuild the optional option list and ownership-free summary metadata. */
function optionalOptions(source: Record<string, unknown>): {
  options?: DshInteractionOption[];
} {
  const value = source.options;
  return value === undefined ? {} : { options: parseInteractionOptions(value) };
}

type ApprovalSummary = { action?: string; target?: string };
function optionalApprovalSummary(
  source: Record<string, unknown>
): ApprovalSummary {
  const summary: ApprovalSummary = {};
  const action = optionalString(source, 'action');
  const target = optionalString(source, 'target');
  if (action !== undefined) {
    summary.action = action;
  }
  if (target !== undefined) {
    summary.target = target;
  }
  return summary;
}

function requireEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = source[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DshPayloadError(key);
  }
  return value as T;
}

function parseCapabilities(value: unknown): DshCapabilityManifest {
  if (!isRecord(value)) {
    throw new DshPayloadError('capabilities');
  }
  const manifest: DshCapabilityManifest = {};
  // Unknown capability names are ignored so newer runtimes stay parseable.
  for (const name of DSH_CAPABILITY_NAMES) {
    const entry = value[name];
    if (entry === undefined) {
      continue;
    }
    if (!isRecord(entry)) {
      throw new DshPayloadError(name);
    }
    const status = requireEnum(entry, 'status', DSH_CAPABILITY_STATUSES);
    const reason = optionalString(entry, 'reason');
    manifest[name] = reason === undefined ? { status } : { status, reason };
  }
  return manifest;
}

function parseDshPayload(
  kind: string,
  payload: Record<string, unknown>
): DshProductEvent {
  switch (kind) {
    case 'text.snapshot':
      return {
        type: 'dsh/v1/text.snapshot',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        ...optionalRun(payload),
        messageId: requireString(payload, 'messageId'),
        text: requireString(payload, 'text')
      };
    case 'text.delta':
      return {
        type: 'dsh/v1/text.delta',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        messageId: requireString(payload, 'messageId'),
        delta: requireString(payload, 'delta')
      };
    case 'activity':
      return {
        type: 'dsh/v1/activity',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        activityId: requireString(payload, 'activityId'),
        phase: requireEnum(payload, 'phase', DSH_ACTIVITY_PHASES),
        ...optionalField(payload, 'toolCallId'),
        ...optionalField(payload, 'label'),
        ...optionalField(payload, 'toolName'),
        ...optionalEnumField(payload, 'status', DSH_ACTIVITY_STATUSES),
        ...optionalField(payload, 'outputSummary'),
        ...optionalNonNegativeNumber(payload, 'durationMs')
      };
    case 'artifact': {
      const phase = requireEnum(payload, 'phase', DSH_ARTIFACT_PHASES);
      const uri = optionalString(payload, 'uri');
      const unavailableReason = optionalString(payload, 'unavailableReason');
      // Created/updated artifacts need a locator or an explicit reason; bare
      // ids are only enough to identify a deletion.
      if (
        phase !== 'deleted' &&
        uri === undefined &&
        unavailableReason === undefined
      ) {
        throw new DshPayloadError('uri');
      }
      return {
        type: 'dsh/v1/artifact',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        artifactId: requireString(payload, 'artifactId'),
        phase,
        ...optionalField(payload, 'name'),
        ...(uri === undefined ? {} : { uri }),
        ...optionalField(payload, 'mediaType'),
        ...optionalEnumField(payload, 'source', DSH_ARTIFACT_SOURCES),
        ...(unavailableReason === undefined ? {} : { unavailableReason })
      };
    }
    case 'interaction.requested':
      return {
        type: 'dsh/v1/interaction.requested',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        requestId: requireString(payload, 'requestId'),
        kind: requireEnum(payload, 'kind', DSH_INTERACTION_KINDS),
        ...optionalField(payload, 'toolCallId'),
        prompt: requireString(payload, 'prompt'),
        ...optionalOptions(payload),
        ...optionalBoolean(payload, 'allowFreeText'),
        ...optionalApprovalSummary(payload)
      };
    case 'interaction.resolved':
      return {
        type: 'dsh/v1/interaction.resolved',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        requestId: requireString(payload, 'requestId'),
        resolution: requireEnum(
          payload,
          'resolution',
          DSH_INTERACTION_RESOLUTIONS
        )
      };
    case 'interaction.cancelled':
      return {
        type: 'dsh/v1/interaction.cancelled',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        requestId: requireString(payload, 'requestId')
      };
    case 'run.started':
      return {
        type: 'dsh/v1/run.started',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId')
      };
    case 'run.finished':
      return {
        type: 'dsh/v1/run.finished',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        runId: requireString(payload, 'runId'),
        status: requireEnum(payload, 'status', DSH_RUN_STATUSES)
      };
    case 'connection':
      return {
        type: 'dsh/v1/connection',
        runtimeId: requireString(payload, 'runtimeId'),
        phase: requireEnum(payload, 'phase', DSH_CONNECTION_PHASES)
      };
    case 'session':
      return {
        type: 'dsh/v1/session',
        sessionId: requireString(payload, 'sessionId'),
        runtimeId: requireString(payload, 'runtimeId'),
        phase: requireEnum(payload, 'phase', DSH_SESSION_PHASES)
      };
    case 'capabilities':
      return {
        type: 'dsh/v1/capabilities',
        runtimeId: requireString(payload, 'runtimeId'),
        capabilities: parseCapabilities(payload.capabilities)
      };
    default:
      throw new DshPayloadError(kind);
  }
}

/**
 * Validate one untrusted JSON value as a DSH product event. Unknown namespaces,
 * versions, or event kinds fail explicitly so callers can ignore or fall back
 * instead of forwarding malformed data. Only declared fields are copied onto
 * the result; private runtime fields and credentials are never forwarded.
 */
export function parseDshProductEvent(raw: unknown): DshEventParseResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'not_object' };
  }
  const type = raw.type;
  if (typeof type !== 'string') {
    return { ok: false, reason: 'invalid_payload' };
  }
  const prefix = `${DSH_EVENT_NAMESPACE}/`;
  if (!type.startsWith(prefix)) {
    return { ok: false, reason: 'unknown_namespace' };
  }
  const rest = type.slice(prefix.length);
  const separator = rest.indexOf('/');
  if (separator < 0) {
    return { ok: false, reason: 'unknown_event' };
  }
  const version = rest.slice(0, separator);
  const kind = rest.slice(separator + 1);
  if (version !== DSH_EVENT_VERSION_LABEL) {
    return { ok: false, reason: 'unsupported_version' };
  }
  try {
    return { ok: true, event: parseDshPayload(kind, raw) };
  } catch (error) {
    if (error instanceof DshPayloadError) {
      return {
        ok: false,
        reason:
          kind === 'text.snapshot' ||
          kind === 'text.delta' ||
          kind === 'activity' ||
          kind === 'artifact' ||
          kind === 'interaction.requested' ||
          kind === 'interaction.resolved' ||
          kind === 'interaction.cancelled' ||
          kind === 'run.started' ||
          kind === 'run.finished' ||
          kind === 'connection' ||
          kind === 'session' ||
          kind === 'capabilities'
            ? 'invalid_payload'
            : 'unknown_event'
      };
    }
    throw error;
  }
}

export function isDshProductEvent(raw: unknown): raw is DshProductEvent {
  return parseDshProductEvent(raw).ok;
}
