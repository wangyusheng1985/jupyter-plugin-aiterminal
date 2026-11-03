import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import {
  AGENT_WS_PATH,
  DSH_EVENT_NAMESPACE,
  applyServerEvent,
  parseDshProductEvent,
  type AgentClientMessage,
  type AgentExecDoneEvent,
  type AgentServerEvent,
  type AgentContextState,
  type ChatBlock,
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
  dshSessionId?: string | null
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
  acceptedTurnId: string | null = null;
  execCwd: string | null = null;
  execOutput = '';
  sessionId: string | null;
  contextState: AgentContextState = 'connecting';
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 15000;
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
  }

  connect(): void {
    if (this.socket) return;
    // Keep a periodic liveness check running for as long as a connection is
    // expected, so a closed socket is healed even without a manual send.
    this.startHeartbeat();
    if (this.contextState !== 'reset') {
      this.contextState = 'connecting';
    }
    // A new socket generation must re-establish DSH attach and capabilities;
    // the durable session identity survives the reconnect.
    this.dshAttachedRuntime = null;
    this.dshPhase = null;
    this.dshCapabilities = null;
    const socket = new this.settings.WebSocket(
      agentSocketUrl(this.settings, this.cwd, this.sessionId, this.dshSession)
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

  close(): void {
    this.stopHeartbeat();
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
    // A socket that has already closed or is closing can never deliver this
    // frame. Drop it and reconnect instead of failing the message for good,
    // so a dropped WebSocket does not permanently wedge future commands.
    const stale = this.socket;
    if (
      stale &&
      stale.readyState !== WebSocket.OPEN &&
      stale.readyState !== WebSocket.CONNECTING
    ) {
      this.socket = null;
      this.connected = false;
      this.detachSocket(stale);
    }
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

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    // A live interval keeps a Node-hosted test runner alive, which Jest
    // reports as an open-handle leak. Production runs in the browser, where
    // the page owns the timer; tests rely on explicit sends/reconnects.
    if (AgentSession.isTestEnvironment()) return;
    const timer = setInterval(
      () => this.checkConnection(),
      AgentSession.HEARTBEAT_INTERVAL_MS
    );
    // A non-browser host must not stay alive just because a session is open.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
    this.heartbeatTimer = timer;
  }

  private static isTestEnvironment(): boolean {
    const nodeProcess = (
      globalThis as {
        process?: { env?: { JEST_WORKER_ID?: string } };
      }
    ).process;
    return Boolean(nodeProcess?.env?.JEST_WORKER_ID);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * Reconnect when the socket has died but a connection is still expected.
   * The heartbeat only runs while a connection is wanted (it is stopped by
   * {@link close}), so a missing or closed socket here means recovery is due.
   */
  private checkConnection(): void {
    const socket = this.socket;
    if (
      socket &&
      socket.readyState !== WebSocket.OPEN &&
      socket.readyState !== WebSocket.CONNECTING
    ) {
      this.socket = null;
      this.connected = false;
      this.detachSocket(socket);
    }
    if (this.socket) return;
    try {
      this.connect();
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : 'Agent Workspace could not reconnect.';
      this.connected = false;
    }
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
>;

function isTurnScopedEvent(
  event: AgentServerEvent
): event is TurnScopedAgentEvent {
  return !(
    event.type === 'ready' ||
    event.type === 'exec_output' ||
    event.type === 'exec_done' ||
    event.type === 'exec_error'
  );
}
