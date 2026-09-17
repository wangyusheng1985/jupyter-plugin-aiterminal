import {
  AGENT_WORKSPACE_VERSION,
  parseWorkspaceSnapshot,
  restoreNotebook,
  serializeNotebook
} from './document';
import { WorkspaceNotebook } from './notebook';
import { createTurn, setTurnStatus, toggleOutcome, toggleTrace } from './turn';

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

  it('migrates version 1 blocks into a turn without discarding evidence', () => {
    const notebook = new WorkspaceNotebook();
    notebook.cells[0].source = 'inspect the workspace';
    notebook.cells[0].status = 'done';
    notebook.cells[0].blocks = [
      { kind: 'text', id: 'text-1', text: 'Working through the files.' },
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/tmp/a.ts' },
        output: 'export const a = 1;\n',
        status: 'done'
      },
      {
        kind: 'install',
        id: 'install-1',
        command: 'npm install',
        status: 'ok',
        detail: ''
      },
      {
        kind: 'denied',
        id: 'denied-1',
        command: 'rm -rf /tmp',
        reason: 'blocked'
      },
      {
        kind: 'error',
        id: 'error-1',
        code: 'runtime',
        message: 'one command failed'
      }
    ];
    const rawBlocks = JSON.parse(JSON.stringify(notebook.cells[0].blocks));

    const restored = new WorkspaceNotebook();
    restoreNotebook(
      restored,
      JSON.stringify({
        version: 1,
        active: 0,
        cells: [
          {
            id: 'legacy-cell',
            kind: 'ai',
            source: 'inspect the workspace',
            output: '',
            blocks: notebook.cells[0].blocks,
            status: 'done',
            executionCount: 1,
            outputCollapsed: false
          }
        ]
      })
    );

    expect(restored.cells[0].blocks).toEqual(rawBlocks);
    expect(restored.cells[0].turn).toMatchObject({
      id: 'legacy-legacy-cell',
      status: 'done',
      outcome: 'Working through the files.',
      outcomeKind: 'assistant'
    });
    expect(restored.cells[0].turn?.timeline.map(item => item.kind)).toEqual([
      'tool',
      'install',
      'denied',
      'error'
    ]);
  });

  it('round-trips version 2 turn metrics and disclosure state', () => {
    const notebook = new WorkspaceNotebook();
    notebook.cells[0].status = 'done';
    notebook.cells[0].blocks = [
      { kind: 'text', id: 'text-1', text: 'finished' }
    ];
    let turn = setTurnStatus(
      createTurn('run-42'),
      'done',
      notebook.cells[0].blocks
    );
    turn = toggleTrace(turn);
    turn = toggleOutcome(turn);
    turn.metrics = {
      durationMs: 2300,
      numTurns: 4,
      costUsd: 0.02,
      usage: { input_tokens: 100, output_tokens: 50 }
    };
    notebook.cells[0].turn = turn;

    const snapshot = parseWorkspaceSnapshot(serializeNotebook(notebook));
    expect(snapshot.version).toBe(AGENT_WORKSPACE_VERSION);
    expect(snapshot.cells[0].blocks).toEqual(notebook.cells[0].blocks);
    expect(snapshot.cells[0].turn).toMatchObject({
      id: 'run-42',
      status: 'done',
      metrics: {
        durationMs: 2300,
        numTurns: 4,
        costUsd: 0.02
      },
      presentation: {
        trace: 'expanded',
        outcomeExpanded: true
      }
    });

    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));
    expect(restored.cells[0].turn).toMatchObject({
      status: 'done',
      outcome: 'finished',
      timeline: [],
      presentation: {
        trace: 'expanded',
        outcomeExpanded: true
      },
      metrics: {
        durationMs: 2300,
        numTurns: 4,
        costUsd: 0.02
      }
    });
  });

  it('restores a running turn as interrupted with partial evidence', () => {
    const notebook = new WorkspaceNotebook();
    notebook.cells[0].status = 'running';
    notebook.cells[0].blocks = [
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'sleep 30' },
        output: 'started\n',
        status: 'running'
      }
    ];
    notebook.cells[0].turn = createTurn('run-running');

    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));

    expect(restored.cells[0]).toMatchObject({
      status: 'interrupted'
    });
    expect(restored.cells[0].turn).toMatchObject({
      id: 'run-running',
      status: 'interrupted'
    });
    expect(restored.cells[0].turn?.timeline[0]).toMatchObject({
      kind: 'tool',
      status: 'running'
    });
  });

  it('keeps unknown legacy blocks inspectable during migration', () => {
    const legacyBlocks = [
      {
        kind: 'future-activity',
        id: 'future-1',
        status: 'ok',
        text: 'legacy payload'
      }
    ] as unknown as import('./protocol').ChatBlock[];

    const notebook = new WorkspaceNotebook();
    restoreNotebook(
      notebook,
      JSON.stringify({
        version: 1,
        active: 0,
        cells: [
          {
            id: 'legacy-cell',
            kind: 'ai',
            source: 'continue',
            output: '',
            blocks: legacyBlocks,
            status: 'done',
            executionCount: 1,
            outputCollapsed: false
          }
        ]
      })
    );

    expect(notebook.cells[0].blocks).toEqual(legacyBlocks);
    expect(notebook.cells[0].turn?.timeline[0]).toMatchObject({
      kind: 'unknown',
      title: 'Unsupported future-activity activity',
      detail: 'ok\nlegacy payload'
    });
  });
});
