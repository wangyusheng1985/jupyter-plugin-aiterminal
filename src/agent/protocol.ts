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
