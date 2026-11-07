import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import {
  AGENT_WS_PATH,
  DSH_EVENT_NAMESPACE,
  applyServerEvent,
  parseConfigurationReport,
  parseDshProductEvent,
  type AgentClientMessage,
  type AgentConfigurationRequestMessage,
  type AgentExecDoneEvent,
  type AgentServerEvent,
  type AgentContextState,
  type ChatBlock,
  type ConfigurationReport,
  type DshCapabilityManifest,
  type DshInteractionResolution,
  type DshProductEvent,
  type DshSessionPhase
} from './protocol';
import { applyTurnEvent, createTurn, type ChatTurn } from './turn';
import type { HistoryBridgeCapsule } from './history-bridge';

export function agentSocketUrl(
  settings: ServerConnection.ISettings = ServerConnection.makeSettings(),
  cwd?: string,
  sessionId?: string | null,
  dshSessionId?: string | null,
  workspacePath?: string | null
): string {
  let url = URLExt.join(settings.wsUrl, AGENT_WS_PATH);
  if (cwd) url += `?cwd=${encodeURIComponent(cwd)}`;
  // A durable DSH session and the legacy Pi `sessionId` are mutually exclusive
  // resume identities. Sending both makes the backend reject the handshake
  // (legacy IDs are only tolerated when they equal the DSH id), which would
  // turn a resumable DSH session into an unavailable context. When a DSH
  // session is set it is the only resume parameter; otherwise the legacy id is
  // still sent verbatim so the backend can explicitly reject an old id instead
  // of this client silently converting it.
  if (sessionId && !dshSessionId) {
    url += `${url.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(
      sessionId
    )}`;
  }
  // The durable DSH session is a distinct transport identity from the legacy
  // Pi `sessionId`. It is sent as its own parameter so a backend that does not
  // implement DSH cannot mistake it for a legacy resume request.
  if (dshSessionId) {
    url += `${url.includes('?') ? '&' : '?'}dshSessionId=${encodeURIComponent(
      dshSessionId
    )}`;
  }
  if (workspacePath) {
    url += `${url.includes('?') ? '&' : '?'}workspacePath=${encodeURIComponent(
      workspacePath
    )}`;
  }
  if (settings.appendToken && settings.token) {
    const token = URLExt.objectToQueryString({ token: settings.token });
    url += `${url.includes('?') ? '&' : ''}${token.replace(/^\?/, '')}`;
  }
  return url;
}

export interface ExecResult {
  output: string;
  returncode: number;
  cwd: string;
}

/**
 * Fixed frontend copy for a non-fatal configuration refresh failure. The
 * backend's own message is never rendered: it could carry settings or
 * credential text, so only this constant reaches the DOM.
 */
const CONFIGURATION_ERROR_MESSAGE =
  'AI Terminal configuration could not be refreshed; the current turn keeps running. Save the fix, then start a new runtime to apply it.';

/**
 * Identity of the interaction a decision belongs to. `sessionId`/`runtimeId`
 * are checked against the current DSH binding; `runId` is forwarded untouched
 * because the session does not track individual runs. The `requestId` key from
 * the workspace's `InteractionScope` is accepted redundantly but ignored, since
 * the request id is already the first argument.
 */
export interface DshInteractionDecisionScope {
  sessionId?: string;
  runtimeId?: string;
  runId?: string;
  requestId?: string;
}

interface DshInteractionResolveMessage {
  type: 'dsh/v1/interaction.resolve';
  requestId: string;
  resolution: DshInteractionResolution;
  scope: { sessionId: string; runtimeId: string; runId?: string };
}

export class AgentSession {
  blocks: ChatBlock[] = [];
  turn: ChatTurn | null = null;
  connected = false;
  error: string | null = null;
  running = false;
  activeTurnId: string | null = null;
  activeCellId: string | null = null;
  acceptedTurnId: string | null = null;
  execCwd: string | null = null;
  execOutput = '';
  sessionId: string | null;
  workspacePath: string | null = null;
  contextState: AgentContextState = 'connecting';
  private socket: WebSocket | null = null;
  private pending: Array<AgentClientMessage | DshInteractionResolveMessage> =
    [];
  private readonly listeners = new Set<() => void>();
  private readonly dshSubscribers = new Set<(event: DshProductEvent) => void>();
  private dshRuntime: string | null = null;
  private dshSession: string | null = null;
  private dshPhase: DshSessionPhase | null = null;
  private dshAttachedRuntime: string | null = null;
  private dshCapabilities: DshCapabilityManifest | null = null;
  // runtimeId is an opaque token and cannot be ordered; keep a bounded set of
  // retired generations so a stale handshake cannot re-adopt an old runtime.
  private readonly dshRetiredRuntimes = new Set<string>();
  private static readonly MAX_RETIRED_RUNTIMES = 64;
  private execWaiters: Array<{
    resolve: (result: ExecResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private configuration: ConfigurationReport | null = null;
  private configurationErrorState: string | null = null;

  constructor(
    private readonly settings: ServerConnection.ISettings = ServerConnection.makeSettings(),
    private readonly cwd?: string,
    sessionId: string | null = null
  ) {
    this.sessionId = sessionId;
  }

  configureContext(sessionId: string | null): void {
    if (this.socket) {
      throw new Error('Agent context must be configured before connecting.');
    }
    this.sessionId = sessionId;
    this.contextState = 'connecting';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to validated `dsh/v1` product events. Subscribers persist across
   * socket reconnects (matching {@link subscribe}) and are only removed by the
   * returned unsubscribe function or {@link dispose}.
   */
  subscribeDsh(listener: (event: DshProductEvent) => void): () => void {
    this.dshSubscribers.add(listener);
    return () => this.dshSubscribers.delete(listener);
  }

  /** Latest observed runtime connection generation; not the durable session. */
  get dshRuntimeId(): string | null {
    return this.dshRuntime;
  }

  /** Durable DSH session bound to this connection; survives reconnects. */
  get dshSessionId(): string | null {
    return this.dshSession;
  }

  get dshSessionPhase(): DshSessionPhase | null {
    return this.dshPhase;
  }

  /** Capability manifest announced by the runtime handshake, if any. */
  get dshCapabilityManifest(): DshCapabilityManifest | null {
    return this.dshCapabilities;
  }
  /**
   * Latest validated effective-configuration report, or `null` until the
   * runtime sends one. Read-only: only validated `configuration` events from
   * the current socket may update it, and it is never derived from a turn.
   */
  get configurationReport(): ConfigurationReport | null {
    return this.configuration;
  }

  /**
   * Non-fatal configuration refresh failure, or `null`. It never modifies
   * blocks, turn, running, error, or context state, and it is cleared by the
   * next successfully validated configuration report.
   */
  get configurationError(): string | null {
    return this.configurationErrorState;
  }

  /**
   * Bind the expected durable DSH session before connecting. The value is
   * transmitted as the independent `dshSessionId` query parameter (never mixed
   * into the legacy `sessionId`). This connection carries one session;
   * multiplexing several sessions over one socket is not supported, so a
   * handshake for a different session is refused instead of silently
   * switching the current one.
   */
  configureDshSession(sessionId: string | null): void {
    if (this.socket) {
      throw new Error('DSH session must be configured before connecting.');
    }
    this.dshSession = sessionId;
    this.dshPhase = null;
    this.dshAttachedRuntime = null;
  }

  configureWorkspacePath(workspacePath: string | null): void {
    if (this.socket) {
      throw new Error('Workspace path must be configured before connecting.');
    }
    this.workspacePath = workspacePath;
  }

  /** Terminal teardown: closes the socket and drops every subscriber. */
  dispose(): void {
    this.close();
    this.dshSubscribers.clear();
    this.listeners.clear();
    this.dshRuntime = null;
    this.dshSession = null;
    this.dshPhase = null;
    this.dshAttachedRuntime = null;
    this.dshCapabilities = null;
    this.dshRetiredRuntimes.clear();
    this.configuration = null;
    this.configurationErrorState = null;
  }

  connect(): void {
    if (this.socket) return;
    if (this.contextState !== 'reset') {
      this.contextState = 'connecting';
    }
    // A new socket generation must re-establish DSH attach and capabilities;
    // the durable session identity survives the reconnect.
    this.dshAttachedRuntime = null;
    this.dshPhase = null;
    this.dshCapabilities = null;
    const socket = new this.settings.WebSocket(
      agentSocketUrl(
        this.settings,
        this.cwd,
        this.sessionId,
        this.dshSession,
        this.workspacePath
      )
    );
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.connected = true;
      this.pending
        .splice(0)
        .forEach(message => socket.send(JSON.stringify(message)));
      this.notify();
    };
    socket.onmessage = event => {
      if (socket !== this.socket) return;
      const raw = parseJson(event.data);
      if (isDshEnvelope(raw)) {
        // DSH events are validated and dispatched on their own channel; they
        // never reach the legacy applyServerEvent projection.
        this.dispatchDsh(raw);
        this.notify();
        return;
      }
      const payload = raw as AgentServerEvent | null;
      if (!payload) return;
      if (payload.type === 'configuration-error') {
        // Non-fatal side channel: surface a fixed frontend message and return
        // before turn projection so blocks/turn/running/error/context are
        // untouched. This must also never fall through to applyServerEvent.
        this.configurationErrorState = CONFIGURATION_ERROR_MESSAGE;
        this.notify();
        return;
      }
      if (payload.type === 'configuration') {
        // Configuration is a side channel: it is validated on its own and
        // never reaches turn projection, busy state, context, or session id.
        this.applyConfigurationEvent(raw);
        return;
      }
      if (
        this.activeTurnId &&
        isTurnScopedEvent(payload) &&
        payload.turnId &&
        payload.turnId !== this.activeTurnId
      ) {
        return;
      }
      this.blocks = applyServerEvent(this.blocks, payload);
      if (this.turn && isTurnScopedEvent(payload)) {
        this.turn = applyTurnEvent(this.turn, this.blocks, payload);
      }
      if (payload.type === 'error') {
        this.error = payload.message;
        this.running = false;
        if (payload.code === 'resume') {
          this.contextState = 'unavailable';
        }
      }
      if (payload.type === 'result') {
        this.running = false;
        if (payload.sessionId) this.sessionId = payload.sessionId;
        this.contextState = 'live';
      }
      if (payload.type === 'accepted') {
        this.acceptedTurnId = payload.turnId ?? this.activeTurnId;
        this.sessionId = payload.sessionId;
      }
      if (payload.type === 'ready') {
        const requestedResume = Boolean(this.sessionId);
        this.sessionId = payload.sessionId;
        this.contextState =
          payload.contextState ?? (requestedResume ? 'resumed' : 'new');
        this.execCwd = payload.cwd;
      }
      this.handleExecEvent(payload);
      this.notify();
    };
    socket.onerror = () => {
      if (socket !== this.socket) return;
      this.error = 'Agent Workspace could not reach the server.';
      this.running = false;
      this.rejectExec(new Error(this.error));
      this.notify();
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.connected = false;
      this.running = false;
      this.socket = null;
      this.rejectExec(new Error('Agent session closed.'));
      this.notify();
    };
  }

  sendUser(
    text: string,
    turnId = nextTurnId(),
    historyBridge?: HistoryBridgeCapsule
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.contextState === 'unavailable') {
      this.error =
        'Saved Agent context is unavailable. Start a new context before continuing.';
      this.notify();
      return;
    }
    this.blocks = [];
    this.turn = createTurn(turnId);
    this.error = null;
    this.running = true;
    this.activeTurnId = turnId;
    this.acceptedTurnId = null;
    this.send({
      type: 'user',
      turnId,
      text: trimmed,
      ...(this.activeCellId ? { cellId: this.activeCellId } : {}),
      ...(historyBridge ? { historyBridge } : {})
    });
    this.notify();
  }

  exec(text: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.execOutput = '';
      this.execWaiters.push({ resolve, reject });
      this.send({ type: 'exec', text });
    });
  }

  interruptExec(): void {
    this.send({ type: 'exec_interrupt' });
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
    this.notify();
  }

  /**
   * Send one interaction decision to the currently attached DSH runtime.
   *
   * This is only a delivery attempt: WebSocket sends have no acknowledgement,
   * so a resolved promise means the frame was handed to an open socket, never
   * that the runtime received or acted on it. The decision is never queued or
   * replayed: if the socket is closed, the runtime changed, or the scope does
   * not match the current binding, the promise rejects immediately so the
   * interaction coordinator records `deliveryUnknown` instead of resending an
   * approval whose delivery cannot be determined.
   */
  resolveInteraction(
    requestId: string,
    resolution: DshInteractionResolution,
    scope: DshInteractionDecisionScope = {}
  ): Promise<void> {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.dshSession === null ||
      this.dshRuntime === null ||
      this.dshAttachedRuntime !== this.dshRuntime ||
      (this.dshPhase !== 'attached' && this.dshPhase !== 'resumed')
    ) {
      return Promise.reject(
        new Error(
          'The interaction decision was not sent: the DSH session is not connected.'
        )
      );
    }
    if (scope.sessionId != null && scope.sessionId !== this.dshSession) {
      return Promise.reject(
        new Error(
          'The interaction decision was not sent: it belongs to a different session.'
        )
      );
    }
    if (scope.runtimeId != null && scope.runtimeId !== this.dshRuntime) {
      return Promise.reject(
        new Error(
          'The interaction decision was not sent: it belongs to a retired runtime.'
        )
      );
    }
    const message: DshInteractionResolveMessage = {
      type: 'dsh/v1/interaction.resolve',
      requestId,
      resolution,
      scope: {
        sessionId: this.dshSession,
        runtimeId: this.dshRuntime,
        ...(scope.runId ? { runId: scope.runId } : {})
      }
    };
    socket.send(JSON.stringify(message));
    return Promise.resolve();
  }

  /**
   * Ask the runtime for its current safe configuration report.
   *
   * Delivery is best effort and out-of-band: this never starts a turn, never
   * opens a connection, never creates or resumes a context, and is never
   * queued while the socket is missing or still connecting. Returns `true`
   * only when the frame was handed to an open socket, `false` when it was
   * dropped, so callers never report a false success.
   */
  requestConfiguration(): boolean | void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const message: AgentConfigurationRequestMessage = { type: 'configuration' };
    socket.send(JSON.stringify(message));
    return true;
  }

  private applyConfigurationEvent(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const report = parseConfigurationReport(
      (raw as { report?: unknown }).report
    );
    if (!report) return;
    this.configuration = report;
    // A validated report proves the refresh path works again.
    this.configurationErrorState = null;
    this.notify();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.detachSocket(socket);
    this.connected = false;
    this.running = false;
    this.activeTurnId = null;
    this.acceptedTurnId = null;
    this.rejectExec(new Error('Agent session closed.'));
  }

  resetContext(): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'shutdown' }));
      } catch {
        // Best effort
      }
    }
    this.socket = null;
    this.detachSocket(socket);
    this.pending = [];
    this.blocks = [];
    this.turn = null;
    this.connected = false;
    this.error = null;
    this.running = false;
    this.activeTurnId = null;
    this.acceptedTurnId = null;
    this.sessionId = null;
    // A new session must not silently resume the previous DSH session: drop the
    // durable binding and local runtime state so the reconnect URL no longer
    // advertises the old `dshSessionId` and the detached socket's events can no
    // longer re-adopt it.
    this.dshRuntime = null;
    this.dshSession = null;
    this.dshPhase = null;
    this.dshAttachedRuntime = null;
    this.dshCapabilities = null;
    this.configuration = null;
    this.configurationErrorState = null;
    this.contextState = 'reset';
    this.connect();
    this.notify();
  }

  private detachSocket(socket: WebSocket | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }

  private dispatchDsh(raw: unknown): void {
    const result = parseDshProductEvent(raw);
    if (!result.ok) return;
    if (!this.acceptDshEvent(result.event)) return;
    this.dshSubscribers.forEach(listener => {
      try {
        listener(result.event);
      } catch {
        // A failing subscriber must not block other subscribers or legacy state.
      }
    });
  }

  /**
   * Apply DSH identity/attach rules before delivery. Connection generation and
   * durable session are tracked separately; a disconnect or runtime replacement
   * never deletes the session and never synthesizes run.finished.
   */
  private acceptDshEvent(event: DshProductEvent): boolean {
    if (event.type === 'dsh/v1/connection') {
      if (event.phase === 'connected' || event.phase === 'reconnecting') {
        // A retired runtime must never be re-adopted by a stale handshake.
        if (this.dshRetiredRuntimes.has(event.runtimeId)) return false;
        if (this.dshRuntime !== null && this.dshRuntime !== event.runtimeId) {
          // New connection generation: retire the old runtime, drop the stale
          // attach and capabilities; the new generation must handshake again.
          this.retireDshRuntime(this.dshRuntime);
          this.dshAttachedRuntime = null;
          this.dshPhase = null;
          this.dshCapabilities = null;
        }
        this.dshRuntime = event.runtimeId;
        return true;
      }
      // A late end event from a retired/older generation must not clobber runtime.
      if (this.dshRetiredRuntimes.has(event.runtimeId)) return false;
      return this.dshRuntime === null || this.dshRuntime === event.runtimeId;
    }
    if (event.type === 'dsh/v1/capabilities') {
      // Capabilities describe the current runtime only; they never adopt or
      // reset a runtime on their own (that would bypass the handshake).
      if (this.dshRuntime === null || this.dshRuntime !== event.runtimeId) {
        return false;
      }
      if (this.dshRetiredRuntimes.has(event.runtimeId)) return false;
      this.dshCapabilities = event.capabilities;
      return true;
    }
    if (event.type === 'dsh/v1/session') {
      if (this.dshSession !== null && this.dshSession !== event.sessionId) {
        return false;
      }
      if (this.dshRetiredRuntimes.has(event.runtimeId)) return false;
      if (event.phase === 'detached') {
        if (this.dshRuntime !== null && this.dshRuntime !== event.runtimeId) {
          return false;
        }
        this.dshRuntime = event.runtimeId;
        this.dshAttachedRuntime = null;
      } else {
        // attach/resumed may establish the runtime when none is set yet, but a
        // session handshake can never switch away from the current runtime.
        if (this.dshRuntime !== null && this.dshRuntime !== event.runtimeId) {
          return false;
        }
        this.dshRuntime = event.runtimeId;
        this.dshAttachedRuntime = event.runtimeId;
      }
      this.dshSession = event.sessionId;
      this.dshPhase = event.phase;
      return true;
    }
    // Execution events need a matching session handshake on the current runtime.
    return (
      this.dshRuntime !== null &&
      this.dshSession !== null &&
      event.sessionId === this.dshSession &&
      event.runtimeId === this.dshRuntime &&
      this.dshAttachedRuntime === this.dshRuntime &&
      (this.dshPhase === 'attached' || this.dshPhase === 'resumed')
    );
  }

  private retireDshRuntime(runtimeId: string): void {
    this.dshRetiredRuntimes.add(runtimeId);
    while (this.dshRetiredRuntimes.size > AgentSession.MAX_RETIRED_RUNTIMES) {
      const oldest = this.dshRetiredRuntimes.values().next().value;
      if (oldest === undefined) break;
      this.dshRetiredRuntimes.delete(oldest);
    }
  }

  private handleExecEvent(payload: AgentServerEvent): void {
    if (payload.type === 'exec_output') {
      this.execOutput += payload.text;
      return;
    }
    if (payload.type === 'exec_done') {
      this.execCwd = payload.cwd;
      this.execOutput = payload.output;
      const waiter = this.execWaiters.shift();
      waiter?.resolve(toExecResult(payload));
      return;
    }
    if (payload.type === 'exec_error') {
      const waiter = this.execWaiters.shift();
      waiter?.reject(new Error(payload.message));
    }
  }

  private rejectExec(error: Error): void {
    const waiters = this.execWaiters.splice(0);
    waiters.forEach(waiter => waiter.reject(error));
  }

  private send(
    message: AgentClientMessage | DshInteractionResolveMessage
  ): void {
    if (!this.socket) {
      this.connect();
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      this.pending.push(message);
      return;
    }
    this.error = 'Agent session is not connected.';
    this.running = false;
    this.rejectExec(new Error(this.error));
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }
}

function toExecResult(event: AgentExecDoneEvent): ExecResult {
  return {
    output: event.output,
    returncode: event.returncode,
    cwd: event.cwd
  };
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function isDshEnvelope(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { type?: unknown }).type === 'string' &&
    (raw as { type: string }).type.startsWith(`${DSH_EVENT_NAMESPACE}/`)
  );
}

let turnCounter = 0;
function nextTurnId(): string {
  return `turn-${++turnCounter}`;
}

type TurnScopedAgentEvent = Exclude<
  AgentServerEvent,
  | { type: 'ready' }
  | { type: 'exec_output' }
  | { type: 'exec_done' }
  | { type: 'exec_error' }
  | { type: 'configuration' }
>;

function isTurnScopedEvent(
  event: AgentServerEvent
): event is TurnScopedAgentEvent {
  return !(
    event.type === 'ready' ||
    event.type === 'exec_output' ||
    event.type === 'exec_done' ||
    event.type === 'exec_error' ||
    event.type === 'configuration'
  );
}
