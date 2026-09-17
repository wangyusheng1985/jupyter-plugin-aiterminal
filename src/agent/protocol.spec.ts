import { applyServerEvent, type ChatBlock } from './protocol';

describe('applyServerEvent', () => {
  it('appends tool cards and fills their output', () => {
    let blocks: ChatBlock[] = [];
    blocks = applyServerEvent(blocks, {
      type: 'tool_start',
      turnId: 'run-1',
      id: 't1',
      name: 'Bash',
      input: { command: 'pwd' },
      startedAt: 100
    });
    blocks = applyServerEvent(blocks, {
      type: 'tool_end',
      turnId: 'run-1',
      id: 't1',
      name: 'Bash',
      output: '/root\n',
      durationMs: 12,
      lineCount: 1,
      byteCount: 6
    });
    expect(blocks).toEqual([
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'pwd' },
        output: '/root\n',
        status: 'done',
        startedAt: 100,
        durationMs: 12,
        lineCount: 1,
        byteCount: 6
      }
    ]);
  });

  it('coalesces assistant text for one runtime message', () => {
    let blocks = applyServerEvent([], {
      type: 'text',
      turnId: 'run-1',
      messageId: 'message-1',
      text: 'first'
    });
    blocks = applyServerEvent(blocks, {
      type: 'text',
      turnId: 'run-1',
      messageId: 'message-1',
      text: 'first and final'
    });
    expect(blocks).toEqual([
      {
        kind: 'text',
        id: 'text-message-1',
        messageId: 'message-1',
        text: 'first and final'
      }
    ]);
  });

  it('records thinking state without reasoning text', () => {
    let blocks = applyServerEvent([], {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm1:0',
      state: 'started'
    });
    blocks = applyServerEvent(blocks, {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm1:0',
      state: 'finished'
    });
    expect(blocks).toEqual([
      { kind: 'thinking', id: 'thinking-m1:0', status: 'finished' }
    ]);
    expect(JSON.stringify(blocks)).not.toContain('reasoning');
  });

  it('records config errors without dropping earlier cards', () => {
    const blocks = applyServerEvent(
      [{ kind: 'user', id: 'u1', text: 'list files' }],
      {
        type: 'error',
        code: 'config',
        message: 'AI Terminal settings are missing'
      }
    );
    expect(blocks[1]).toEqual({
      kind: 'error',
      id: expect.stringContaining('error'),
      message: 'AI Terminal settings are missing',
      code: 'config'
    });
  });

  it('does not fold command-exec events into the AI transcript', () => {
    expect(
      applyServerEvent([], {
        type: 'exec_done',
        output: '/tmp\n',
        returncode: 0,
        cwd: '/tmp'
      })
    ).toEqual([]);
    expect(
      applyServerEvent([], { type: 'exec_output', text: 'pong\n' })
    ).toEqual([]);
    expect(
      applyServerEvent([], { type: 'exec_error', message: 'shell exited' })
    ).toEqual([]);
  });

  it('does not render a successful result recap as another text block', () => {
    const withTool = applyServerEvent([], {
      type: 'tool_end',
      id: 't1',
      name: 'Bash',
      output: 'pong\n'
    });
    expect(
      applyServerEvent(withTool, {
        type: 'result',
        turnId: 'run-1',
        text: '10.9.34.98 is reachable.',
        isError: false,
        durationMs: 1200,
        numTurns: 4,
        errors: []
      })
    ).toEqual(withTool);
  });

  it('keeps result diagnostics and accepts result metadata', () => {
    const blocks = applyServerEvent([], {
      type: 'result',
      turnId: 'run-1',
      text: 'command failed',
      isError: true,
      durationMs: 500,
      numTurns: 1,
      errors: ['command failed']
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'error',
      message: 'command failed'
    });
  });
});
