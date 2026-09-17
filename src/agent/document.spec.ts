import {
  parseWorkspaceSnapshot,
  restoreNotebook,
  serializeNotebook
} from './document';
import { WorkspaceNotebook } from './notebook';

describe('Agent Workspace document', () => {
  it('round-trips mixed cells including outputs and collapse', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('list files');
    const firstRequest = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.setBlocks([
      { kind: 'text', id: 't1', text: 'done' },
      {
        kind: 'tool',
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'pwd' },
        output: '/root\n',
        status: 'done'
      }
    ]);
    notebook.finishRun(firstRequest?.id ?? '', '', 'done');
    notebook.toggleOutputCollapsed();
    notebook.advanceAfterRun();
    notebook.setSource('!pwd');
    const secondRequest = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(secondRequest?.id ?? '', '/root\n');

    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));

    expect(restored.cells).toHaveLength(2);
    expect(restored.cells[0].kind).toBe('ai');
    expect(restored.cells[0].source).toBe('list files');
    expect(restored.cells[0].blocks).toEqual(notebook.cells[0].blocks);
    expect(restored.cells[0].outputCollapsed).toBe(true);
    expect(restored.cells[1].kind).toBe('command');
    expect(restored.cells[1].source).toBe('!pwd');
    expect(restored.cells[1].output).toBe('/root\n');
    expect(restored.active).toBe(notebook.active);
  });

  it('does not persist a running status across reload', () => {
    const snapshot = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 1,
        active: 0,
        cells: [
          {
            id: 'cell-7',
            kind: 'command',
            source: 'ping 10.9.34.98',
            output: 'PING',
            blocks: [],
            status: 'running',
            executionCount: 3,
            outputCollapsed: false
          }
        ]
      })
    );
    expect(snapshot.cells[0].status).toBe('interrupted');
    expect(snapshot.cells[0].output).toBe('PING');
  });

  it('does not restore queued requests as active work', () => {
    const snapshot = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 1,
        active: 0,
        cells: [
          {
            id: 'cell-8',
            kind: 'command',
            source: 'sleep 10',
            output: 'previous',
            blocks: [],
            status: 'queued',
            executionCount: null,
            outputCollapsed: true
          }
        ]
      })
    );
    expect(snapshot.cells[0]).toMatchObject({
      status: 'idle',
      output: 'previous',
      outputCollapsed: true
    });
  });

  it('round-trips compact AI and Command output', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('long AI output');
    const aiRequest = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.setBlocks([
      { kind: 'text', id: 'long-ai', text: 'AI output\n'.repeat(100) }
    ]);
    notebook.finishRun(aiRequest?.id ?? '', '', 'done');
    notebook.toggleOutputCollapsed();

    notebook.insertBelow();
    notebook.setSource('!printf long-output');
    const commandRequest = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(
      commandRequest?.id ?? '',
      'command output\n'.repeat(100),
      'done'
    );
    notebook.toggleOutputCollapsed();

    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));

    expect(restored.cells[0]).toMatchObject({
      kind: 'ai',
      status: 'done',
      outputCollapsed: true
    });
    expect(restored.cells[0].blocks[0]).toMatchObject({
      kind: 'text',
      text: 'AI output\n'.repeat(100)
    });
    expect(restored.cells[1]).toMatchObject({
      kind: 'command',
      source: '!printf long-output',
      status: 'done',
      output: 'command output\n'.repeat(100),
      outputCollapsed: true
    });
  });

  it('normalizes legacy Command cells to one visible shell marker', () => {
    const snapshot = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 1,
        active: 0,
        cells: [
          {
            id: 'cell-9',
            kind: 'command',
            source: 'pwd',
            output: '/root\n',
            blocks: [],
            status: 'done',
            executionCount: 1,
            outputCollapsed: false
          },
          {
            id: 'cell-10',
            kind: 'command',
            source: ' !ls',
            output: '',
            blocks: [],
            status: 'idle',
            executionCount: null,
            outputCollapsed: false
          }
        ]
      })
    );

    expect(snapshot.cells[0]).toMatchObject({
      kind: 'command',
      source: '!pwd'
    });
    expect(snapshot.cells[1]).toMatchObject({
      kind: 'command',
      source: ' !ls'
    });
  });

  it('falls back to one empty AI cell for blank or invalid files', () => {
    expect(parseWorkspaceSnapshot('').cells).toHaveLength(1);
    expect(parseWorkspaceSnapshot('not-json').cells[0].kind).toBe('ai');
  });

  it('round-trips an explicitly empty notebook', () => {
    const notebook = new WorkspaceNotebook();
    notebook.deleteActive();
    expect(notebook.cells).toHaveLength(0);
    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));
    expect(restored.cells).toHaveLength(0);
    expect(restored.empty).toBe(true);
  });
});
