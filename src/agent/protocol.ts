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
  | AgentExecInterruptMessage
  | AgentConfigurationRequestMessage;

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

/**
 * Stable terminal outcome of a runtime result. The backend emits exactly these
 * values; missing reasons are tolerated for older documents, unknown values
 * are never trusted.
 */
export type TerminalReason =
  'completed' | 'cancelled' | 'budget-exhausted' | 'failed';

export interface AgentResultEvent {
  type: 'result';
  turnId?: string;
  text: string;
  isError?: boolean;
  /** How the run ended; absent on legacy/partial results. */
  reason?: TerminalReason;
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

/* ---------------------------------------------------------------------------
 * Effective configuration report.
 *
 * The runtime reports what configuration is actually active, what the saved
 * settings desire, and where they differ. Every field here is presentation
 * data: the backend projects snapshots onto a fixed safe-report whitelist, so
 * raw settings (provider URL, token, arbitrary keys) can never travel in a
 * report. The parser below still validates that shape instead of trusting it,
 * because a malformed payload must be ignored, not projected into the DOM.
 * ------------------------------------------------------------------------- */

/** Provenance of one resolved budget field (`DerivedBudget` sources). */
export type BudgetSource = 'user' | 'default' | 'derived' | 'inherited';

/** Budget field names that may appear as provenance keys or leaf arrays. */
export type BudgetFieldName =
  | 'context_window'
  | 'max_output_tokens'
  | 'compaction_enabled'
  | 'threshold_ratio'
  | 'headroom'
  | 'retain_ratio'
  | 'summary_max_tokens'
  | 'message_budget'
  | 'pressure'
  | 'threshold'
  | 'retain';

export interface BudgetProvenanceEntry {
  source: BudgetSource;
  /** Budget field names this value was derived from, when recorded. */
  derivedFrom?: BudgetFieldName[];
}

export interface BudgetCompactionSnapshot {
  enabled?: boolean;
  thresholdRatio?: number;
  headroom?: number;
  retainRatio?: number;
  summaryMaxTokens?: number;
}

export interface BudgetComputedSnapshot {
  messageBudget?: number;
  pressure?: number;
  threshold?: number;
  retain?: number;
}

/** Presentation-safe budget snapshot (`DerivedBudget.safe_report()` shape). */
export interface BudgetSnapshot {
  contextWindow?: number;
  maxOutputTokens?: number;
  compaction?: BudgetCompactionSnapshot;
  computed?: BudgetComputedSnapshot;
  provenance?: Partial<Record<BudgetFieldName, BudgetProvenanceEntry>>;
}

/**
 * One leaf of a reported configuration difference. Values are limited to
 * scalars, known enum strings, and arrays of known budget field names so the
 * report can never smuggle an unknown key or opaque payload to a renderer.
 */
export type ConfigurationDifferenceValue =
  | null
  | boolean
  | number
  | string
  | BudgetFieldName[]
  | { [key: string]: ConfigurationDifferenceValue };

export interface ConfigurationDifference {
  active: ConfigurationDifferenceValue;
  desired: ConfigurationDifferenceValue;
}

export type ConfigurationState =
  'active' | 'pending-next-runtime' | 'not-started' | 'snapshot-unavailable';

/** Only a proven observation may ever leave the `not-observable` default. */
export type ConfigurationCompactionState = 'disabled' | 'not-observable';

/** Safe, read-only effective-configuration report emitted by the runtime. */
export interface ConfigurationReport {
  /** Identity of the Jupyter-server runtime lifetime (not a credential). */
  runtimeLifetime: string;
  /** Monotonic configuration generation within that lifetime. */
  generation: number;
  state: ConfigurationState;
  active: BudgetSnapshot | null;
  desired: BudgetSnapshot | null;
  differences: Record<string, ConfigurationDifference>;
  compaction: ConfigurationCompactionState;
  preflightApplied: boolean;
}

export interface AgentConfigurationEvent {
  type: 'configuration';
  report: ConfigurationReport;
}

/**
 * Non-fatal configuration refresh failure. The runtime emits this on a side
 * channel when settings cannot be read; it must not be projected as a turn
 * error, block, or busy-state change. Any server-supplied message is ignored so
 * an arbitrary (possibly secret-bearing) string never reaches the DOM; the UI
 * renders a fixed frontend string instead.
 */
export interface AgentConfigurationErrorEvent {
  type: 'configuration-error';
}

/** Client request for a fresh configuration report; never a turn message. */
export interface AgentConfigurationRequestMessage {
  type: 'configuration';
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
  | AgentExecErrorEvent
  | AgentConfigurationEvent
  | AgentConfigurationErrorEvent;

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
    case 'configuration':
    case 'configuration-error':
      return blocks;
    // Runtime boundary: an unexpected payload from a newer backend must be
    // ignored, never treated as a valid event or allowed to replace `blocks`
    // with `undefined`. Keep the cases above exhaustive so declared events
    // stay type-checked; this fallback only guards unknown wire data.
    default:
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

const BUDGET_SOURCES: readonly BudgetSource[] = [
  'user',
  'default',
  'derived',
  'inherited'
];
const BUDGET_FIELD_NAMES: readonly BudgetFieldName[] = [
  'context_window',
  'max_output_tokens',
  'compaction_enabled',
  'threshold_ratio',
  'headroom',
  'retain_ratio',
  'summary_max_tokens',
  'message_budget',
  'pressure',
  'threshold',
  'retain'
];
const CONFIGURATION_STATES: readonly ConfigurationState[] = [
  'active',
  'pending-next-runtime',
  'not-started',
  'snapshot-unavailable'
];
const CONFIGURATION_COMPACTION_STATES: readonly ConfigurationCompactionState[] =
  ['disabled', 'not-observable'];
const BUDGET_SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  'contextWindow',
  'maxOutputTokens',
  'compaction',
  'computed',
  'provenance'
]);
const COMPACTION_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'thresholdRatio',
  'headroom',
  'retainRatio',
  'summaryMaxTokens'
]);
const COMPUTED_KEYS: ReadonlySet<string> = new Set([
  'messageBudget',
  'pressure',
  'threshold',
  'retain'
]);
// The only key vocabulary a difference path or nested difference value may
// use. Anything else means the payload carries an unknown configuration key,
// which is dropped at the boundary instead of reaching a renderer.
const CONFIGURATION_KEYS: ReadonlySet<string> = new Set<string>([
  ...BUDGET_FIELD_NAMES,
  ...BUDGET_SNAPSHOT_KEYS,
  ...COMPACTION_KEYS,
  ...COMPUTED_KEYS,
  'source',
  'derivedFrom'
]);
const RUNTIME_LIFETIME_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_DERIVED_FROM = 32;
const MAX_DIFFERENCES = 256;
const MAX_DIFFERENCE_DEPTH = 6;

function requireNonNegativeInteger(
  source: Record<string, unknown>,
  key: string
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DshPayloadError(key);
  }
  return value;
}

function requireNonNegativeNumber(
  source: Record<string, unknown>,
  key: string
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DshPayloadError(key);
  }
  return value;
}

function readBudgetFieldNames(value: unknown, key: string): BudgetFieldName[] {
  if (!Array.isArray(value) || value.length > MAX_DERIVED_FROM) {
    throw new DshPayloadError(key);
  }
  const names: BudgetFieldName[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !BUDGET_FIELD_NAMES.includes(item as BudgetFieldName)
    ) {
      throw new DshPayloadError(key);
    }
    names.push(item as BudgetFieldName);
  }
  return names;
}

function readProvenanceEntry(value: unknown): BudgetProvenanceEntry {
  if (!isRecord(value)) {
    throw new DshPayloadError('provenance');
  }
  const source = requireEnum(value, 'source', BUDGET_SOURCES);
  const derivedFrom = value.derivedFrom;
  if (derivedFrom === undefined) {
    return { source };
  }
  return {
    source,
    derivedFrom: readBudgetFieldNames(derivedFrom, 'derivedFrom')
  };
}

function readCompactionSnapshot(value: unknown): BudgetCompactionSnapshot {
  if (!isRecord(value)) {
    throw new DshPayloadError('compaction');
  }
  for (const key of Object.keys(value)) {
    if (!COMPACTION_KEYS.has(key)) {
      throw new DshPayloadError(key);
    }
  }
  const snapshot: BudgetCompactionSnapshot = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new DshPayloadError('enabled');
    }
    snapshot.enabled = value.enabled;
  }
  if (value.thresholdRatio !== undefined) {
    snapshot.thresholdRatio = requireNonNegativeNumber(value, 'thresholdRatio');
  }
  if (value.headroom !== undefined) {
    snapshot.headroom = requireNonNegativeInteger(value, 'headroom');
  }
  if (value.retainRatio !== undefined) {
    snapshot.retainRatio = requireNonNegativeNumber(value, 'retainRatio');
  }
  if (value.summaryMaxTokens !== undefined) {
    snapshot.summaryMaxTokens = requireNonNegativeInteger(
      value,
      'summaryMaxTokens'
    );
  }
  return snapshot;
}

function readComputedSnapshot(value: unknown): BudgetComputedSnapshot {
  if (!isRecord(value)) {
    throw new DshPayloadError('computed');
  }
  for (const key of Object.keys(value)) {
    if (!COMPUTED_KEYS.has(key)) {
      throw new DshPayloadError(key);
    }
  }
  const snapshot: BudgetComputedSnapshot = {};
  for (const key of COMPUTED_KEYS) {
    if (value[key] !== undefined) {
      snapshot[key as keyof BudgetComputedSnapshot] = requireNonNegativeInteger(
        value,
        key
      );
    }
  }
  return snapshot;
}

function readBudgetSnapshot(value: unknown): BudgetSnapshot {
  if (!isRecord(value)) {
    throw new DshPayloadError('budget');
  }
  for (const key of Object.keys(value)) {
    if (!BUDGET_SNAPSHOT_KEYS.has(key)) {
      throw new DshPayloadError(key);
    }
  }
  const snapshot: BudgetSnapshot = {};
  if (value.contextWindow !== undefined) {
    snapshot.contextWindow = requireNonNegativeInteger(value, 'contextWindow');
  }
  if (value.maxOutputTokens !== undefined) {
    snapshot.maxOutputTokens = requireNonNegativeInteger(
      value,
      'maxOutputTokens'
    );
  }
  if (value.compaction !== undefined) {
    snapshot.compaction = readCompactionSnapshot(value.compaction);
  }
  if (value.computed !== undefined) {
    snapshot.computed = readComputedSnapshot(value.computed);
  }
  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance)) {
      throw new DshPayloadError('provenance');
    }
    const provenance: Partial<Record<BudgetFieldName, BudgetProvenanceEntry>> =
      {};
    for (const [name, entry] of Object.entries(value.provenance)) {
      if (!BUDGET_FIELD_NAMES.includes(name as BudgetFieldName)) {
        throw new DshPayloadError(name);
      }
      provenance[name as BudgetFieldName] = readProvenanceEntry(entry);
    }
    snapshot.provenance = provenance;
  }
  return snapshot;
}

function readDifferenceValue(
  value: unknown,
  depth: number
): ConfigurationDifferenceValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new DshPayloadError('difference');
    }
    return value;
  }
  if (typeof value === 'string') {
    if (
      !BUDGET_SOURCES.includes(value as BudgetSource) &&
      !BUDGET_FIELD_NAMES.includes(value as BudgetFieldName)
    ) {
      throw new DshPayloadError('difference');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return readBudgetFieldNames(value, 'difference');
  }
  if (isRecord(value)) {
    if (depth >= MAX_DIFFERENCE_DEPTH) {
      throw new DshPayloadError('difference');
    }
    const nested: Record<string, ConfigurationDifferenceValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!CONFIGURATION_KEYS.has(key)) {
        throw new DshPayloadError(key);
      }
      nested[key] = readDifferenceValue(entry, depth + 1);
    }
    return nested;
  }
  throw new DshPayloadError('difference');
}

function isConfigurationPath(path: string): boolean {
  if (path === '') return true;
  return path.split('.').every(segment => CONFIGURATION_KEYS.has(segment));
}

function readDifferences(
  value: unknown
): Record<string, ConfigurationDifference> {
  if (!isRecord(value)) {
    throw new DshPayloadError('differences');
  }
  const paths = Object.keys(value);
  if (paths.length > MAX_DIFFERENCES) {
    throw new DshPayloadError('differences');
  }
  const differences: Record<string, ConfigurationDifference> = {};
  for (const path of paths) {
    if (!isConfigurationPath(path)) {
      throw new DshPayloadError(path);
    }
    const entry = value[path];
    if (!isRecord(entry) || !('active' in entry) || !('desired' in entry)) {
      throw new DshPayloadError(path);
    }
    if (Object.keys(entry).length !== 2) {
      throw new DshPayloadError(path);
    }
    differences[path] = {
      active: readDifferenceValue(entry.active, 0),
      desired: readDifferenceValue(entry.desired, 0)
    };
  }
  return differences;
}

function readConfigurationReport(raw: unknown): ConfigurationReport {
  if (!isRecord(raw)) {
    throw new DshPayloadError('report');
  }
  const runtimeLifetime = raw.runtimeLifetime;
  if (
    typeof runtimeLifetime !== 'string' ||
    !RUNTIME_LIFETIME_PATTERN.test(runtimeLifetime)
  ) {
    throw new DshPayloadError('runtimeLifetime');
  }
  if (!('active' in raw) || !('desired' in raw)) {
    throw new DshPayloadError('active');
  }
  const preflightApplied = raw.preflightApplied;
  if (typeof preflightApplied !== 'boolean') {
    throw new DshPayloadError('preflightApplied');
  }
  return {
    runtimeLifetime,
    generation: requireNonNegativeInteger(raw, 'generation'),
    state: requireEnum(raw, 'state', CONFIGURATION_STATES),
    active: raw.active === null ? null : readBudgetSnapshot(raw.active),
    desired: raw.desired === null ? null : readBudgetSnapshot(raw.desired),
    differences: readDifferences(raw.differences),
    compaction: requireEnum(raw, 'compaction', CONFIGURATION_COMPACTION_STATES),
    preflightApplied
  };
}

/**
 * Validate an untrusted `configuration` report payload. Returns `null` for any
 * malformed, unknown-key, or non-enum value so a bad report is ignored instead
 * of being partially forwarded; it never throws.
 */
export function parseConfigurationReport(
  raw: unknown
): ConfigurationReport | null {
  try {
    return readConfigurationReport(raw);
  } catch (error) {
    if (error instanceof DshPayloadError) {
      return null;
    }
    throw error;
  }
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
