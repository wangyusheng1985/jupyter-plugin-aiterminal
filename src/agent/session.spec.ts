import { AgentSession, agentSocketUrl } from './session';
import type { HistoryBridgeCapsule } from './history-bridge';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function sessionWithSocket(sessionId: string | null = null): {
  session: AgentSession;
  socket: FakeWebSocket;
} {
  const created: FakeWebSocket[] = [];
  const session = new AgentSession(
    {
      wsUrl: 'ws://example',
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) {
          super(url);
          created.push(this);
        }
      },
      appendToken: false,
      token: ''
    } as never,
    undefined,
    sessionId
  );
  session.connect();
  return { session, socket: created[0] };
}

describe('AgentSession', () => {
  const historyBridge: HistoryBridgeCapsule = {
    version: 1,
    turns: [
      {
        cellId: 'cell-1',
        source: 'inspect disk',
        status: 'done',
        outcome: 'cleanup is still running',
        taskIds: ['task-1']
      }
    ],
    tasks: [
      {
        cellId: 'cell-1',
        taskId: 'task-1',
        outputPath: '/tmp/task-1.output',
        state: 'running'
      }
    ],
    omittedTurnCount: 0,
    omittedTaskCount: 0,
    truncatedFieldCount: 0
  };

  it('encodes saved context in the socket URL without affecting cwd or token', () => {
    expect(
      agentSocketUrl(
        {
          wsUrl: 'ws://example/base',
          appendToken: true,
          token: 'token value'
        } as never,
        'folder name',
        '123e4567-e89b-12d3-a456-426614174000'
      )
    ).toBe(
      'ws://example/base/aiterminal/agent?cwd=folder%20name&sessionId=123e4567-e89b-12d3-a456-426614174000&token=token%20value'
    );
  });

  it('tracks real new, resumed, live, and unavailable context state', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const { session, socket } = sessionWithSocket(id);
    expect(socket.url).toContain(`sessionId=${id}`);
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'ready',
        sessionId: id,
        contextState: 'resumed',
        model: 'model',
        cwd: '/work'
      })
    });
    expect(session.contextState).toBe('resumed');
    expect(session.sessionId).toBe(id);

    session.sendUser('continue', 'run-1');
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'result',
        turnId: 'run-1',
        text: 'done',
        sessionId: id
      })
    });
    expect(session.contextState).toBe('live');

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        code: 'resume',
        message: 'session unavailable'
      })
    });
    expect(session.contextState).toBe('unavailable');
    const sent = socket.sent.length;
    session.sendUser('must not send');
    expect(socket.sent).toHaveLength(sent);
    expect(session.error).toContain('Start a new context');
  });

  it('queues a structured history bridge without changing source or turn ID', () => {
    const { session, socket } = sessionWithSocket();

    session.sendUser('  结果如何了？  ', 'run-bridge', historyBridge);
    expect(session.turn?.id).toBe('run-bridge');
    expect(socket.sent).toEqual([]);

    socket.open();

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'user',
        turnId: 'run-bridge',
        text: '结果如何了？',
        historyBridge
      })
    ]);
  });

  it('tracks SDK acceptance only for the active turn', () => {
    const { session, socket } = sessionWithSocket();
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    socket.open();
    session.sendUser('continue', 'run-active', historyBridge);

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'accepted',
        turnId: 'run-stale',
        sessionId
      })
    });
    expect(session.acceptedTurnId).toBeNull();

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'accepted',
        turnId: 'run-active',
        sessionId
      })
    });
    expect(session.acceptedTurnId).toBe('run-active');
    expect(session.sessionId).toBe(sessionId);
    expect(session.running).toBe(true);
    expect(session.turn?.id).toBe('run-active');
    expect(session.blocks).toEqual([]);
  });

  it('preserves bridge source and turn ID after socket reconnection', () => {
    const created: FakeWebSocket[] = [];
    const session = new AgentSession({
      wsUrl: 'ws://example',
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) {
          super(url);
          created.push(this);
        }
      },
      appendToken: false,
      token: ''
    } as never);
    session.connect();
    created[0].open();
    created[0].close();

    session.sendUser('follow up', 'run-reconnect', historyBridge);
    expect(created).toHaveLength(2);
    created[1].open();

    expect(JSON.parse(created[1].sent[0])).toEqual({
      type: 'user',
      turnId: 'run-reconnect',
      text: 'follow up',
      historyBridge
    });
  });

  it('resets context by reconnecting without the previous session id', () => {
    const created: FakeWebSocket[] = [];
    const session = new AgentSession(
      {
        wsUrl: 'ws://example',
        WebSocket: class extends FakeWebSocket {
          constructor(url: string) {
            super(url);
            created.push(this);
          }
        },
        appendToken: false,
        token: ''
      } as never,
      undefined,
      '123e4567-e89b-12d3-a456-426614174000'
    );
    session.connect();
    created[0].open();

    session.resetContext();

    expect(created).toHaveLength(2);
    expect(created[1].url).not.toContain('sessionId=');
    expect(session.sessionId).toBeNull();
    expect(session.contextState).toBe('reset');
  });

  it('keeps config feedback out of Command execution and resets it for a later AI run', async () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        code: 'config',
        message:
          'AI Terminal settings are missing. Open Settings → AI Terminal and set Base URL, Model, and API Token.'
      })
    });
    expect(session.blocks[0]).toMatchObject({
      kind: 'error',
      code: 'config'
    });

    const command = session.exec('pwd');
    expect(socket.sent[socket.sent.length - 1]).toBe(
      JSON.stringify({ type: 'exec', text: 'pwd' })
    );
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'exec_done',
        output: '/root\n',
        returncode: 0,
        cwd: '/root'
      })
    });
    await expect(command).resolves.toMatchObject({ output: '/root\n' });

    session.sendUser('try again');
    expect(session.error).toBeNull();
    expect(session.blocks).toEqual([]);
    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toMatchObject({
      type: 'user',
      text: 'try again',
      turnId: expect.any(String)
    });
  });

  it('ignores events belonging to a different active turn', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    session.sendUser('first', 'run-1');
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'text',
        turnId: 'run-2',
        text: 'wrong cell'
      })
    });
    expect(session.blocks).toEqual([]);

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'text',
        turnId: 'run-1',
        text: 'first answer'
      })
    });
    expect(session.blocks).toEqual([
      {
        kind: 'text',
        id: expect.stringContaining('text'),
        text: 'first answer'
      }
    ]);
  });

  it('connects on first exec if start was skipped', async () => {
    const created: FakeWebSocket[] = [];
    const session = new AgentSession({
      wsUrl: 'ws://example',
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) {
          super(url);
          created.push(this);
        }
      },
      appendToken: false,
      token: ''
    } as never);
    const pending = session.exec('pwd');

    expect(session.error).toBeNull();
    expect(created).toHaveLength(1);
    created[0].open();
    expect(created[0].sent).toEqual([
      JSON.stringify({ type: 'exec', text: 'pwd' })
    ]);

    created[0].onmessage?.({
      data: JSON.stringify({
        type: 'exec_done',
        output: '/root\n',
        returncode: 0,
        cwd: '/root'
      })
    });
    await expect(pending).resolves.toEqual({
      output: '/root\n',
      returncode: 0,
      cwd: '/root'
    });
  });

  it('queues exec until the socket opens instead of failing disconnected', async () => {
    const { session, socket } = sessionWithSocket();
    const pending = session.exec('pwd');

    expect(session.error).toBeNull();
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'exec', text: 'pwd' })
    ]);

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'exec_done',
        output: '/root\n',
        returncode: 0,
        cwd: '/root'
      })
    });
    await expect(pending).resolves.toEqual({
      output: '/root\n',
      returncode: 0,
      cwd: '/root'
    });
  });

  it('reconnects and queues exec after the socket closes', async () => {
    const created: FakeWebSocket[] = [];
    const session = new AgentSession({
      wsUrl: 'ws://example',
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) {
          super(url);
          created.push(this);
        }
      },
      appendToken: false,
      token: ''
    } as never);
    session.connect();
    created[0].open();
    created[0].close();

    const pending = session.exec('echo hi');
    expect(session.error).toBeNull();
    expect(created).toHaveLength(2);

    created[1].open();
    expect(created[1].sent).toEqual([
      JSON.stringify({ type: 'exec', text: 'echo hi' })
    ]);

    created[1].onmessage?.({
      data: JSON.stringify({
        type: 'exec_done',
        output: 'hi\n',
        returncode: 0,
        cwd: '/root'
      })
    });
    await expect(pending).resolves.toEqual({
      output: 'hi\n',
      returncode: 0,
      cwd: '/root'
    });
  });
});
