import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import {
  AGENT_WS_PATH,
  applyServerEvent,
  type AgentClientMessage,
  type AgentExecDoneEvent,
  type AgentServerEvent,
  type AgentContextState,
  type ChatBlock
} from './protocol';
import { applyTurnEvent, createTurn, type ChatTurn } from './turn';
import type { HistoryBridgeCapsule } from './history-bridge';

export function agentSocketUrl(
  settings: ServerConnection.ISettings = ServerConnection.makeSettings(),
  cwd?: string,
  sessionId?: string | null
): string {
  let url = URLExt.join(settings.wsUrl, AGENT_WS_PATH);
  if (cwd) url += `?cwd=${encodeURIComponent(cwd)}`;
  if (sessionId) {
    url += `${url.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(
      sessionId
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
  private pending: AgentClientMessage[] = [];
  private readonly listeners = new Set<() => void>();
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

  connect(): void {
    if (this.socket) return;
    if (this.contextState !== 'reset') {
      this.contextState = 'connecting';
    }
    const socket = new this.settings.WebSocket(
      agentSocketUrl(this.settings, this.cwd, this.sessionId)
    );
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.pending
        .splice(0)
        .forEach(message => socket.send(JSON.stringify(message)));
      this.notify();
    };
    socket.onmessage = event => {
      const payload = parseEvent(event.data);
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
      this.error = 'Agent Workspace could not reach the server.';
      this.running = false;
      this.rejectExec(new Error(this.error));
      this.notify();
    };
    socket.onclose = () => {
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

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
    this.running = false;
    this.activeTurnId = null;
    this.acceptedTurnId = null;
    this.rejectExec(new Error('Agent session closed.'));
  }

  resetContext(): void {
    const socket = this.socket;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.socket = null;
    this.pending = [];
    this.blocks = [];
    this.turn = null;
    this.connected = false;
    this.error = null;
    this.running = false;
    this.activeTurnId = null;
    this.acceptedTurnId = null;
    this.sessionId = null;
    this.contextState = 'reset';
    this.connect();
    this.notify();
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

  private send(message: AgentClientMessage): void {
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

function parseEvent(data: unknown): AgentServerEvent | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as AgentServerEvent;
  } catch {
    return null;
  }
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
