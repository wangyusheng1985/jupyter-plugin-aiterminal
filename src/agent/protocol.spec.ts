import { applyServerEvent, type ChatBlock } from './protocol';

describe('applyServerEvent', () => {
  it('appends tool cards and fills their output', () => {
    let blocks: ChatBlock[] = [];
    blocks = applyServerEvent(blocks, {
      type: 'tool_start',
      id: 't1',
      name: 'Bash',
      input: { command: 'pwd' }
    });
    blocks = applyServerEvent(blocks, {
      type: 'tool_end',
      id: 't1',
      name: 'Bash',
      output: '/root\n'
    });
    expect(blocks).toEqual([
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'pwd' },
        output: '/root\n',
        status: 'done'
      }
    ]);
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
      message: 'AI Terminal settings are missing'
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
        text: '10.9.34.98 is reachable.',
        isError: false
      })
    ).toEqual(withTool);
  });
});
