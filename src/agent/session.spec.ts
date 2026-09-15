import { AgentSession } from './session';

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

function sessionWithSocket(): {
  session: AgentSession;
  socket: FakeWebSocket;
} {
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
  return { session, socket: created[0] };
}

describe('AgentSession', () => {
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
    expect(socket.sent[socket.sent.length - 1]).toBe(
      JSON.stringify({ type: 'user', text: 'try again' })
    );
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
