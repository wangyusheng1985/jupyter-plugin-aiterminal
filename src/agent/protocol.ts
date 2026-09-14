export const AGENT_WS_PATH = 'aiterminal/agent';

export type WorkspaceMode = 'ai' | 'command';

export interface AgentUserMessage {
  type: 'user';
  text: string;
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
  model: string;
  cwd: string;
}

export interface AgentErrorEvent {
  type: 'error';
  code: 'config' | 'runtime' | 'denied';
  message: string;
}

export interface AgentTextEvent {
  type: 'text';
  text: string;
}

export interface AgentToolStartEvent {
  type: 'tool_start';
  id: string;
  name: string;
  input: unknown;
}

export interface AgentToolEndEvent {
  type: 'tool_end';
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export interface AgentInstallEvent {
  type: 'install';
  command: string;
  status: 'started' | 'ok' | 'failed';
  detail?: string;
}

export interface AgentDeniedEvent {
  type: 'denied';
  command: string;
  reason: string;
}

export interface AgentResultEvent {
  type: 'result';
  text: string;
  isError?: boolean;
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
  | AgentErrorEvent
  | AgentTextEvent
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
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      output: string;
      status: 'running' | 'done' | 'error';
    }
  | {
      kind: 'install';
      id: string;
      command: string;
      status: 'started' | 'ok' | 'failed';
      detail: string;
    }
  | { kind: 'denied'; id: string; command: string; reason: string }
  | { kind: 'error'; id: string; message: string };

export function applyServerEvent(
  blocks: ChatBlock[],
  event: AgentServerEvent
): ChatBlock[] {
  switch (event.type) {
    case 'text':
      return [
        ...blocks,
        { kind: 'text', id: nextId('text'), text: event.text }
      ];
    case 'tool_start':
      return [
        ...blocks,
        {
          kind: 'tool',
          id: event.id,
          name: event.name,
          input: event.input,
          output: '',
          status: 'running'
        }
      ];
    case 'tool_end':
      return blocks.map(block =>
        block.kind === 'tool' && block.id === event.id
          ? {
              ...block,
              output: event.output,
              status: event.isError ? 'error' : 'done'
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
        { kind: 'error', id: nextId('error'), message: event.message }
      ];
    case 'result':
      return event.isError && event.text
        ? [
            ...blocks,
            { kind: 'error', id: nextId('result'), message: event.text }
          ]
        : blocks;
    case 'ready':
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
