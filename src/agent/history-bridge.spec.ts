import { restoreNotebook, serializeNotebook } from './document';
import {
  HISTORY_BRIDGE_MAX_CHARACTERS,
  backgroundTaskReferences,
  buildHistoryBridge,
  projectContextMembership,
  serializedHistoryBridgeLength
} from './history-bridge';
import {
  WorkspaceNotebook,
  createWorkspaceCell,
  type WorkspaceCell
} from './notebook';
import type { ChatBlock } from './protocol';

function aiCell(id: string, blocks: ChatBlock[]): WorkspaceCell {
  return {
    ...createWorkspaceCell('ai', `${id} source`),
    id,
    status: 'done',
    executionCount: 1,
    blocks
  };
}

function backgroundStart(
  id: string,
  taskId: string,
  outputPath: string
): Extract<ChatBlock, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    name: 'Bash',
    input: { command: 'long-running-command', run_in_background: true },
    output: `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath}. You will be notified when it completes.`,
    status: 'done'
  };
}

function taskOutput(
  id: string,
  taskId: string,
  state: 'running' | 'completed' | 'failed' | 'killed' | 'unknown',
  outputTaskId = taskId
): Extract<ChatBlock, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    name: 'TaskOutput',
    input: { task_id: taskId, block: false, timeout: 1000 },
    output: `<retrieval_status>success</retrieval_status>\n<task_id>${outputTaskId}</task_id>\n<status>${state}</status>`,
    status: 'done'
  };
}

describe('backgroundTaskReferences', () => {
  it('derives and updates the last-known state across saved Cells', () => {
    const first = aiCell('cell-1', [
      backgroundStart(
        'start-1',
        'bgdqfc4y2',
        '/tmp/claude/session/tasks/bgdqfc4y2.output'
      ),
      taskOutput('running-1', 'bgdqfc4y2', 'running')
    ]);
    const second = aiCell('cell-2', [
      taskOutput('complete-1', 'bgdqfc4y2', 'completed')
    ]);

    expect(backgroundTaskReferences([first, second])).toEqual([
      {
        cellId: 'cell-1',
        taskId: 'bgdqfc4y2',
        outputPath: '/tmp/claude/session/tasks/bgdqfc4y2.output',
        state: 'completed',
        sourceBlockId: 'start-1',
        stateBlockId: 'complete-1'
      }
    ]);
  });

  it.each(['failed', 'killed', 'unknown'] as const)(
    'retains an explicit %s state',
    state => {
      const cell = aiCell('cell-1', [
        backgroundStart('start', 'task-1', '/tmp/task-1.output'),
        taskOutput('state', 'task-1', state)
      ]);

      expect(backgroundTaskReferences([cell])[0]).toMatchObject({ state });
    }
  );

  it('deduplicates repeated starts by task ID and keeps later evidence', () => {
    const cells = [
      aiCell('cell-1', [
        backgroundStart('start-old', 'task-1', '/tmp/old.output')
      ]),
      aiCell('cell-2', [
        backgroundStart('start-new', 'task-1', '/tmp/new.output'),
        taskOutput('state-new', 'task-1', 'running')
      ])
    ];

    expect(backgroundTaskReferences(cells)).toEqual([
      {
        cellId: 'cell-2',
        taskId: 'task-1',
        outputPath: '/tmp/new.output',
        state: 'running',
        sourceBlockId: 'start-new',
        stateBlockId: 'state-new'
      }
    ]);
  });

  it('ignores malformed IDs, paths, mismatches, arbitrary text, and Commands', () => {
    const arbitrary = backgroundStart(
      'arbitrary',
      'task-2',
      '/tmp/task-2.output'
    );
    arbitrary.output = `prefix ${arbitrary.output}`;
    const command = {
      ...createWorkspaceCell('command', '!background'),
      id: 'command-cell',
      status: 'done' as const,
      blocks: [backgroundStart('command-start', 'task-3', '/tmp/task-3.output')]
    };
    const cell = aiCell('cell-1', [
      backgroundStart('bad-id', '.bad', '/tmp/bad.output'),
      backgroundStart('bad-path', 'task-4', 'relative/output'),
      arbitrary,
      backgroundStart('valid', 'task-5', '/tmp/task-5.output'),
      taskOutput('mismatch', 'task-5', 'completed', 'other-task'),
      taskOutput('orphan', 'orphan-task', 'completed')
    ]);

    expect(backgroundTaskReferences([command, cell])).toEqual([
      {
        cellId: 'cell-1',
        taskId: 'task-5',
        outputPath: '/tmp/task-5.output',
        state: 'running',
        sourceBlockId: 'valid'
      }
    ]);
  });
});

describe('buildHistoryBridge', () => {
  it('serializes eligible history chronologically with task references', () => {
    const first = aiCell('cell-1', [
      { kind: 'text', id: 'text-1', text: 'first outcome' },
      backgroundStart('start-1', 'task-1', '/tmp/task-1.output')
    ]);
    first.source = 'first question';
    const second = aiCell('cell-2', [
      { kind: 'text', id: 'text-2', text: 'second outcome' },
      taskOutput('complete-1', 'task-1', 'completed')
    ]);
    second.source = 'second question';
    second.status = 'interrupted';
    const draft = createWorkspaceCell('ai', 'what happened?');

    expect(buildHistoryBridge([first, second, draft], draft.id)).toEqual({
      version: 1,
      turns: [
        {
          cellId: 'cell-1',
          source: 'first question',
          status: 'done',
          outcome: 'first outcome',
          taskIds: ['task-1']
        },
        {
          cellId: 'cell-2',
          source: 'second question',
          status: 'interrupted',
          outcome: 'second outcome',
          taskIds: []
        }
      ],
      tasks: [
        {
          cellId: 'cell-1',
          taskId: 'task-1',
          outputPath: '/tmp/task-1.output',
          state: 'completed'
        }
      ],
      omittedTurnCount: 0,
      omittedTaskCount: 0,
      truncatedFieldCount: 0
    });
  });

  it('keeps only the newest eight eligible AI Turns', () => {
    const history = Array.from({ length: 10 }, (_, index) => {
      const cell = aiCell(`cell-${index}`, [
        { kind: 'text', id: `text-${index}`, text: `outcome ${index}` }
      ]);
      cell.source = `question ${index}`;
      return cell;
    });
    const command = {
      ...createWorkspaceCell('command', '!pwd'),
      status: 'done' as const,
      executionCount: 11
    };
    const draft = createWorkspaceCell('ai', 'continue');
    const capsule = buildHistoryBridge([...history, command, draft], draft.id);

    expect(capsule?.turns).toHaveLength(8);
    expect(capsule?.turns.map(turn => turn.cellId)).toEqual(
      history.slice(2).map(cell => cell.id)
    );
    expect(capsule?.omittedTurnCount).toBe(2);
  });

  it('caps long fields and the complete serialized capsule', () => {
    const history = Array.from({ length: 8 }, (_, index) => {
      const cell = aiCell(`long-${index}`, [
        {
          kind: 'text',
          id: `long-text-${index}`,
          text: `${index}`.repeat(8_000)
        }
      ]);
      cell.source = `question-${index}-${'s'.repeat(2_000)}`;
      return cell;
    });
    const draft = createWorkspaceCell('ai', 'continue');
    const capsule = buildHistoryBridge([...history, draft], draft.id);

    expect(capsule).not.toBeNull();
    expect(serializedHistoryBridgeLength(capsule!)).toBeLessThanOrEqual(
      HISTORY_BRIDGE_MAX_CHARACTERS
    );
    expect(capsule!.turns[capsule!.turns.length - 1]?.cellId).toBe('long-7');
    expect(capsule!.omittedTurnCount).toBeGreaterThan(0);
    expect(capsule!.truncatedFieldCount).toBeGreaterThan(0);
  });

  it('never serializes raw tool input commands', () => {
    const cell = aiCell('cell-1', [
      {
        kind: 'tool',
        id: 'dangerous',
        name: 'Bash',
        input: { command: 'rm -rf /sensitive-target' },
        output: 'completed',
        status: 'done'
      },
      { kind: 'text', id: 'safe-result', text: 'cleanup result' }
    ]);
    const draft = createWorkspaceCell('ai', 'result?');
    const serialized = JSON.stringify(
      buildHistoryBridge([cell, draft], draft.id)
    );

    expect(serialized).not.toContain('rm -rf');
    expect(serialized).not.toContain('sensitive-target');
    expect(serialized).toContain('cleanup result');
  });

  it('ignores presentation-only Turn revisions', () => {
    const cell = aiCell('cell-1', [
      { kind: 'text', id: 'text-1', text: 'stable outcome' }
    ]);
    cell.turn = {
      id: 'turn-1',
      status: 'done',
      outcome: 'stable outcome',
      outcomeKind: 'assistant',
      timeline: [],
      diagnostics: [],
      changes: [],
      metrics: {},
      presentation: {
        trace: 'auto',
        expandedActivityIds: [],
        fullEvidenceActivityIds: [],
        outcomeExpanded: false
      },
      resultText: 'stable outcome',
      resultIsError: false,
      revision: 1
    };
    const draft = createWorkspaceCell('ai', 'continue');
    const first = JSON.stringify(buildHistoryBridge([cell, draft], draft.id));

    cell.turn = {
      ...cell.turn,
      revision: 99,
      presentation: { ...cell.turn.presentation, outcomeExpanded: true }
    };

    expect(JSON.stringify(buildHistoryBridge([cell, draft], draft.id))).toBe(
      first
    );
  });
});

describe('projectContextMembership', () => {
  it('distinguishes native, bridged, outside, draft, and Command Cells', () => {
    const outside = aiCell('outside', []);
    const bridged = aiCell('bridged', []);
    bridged.agentContextGeneration = 1;
    const native = aiCell('native', []);
    native.agentContextGeneration = 2;
    const command = {
      ...createWorkspaceCell('command', '!pwd'),
      id: 'command',
      status: 'done' as const,
      executionCount: 4
    };
    const draft = createWorkspaceCell('ai', 'draft');

    expect(
      projectContextMembership([outside, bridged, native, command, draft], 2, [
        { generation: 1, cellIds: [outside.id] },
        { generation: 2, cellIds: [bridged.id] }
      ])
    ).toEqual({
      generation: 2,
      entries: [
        { cellId: 'outside', membership: 'outside' },
        { cellId: 'bridged', membership: 'bridged' },
        { cellId: 'native', membership: 'native' },
        { cellId: 'command', membership: 'none' },
        { cellId: draft.id, membership: 'draft' }
      ],
      nativeCount: 1,
      bridgedCount: 1,
      outsideCount: 1,
      draftCount: 1,
      policyChosen: true
    });
  });

  it('remembers an explicit empty policy and ignores deleted bridge IDs', () => {
    const outside = aiCell('outside', []);
    const projection = projectContextMembership([outside], 3, [
      { generation: 2, cellIds: [outside.id] },
      { generation: 3, cellIds: [] },
      { generation: 3, cellIds: ['deleted-cell'] }
    ]);

    expect(projection).toMatchObject({
      generation: 3,
      nativeCount: 0,
      bridgedCount: 0,
      outsideCount: 1,
      policyChosen: true
    });
    expect(projection.entries).toEqual([
      { cellId: 'outside', membership: 'outside' }
    ]);
  });

  it('keeps the same projection after a version 4 round trip', () => {
    const native = aiCell('native', []);
    native.agentContextGeneration = 4;
    const bridged = aiCell('bridged', []);
    const before = projectContextMembership([bridged, native], 4, [
      { generation: 4, cellIds: [bridged.id] }
    ]);
    const notebook = new WorkspaceNotebook();
    notebook.cells = [bridged, native];
    notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';
    notebook.agentContextGeneration = 4;
    notebook.agentContextBridges = [{ generation: 4, cellIds: [bridged.id] }];
    const restored = new WorkspaceNotebook();
    restoreNotebook(restored, serializeNotebook(notebook));
    const after = projectContextMembership(
      restored.cells,
      restored.agentContextGeneration,
      restored.agentContextBridges
    );

    expect(after).toEqual(before);
  });
});
