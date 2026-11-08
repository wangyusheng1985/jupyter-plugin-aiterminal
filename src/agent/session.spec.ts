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

function sessionWithSocket(
  sessionId: string | null = null,
  dshSessionId: string | null = null
): {
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
  session.configureDshSession(dshSessionId);
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

describe('AgentSession DSH channel', () => {
  const sessionId = 'dsh-session-1';
  const runtimeId = 'runtime-1';

  function emit(socket: FakeWebSocket, payload: unknown): void {
    socket.onmessage?.({
      data: typeof payload === 'string' ? payload : JSON.stringify(payload)
    });
  }

  function handshake(socket: FakeWebSocket): void {
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId,
      phase: 'connected'
    });
    emit(socket, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'attached'
    });
  }

  function delta(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      type: 'dsh/v1/text.delta',
      sessionId,
      runtimeId,
      runId: 'run-1',
      messageId: 'msg-1',
      delta: 'hello',
      ...overrides
    };
  }

  it('dispatches validated dsh/v1 events without touching legacy state', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));

    handshake(socket);
    emit(socket, {
      type: 'dsh/v1/capabilities',
      runtimeId,
      capabilities: { text_stream: { status: 'available' } }
    });
    emit(socket, delta());
    emit(socket, {
      type: 'dsh/v1/run.started',
      sessionId,
      runtimeId,
      runId: 'run-1'
    });
    emit(socket, {
      type: 'dsh/v1/run.finished',
      sessionId,
      runtimeId,
      runId: 'run-1',
      status: 'completed'
    });

    expect(received).toEqual([
      'dsh/v1/connection',
      'dsh/v1/session',
      'dsh/v1/capabilities',
      'dsh/v1/text.delta',
      'dsh/v1/run.started',
      'dsh/v1/run.finished'
    ]);
    // A completed run is execution outcome only; nothing is projected as acceptance.
    expect(session.running).toBe(false);
    expect(session.blocks).toEqual([]);
    expect(session.dshSessionId).toBe(sessionId);
    expect(session.dshRuntimeId).toBe(runtimeId);
    expect(session.dshSessionPhase).toBe('attached');
    expect(session.dshCapabilityManifest).toEqual({
      text_stream: { status: 'available' }
    });

    // Bad/unknown DSH payloads are dropped, never forwarded to legacy handling.
    const count = received.length;
    emit(socket, 'not json');
    emit(socket, { type: 'dsh/v2/text.delta', sessionId, runtimeId });
    emit(socket, { type: 'dsh/v1/unknown.event', sessionId, runtimeId });
    emit(socket, { type: 'dsh/v1/text.delta', sessionId, runtimeId });
    emit(socket, JSON.stringify({ type: 'dsh/v1/session' }));
    expect(received).toHaveLength(count);
    expect(session.blocks).toEqual([]);

    // Legacy events keep their existing behaviour on the same socket.
    session.sendUser('legacy', 'legacy-1');
    emit(socket, { type: 'text', turnId: 'legacy-1', text: 'answer' });
    expect(session.blocks).toEqual([
      { kind: 'text', id: expect.stringContaining('text'), text: 'answer' }
    ]);
    expect(received).toHaveLength(count);
  });

  it('requires a session handshake and refuses cross-session events', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));

    // Execution events before the session handshake are ignored.
    emit(socket, delta());
    expect(received).toEqual([]);

    emit(socket, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'resumed'
    });
    emit(socket, delta());
    expect(received).toEqual(['dsh/v1/session', 'dsh/v1/text.delta']);

    // A different session on the same socket is refused, not silently adopted.
    emit(socket, {
      type: 'dsh/v1/session',
      sessionId: 'dsh-session-2',
      runtimeId,
      phase: 'attached'
    });
    emit(socket, delta({ sessionId: 'dsh-session-2', runId: 'run-2' }));
    expect(received).toEqual(['dsh/v1/session', 'dsh/v1/text.delta']);
    expect(session.dshSessionId).toBe(sessionId);

    // A new runtime generation does not delete the durable session, but needs
    // its own handshake before execution events are accepted.
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-2',
      phase: 'connected'
    });
    emit(socket, delta({ runtimeId: 'runtime-2' }));
    expect(session.dshSessionId).toBe(sessionId);
    expect(session.dshRuntimeId).toBe('runtime-2');
    expect(received).toHaveLength(3);

    emit(socket, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId: 'runtime-2',
      phase: 'resumed'
    });
    emit(socket, delta({ runtimeId: 'runtime-2' }));
    expect(received).toHaveLength(5);
    expect(session.dshSessionPhase).toBe('resumed');

    // After detach, execution events are refused until re-attach.
    emit(socket, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId: 'runtime-2',
      phase: 'detached'
    });
    emit(socket, delta({ runtimeId: 'runtime-2' }));
    expect(received).toHaveLength(6);
    expect(session.dshSessionPhase).toBe('detached');
  });

  it('isolates throwing subscribers and supports unsubscribe', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    handshake(socket);
    const seen: string[] = [];
    const unsubscribe = session.subscribeDsh(() => {
      throw new Error('listener failure');
    });
    session.subscribeDsh(event => seen.push(event.type));

    expect(() => emit(socket, delta())).not.toThrow();
    expect(seen).toEqual(['dsh/v1/text.delta']);

    // Legacy handling on the same socket still works after a subscriber throws.
    session.sendUser('legacy', 'legacy-1');
    emit(socket, { type: 'text', turnId: 'legacy-1', text: 'answer' });
    expect(session.blocks).toHaveLength(1);

    unsubscribe();
    unsubscribe();
    emit(socket, delta());
    expect(seen).toEqual(['dsh/v1/text.delta', 'dsh/v1/text.delta']);
  });

  it('keeps subscribers across reconnects and drops them on dispose', () => {
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
    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));
    created[0].open();
    handshake(created[0]);
    expect(received).toEqual(['dsh/v1/connection', 'dsh/v1/session']);

    // A disconnect neither deletes the session nor fabricates run.finished.
    created[0].close();
    expect(received).toEqual(['dsh/v1/connection', 'dsh/v1/session']);
    expect(session.dshSessionId).toBe(sessionId);

    session.connect();
    expect(created).toHaveLength(2);
    created[1].open();
    emit(created[1], {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'resumed'
    });
    expect(received).toEqual([
      'dsh/v1/connection',
      'dsh/v1/session',
      'dsh/v1/session'
    ]);

    session.dispose();
    emit(created[1], delta());
    expect(received).toHaveLength(3);
    expect(session.dshRuntimeId).toBeNull();
    expect(session.dshCapabilityManifest).toBeNull();
  });

  it('ignores late events from a stale socket handler after reconnecting', () => {
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
    const first = created[0];
    const staleOnMessage = first.onmessage;
    first.open();
    handshake(first);
    first.close();

    session.connect();
    const second = created[1];
    second.open();
    emit(second, {
      type: 'dsh/v1/connection',
      runtimeId,
      phase: 'connected'
    });
    emit(second, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'resumed'
    });

    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));
    // A saved handler from the retired socket must not reach the new connection.
    staleOnMessage?.({ data: JSON.stringify(delta()) });
    emit(second, delta());
    expect(received).toEqual(['dsh/v1/text.delta']);
  });

  it('requires a fresh attach on a reconnected socket for the same runtime', () => {
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
    handshake(created[0]);
    created[0].close();

    session.connect();
    const second = created[1];
    second.open();
    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));

    // Same runtime, but the new socket has no attach yet: exec is refused.
    emit(second, {
      type: 'dsh/v1/connection',
      runtimeId,
      phase: 'connected'
    });
    emit(second, delta());
    expect(received).toEqual(['dsh/v1/connection']);

    // Only a new attach/resumed on this socket allows execution again.
    emit(second, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'resumed'
    });
    emit(second, delta());
    expect(received).toEqual([
      'dsh/v1/connection',
      'dsh/v1/session',
      'dsh/v1/text.delta'
    ]);
    expect(session.dshSessionId).toBe(sessionId);
  });

  it('clears capabilities when the connection generation changes', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    handshake(socket);
    emit(socket, {
      type: 'dsh/v1/capabilities',
      runtimeId,
      capabilities: { text_stream: { status: 'available' } }
    });
    expect(session.dshCapabilityManifest).toEqual({
      text_stream: { status: 'available' }
    });

    // A new generation drops the previous manifest; it is not inherited.
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-2',
      phase: 'connected'
    });
    expect(session.dshRuntimeId).toBe('runtime-2');
    expect(session.dshCapabilityManifest).toBeNull();

    // Capabilities for the old runtime cannot re-adopt it.
    emit(socket, {
      type: 'dsh/v1/capabilities',
      runtimeId,
      capabilities: { text_stream: { status: 'available' } }
    });
    expect(session.dshRuntimeId).toBe('runtime-2');
    expect(session.dshCapabilityManifest).toBeNull();
  });

  it('refuses to fall back to a retired runtime', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    handshake(socket);
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-2',
      phase: 'connected'
    });
    expect(session.dshRuntimeId).toBe('runtime-2');

    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));
    // A stale connection/resumed for the retired runtime is refused.
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId,
      phase: 'connected'
    });
    emit(socket, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'resumed'
    });
    emit(socket, delta());
    expect(received).toEqual([]);
    expect(session.dshRuntimeId).toBe('runtime-2');
  });

  it('clears all DSH state on dispose', () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    handshake(socket);
    emit(socket, {
      type: 'dsh/v1/capabilities',
      runtimeId,
      capabilities: { text_stream: { status: 'available' } }
    });

    session.dispose();
    expect(session.dshRuntimeId).toBeNull();
    expect(session.dshSessionId).toBeNull();
    expect(session.dshSessionPhase).toBeNull();
    expect(session.dshCapabilityManifest).toBeNull();

    const received: string[] = [];
    session.subscribeDsh(event => received.push(event.type));
    emit(socket, delta());
    expect(received).toEqual([]);
  });

  it('encodes dshSessionId as an independent query parameter', () => {
    expect(
      agentSocketUrl(
        {
          wsUrl: 'ws://example/base',
          appendToken: false,
          token: ''
        } as never,
        'folder name',
        null,
        'dsh session/1'
      )
    ).toBe(
      'ws://example/base/aiterminal/agent?cwd=folder%20name&dshSessionId=dsh%20session%2F1'
    );
  });

  it('sends the configured DSH session without mixing it into sessionId', () => {
    const { socket } = sessionWithSocket(null, sessionId);
    const params = new URL(socket.url).searchParams;
    expect(params.get('dshSessionId')).toBe(sessionId);
    expect(params.get('sessionId')).toBeNull();
  });

  it('drops the legacy sessionId when a DSH session is present', () => {
    const legacy = '123e4567-e89b-12d3-a456-426614174000';
    expect(
      agentSocketUrl(
        { wsUrl: 'ws://example/base', appendToken: false, token: '' } as never,
        'folder',
        legacy,
        'dsh session/1'
      )
    ).toBe(
      'ws://example/base/aiterminal/agent?cwd=folder&dshSessionId=dsh%20session%2F1'
    );
    const { socket } = sessionWithSocket(legacy, 'dsh session/1');
    const params = new URL(socket.url).searchParams;
    expect(params.get('dshSessionId')).toBe('dsh session/1');
    expect(params.get('sessionId')).toBeNull();
  });

  it('sends interaction decisions to the attached runtime', async () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    handshake(socket);

    await expect(
      session.resolveInteraction('req-1', 'approved', {
        sessionId,
        runId: 'run-1'
      })
    ).resolves.toBeUndefined();
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'dsh/v1/interaction.resolve',
        requestId: 'req-1',
        resolution: 'approved',
        scope: { sessionId, runtimeId, runId: 'run-1' }
      })
    ]);
    // The local send has no acknowledgement; the session keeps its attach state.
    expect(session.dshSessionPhase).toBe('attached');
  });

  it('refuses decisions for another session or a retired runtime', async () => {
    const { session, socket } = sessionWithSocket();
    socket.open();
    handshake(socket);

    await expect(
      session.resolveInteraction('req-1', 'rejected', {
        sessionId: 'other-session'
      })
    ).rejects.toThrow(/different session/);
    await expect(
      session.resolveInteraction('req-1', 'rejected', {
        runtimeId: 'runtime-retired'
      })
    ).rejects.toThrow(/retired runtime/);
    expect(socket.sent).toEqual([]);

    // A new connection generation retires the old runtime and waits for a
    // fresh attach; decisions must not be sent against the stale binding.
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-2',
      phase: 'connected'
    });
    await expect(
      session.resolveInteraction('req-1', 'approved')
    ).rejects.toThrow(/not connected/);
    expect(socket.sent).toEqual([]);
  });

  it('never queues a decision after the socket closes', async () => {
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
    session.configureDshSession(null);
    session.connect();
    created[0].open();
    handshake(created[0]);
    created[0].close();

    await expect(
      session.resolveInteraction('req-1', 'approved')
    ).rejects.toThrow(/not connected/);

    // Reconnecting must not replay the unacknowledged decision.
    session.sendUser('again', 'run-2');
    expect(created).toHaveLength(2);
    expect(created[1].sent).toEqual([]);
  });

  it('reconnects with the latest adopted DSH session', () => {
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
    session.configureDshSession(null);
    session.connect();
    created[0].open();
    handshake(created[0]);
    expect(session.dshSessionId).toBe(sessionId);

    created[0].close();
    session.sendUser('again', 'run-2');
    expect(created).toHaveLength(2);
    expect(new URL(created[1].url).searchParams.get('dshSessionId')).toBe(
      sessionId
    );
  });

  it('drops the DSH session on newSession and refuses stale handshakes', () => {
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
    session.configureDshSession(null);
    session.connect();
    created[0].open();
    handshake(created[0]);
    expect(session.dshSessionId).toBe(sessionId);

    session.resetContext();
    expect(session.dshSessionId).toBeNull();
    expect(created).toHaveLength(2);
    expect(new URL(created[1].url).searchParams.get('dshSessionId')).toBeNull();

    // The detached socket must not re-adopt the cleared session.
    emit(created[0], {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'attached'
    });
    expect(session.dshSessionId).toBeNull();
  });
});
