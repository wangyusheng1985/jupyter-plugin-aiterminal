import {
  AGENT_WORKSPACE_VERSION,
  normalizeAgentSessionId,
  parseWorkspaceSnapshot,
  restoreNotebook,
  serializeNotebook
} from './document';
import { WorkspaceNotebook } from './notebook';
import { createTurn, setTurnStatus, toggleOutcome, toggleTrace } from './turn';

function contextCell(
  id: string,
  agentContextGeneration: number | null,
  kind: 'ai' | 'command' = 'ai'
): Record<string, unknown> {
  return {
    id,
    kind,
    source: kind === 'command' ? '!pwd' : `${id} question`,
    output: '',
    blocks: [],
    turn: null,
    status: 'done',
    executionCount: 1,
    outputCollapsed: false,
    agentContextGeneration
  };
}

describe('Agent Workspace document', () => {
  it('round-trips a version 4 Agent session identity at the document root', () => {
    const notebook = new WorkspaceNotebook();
    notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';

    const text = serializeNotebook(notebook);
    const serialized = JSON.parse(text) as Record<string, unknown>;
    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, text);

    expect(serialized.version).toBe(AGENT_WORKSPACE_VERSION);
    expect(serialized.agentSessionId).toBe(
      '123e4567-e89b-12d3-a456-426614174000'
    );
    expect(JSON.stringify(serialized)).not.toMatch(
      /token|password|transcript/i
    );
    expect(restored.agentSessionId).toBe(
      '123e4567-e89b-12d3-a456-426614174000'
    );
    expect(restored.agentContextGeneration).toBe(0);
    expect(restored.agentContextBridges).toEqual([]);
  });

  it('migrates version 1, 2, and unlinked 3 workspaces without inventing context', () => {
    for (const version of [1, 2, 3]) {
      const restored = new WorkspaceNotebook();
      restoreNotebook(
        restored,
        JSON.stringify({
          version,
          active: 0,
          cells: [
            {
              id: `legacy-${version}`,
              kind: 'ai',
              source: 'kept',
              output: '',
              blocks: [{ kind: 'text', id: 'text-1', text: 'evidence' }],
              status: 'done',
              executionCount: 1,
              outputCollapsed: true
            }
          ]
        })
      );
      expect(restored.agentSessionId).toBeNull();
      expect(restored.agentContextGeneration).toBe(0);
      expect(restored.agentContextBridges).toEqual([]);
      expect(restored.cells[0]).toMatchObject({
        source: 'kept',
        outputCollapsed: true,
        agentContextGeneration: null
      });
      expect(restored.cells[0].blocks[0]).toMatchObject({ text: 'evidence' });
    }
  });

  it('round-trips native generations and bridged Cell membership', () => {
    const notebook = new WorkspaceNotebook();
    const historical = notebook.current;
    historical.source = 'historical question';
    historical.status = 'done';
    historical.executionCount = 4;
    historical.blocks = [
      { kind: 'text', id: 'historical-text', text: 'historical outcome' }
    ];
    historical.outputCollapsed = true;

    const native = notebook.insertBelow();
    native.source = 'current question';
    native.status = 'done';
    native.executionCount = 5;
    native.blocks = [
      { kind: 'text', id: 'current-text', text: 'current outcome' }
    ];
    native.agentContextGeneration = 2;
    notebook.agentContextGeneration = 2;
    notebook.agentContextBridges = [
      { generation: 2, cellIds: [historical.id] }
    ];
    notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';

    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));

    expect(restored.agentContextGeneration).toBe(2);
    expect(restored.agentContextBridges).toEqual([
      { generation: 2, cellIds: [historical.id] }
    ]);
    expect(restored.cells[0]).toMatchObject({
      id: historical.id,
      source: 'historical question',
      executionCount: 4,
      outputCollapsed: true,
      agentContextGeneration: null
    });
    expect(restored.cells[0].blocks).toEqual(historical.blocks);
    expect(restored.cells[1]).toMatchObject({
      id: native.id,
      source: 'current question',
      executionCount: 5,
      agentContextGeneration: 2
    });
    expect(restored.cells[1].blocks).toEqual(native.blocks);
  });

  it('reopens a replacement context without rewriting earlier generations', () => {
    const notebook = new WorkspaceNotebook();
    const bridged = notebook.current;
    bridged.source = 'bridged history';
    bridged.status = 'done';
    bridged.executionCount = 2;
    bridged.blocks = [
      { kind: 'text', id: 'bridged-text', text: 'bridged evidence' }
    ];
    const earlier = notebook.insertBelow();
    earlier.source = 'earlier work';
    earlier.status = 'done';
    earlier.executionCount = 3;
    earlier.agentContextGeneration = 1;
    earlier.blocks = [
      { kind: 'text', id: 'earlier-text', text: 'earlier evidence' }
    ];
    notebook.agentContextGeneration = 1;
    notebook.agentContextBridges = [{ generation: 1, cellIds: [bridged.id] }];

    notebook.startNewAgentContext();
    const current = notebook.insertBelow();
    current.source = 'new context work';
    const request = notebook.enqueueRun();
    notebook.promoteNextRun();
    expect(notebook.commitRunContext(request?.id ?? '')).toBe(true);
    notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';

    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));

    expect(restored.agentContextGeneration).toBe(2);
    expect(restored.agentContextBridges).toEqual([
      { generation: 1, cellIds: [bridged.id] },
      { generation: 2, cellIds: [] }
    ]);
    expect(restored.cells[0]).toMatchObject({
      source: 'bridged history',
      status: 'done',
      executionCount: 2,
      agentContextGeneration: null,
      blocks: [{ id: 'bridged-text', text: 'bridged evidence' }]
    });
    expect(restored.cells[1]).toMatchObject({
      source: 'earlier work',
      status: 'done',
      executionCount: 3,
      agentContextGeneration: 1,
      blocks: [{ id: 'earlier-text', text: 'earlier evidence' }]
    });
    expect(restored.cells[2]).toMatchObject({
      source: 'new context work',
      agentContextGeneration: 2
    });
  });

  it('migrates a linked version 3 workspace conservatively', () => {
    const snapshot = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 3,
        active: 3,
        agentSessionId: '123e4567-e89b-12d3-a456-426614174000',
        cells: [
          {
            id: 'older-ai',
            kind: 'ai',
            source: 'older',
            blocks: [{ kind: 'text', id: 'older-text', text: 'older result' }],
            status: 'done',
            executionCount: 1
          },
          {
            id: 'interrupted-ai',
            kind: 'ai',
            source: 'interrupted',
            blocks: [],
            status: 'interrupted',
            executionCount: 2
          },
          {
            id: 'command',
            kind: 'command',
            source: '!pwd',
            blocks: [],
            status: 'done',
            executionCount: 3
          },
          {
            id: 'newest-ai',
            kind: 'ai',
            source: 'newest',
            blocks: [
              { kind: 'text', id: 'newest-text', text: 'newest result' }
            ],
            status: 'done',
            executionCount: 4
          }
        ]
      })
    );

    expect(snapshot.agentContextGeneration).toBe(0);
    expect(snapshot.agentContextBridges).toEqual([]);
    expect(
      snapshot.cells.map(cell => [cell.id, cell.agentContextGeneration])
    ).toEqual([
      ['older-ai', null],
      ['interrupted-ai', null],
      ['command', null],
      ['newest-ai', 0]
    ]);
  });

  it('normalizes malformed context generations and bridge records', () => {
    const snapshot = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 4,
        active: 0,
        agentSessionId: '123e4567-e89b-12d3-a456-426614174000',
        agentContextGeneration: 2,
        agentContextBridges: [
          {
            generation: 2,
            cellIds: [
              'outside-b',
              'native',
              'command',
              'unknown',
              'outside-a',
              'outside-a',
              'idle'
            ]
          },
          { generation: 2, cellIds: ['outside-a'] },
          { generation: 3, cellIds: ['outside-a'] },
          { generation: -1, cellIds: ['outside-a'] },
          { generation: 1, cellIds: 'not-an-array' },
          null
        ],
        cells: [
          contextCell('outside-a', null),
          contextCell('outside-b', -1),
          contextCell('native', 2),
          contextCell('future', 3),
          contextCell('command', 1, 'command'),
          { ...contextCell('idle', null), status: 'idle' }
        ]
      })
    );

    expect(snapshot.agentContextBridges).toEqual([
      { generation: 2, cellIds: ['outside-a', 'outside-b'] }
    ]);
    expect(
      snapshot.cells.map(cell => [cell.id, cell.agentContextGeneration])
    ).toEqual([
      ['outside-a', null],
      ['outside-b', null],
      ['native', 2],
      ['future', null],
      ['command', null],
      ['idle', null]
    ]);
  });

  it('treats unlinked current version 4 coverage as uncovered', () => {
    const unlinkedBridge = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 4,
        active: 2,
        agentContextGeneration: 2,
        agentContextBridges: [
          { generation: 1, cellIds: ['older-bridged'] },
          { generation: 2, cellIds: ['current-bridged'] }
        ],
        cells: [
          contextCell('older-bridged', null),
          contextCell('current-bridged', null),
          contextCell('current-native', 2)
        ]
      })
    );

    expect(unlinkedBridge.agentSessionId).toBeNull();
    expect(unlinkedBridge.agentContextBridges).toEqual([
      { generation: 1, cellIds: ['older-bridged'] }
    ]);
    expect(
      unlinkedBridge.cells.map(cell => [cell.id, cell.agentContextGeneration])
    ).toEqual([
      ['older-bridged', null],
      ['current-bridged', null],
      ['current-native', null]
    ]);

    const explicitEmpty = parseWorkspaceSnapshot(
      JSON.stringify({
        version: 4,
        active: 1,
        agentSessionId: 'invalid',
        agentContextGeneration: 3,
        agentContextBridges: [{ generation: 3, cellIds: [] }],
        cells: [contextCell('outside', null), contextCell('unlinked-native', 3)]
      })
    );

    expect(explicitEmpty.agentContextBridges).toEqual([
      { generation: 3, cellIds: [] }
    ]);
    expect(explicitEmpty.cells[1].agentContextGeneration).toBeNull();
  });

  it('accepts only normalized UUID session identities', () => {
    expect(
      normalizeAgentSessionId('123E4567-E89B-12D3-A456-426614174000')
    ).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(normalizeAgentSessionId('')).toBeNull();
    expect(normalizeAgentSessionId('not-a-session')).toBeNull();
    expect(
      normalizeAgentSessionId('../123e4567-e89b-12d3-a456-426614174000')
    ).toBeNull();
    expect(normalizeAgentSessionId('x'.repeat(200))).toBeNull();
    expect(normalizeAgentSessionId(42)).toBeNull();
  });

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
