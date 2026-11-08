import type { ChatBlock } from './protocol';
import {
  applyTurnEvent,
  createTurn,
  isTraceExpanded,
  revealFailedActivity,
  restoreTurn,
  setTurnStatus,
  toggleActivity,
  toggleOutcome,
  toggleTrace,
  toPersistedTurn
} from './turn';

describe('ChatTurn', () => {
  it('uses the runtime result as the outcome without duplicating the final text', () => {
    let turn = createTurn('run-1');
    const blocks: ChatBlock[] = [
      { kind: 'text', id: 'text-m1', messageId: 'm1', text: 'working' },
      { kind: 'text', id: 'text-m2', messageId: 'm2', text: 'Finished.' }
    ];
    turn = applyTurnEvent(turn, blocks, {
      type: 'result',
      turnId: 'run-1',
      text: 'Finished.',
      durationMs: 1200,
      numTurns: 3
    });
    expect(turn.outcome).toBe('Finished.');
    expect(turn.timeline.map(activity => activity.id)).toEqual([
      'activity-text-m1'
    ]);
    expect(turn.metrics).toMatchObject({ durationMs: 1200, numTurns: 3 });
  });

  it('promotes the last assistant text when no runtime result exists', () => {
    const blocks: ChatBlock[] = [
      { kind: 'text', id: 'text-m1', text: 'answer' }
    ];
    let turn = createTurn('run-1');
    turn = applyTurnEvent(turn, blocks, {
      type: 'tool_end',
      turnId: 'run-1',
      id: 't1',
      name: 'Bash',
      output: ''
    });
    turn = setTurnStatus(turn, 'done', blocks);
    expect(turn).toMatchObject({
      outcome: 'answer',
      outcomeKind: 'assistant',
      timeline: []
    });
  });

  it('uses the final tool preview when no assistant text exists', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'pwd' },
        output: '/root\n',
        status: 'done'
      }
    ];
    const turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    expect(turn.outcome).toBe('/root\n');
    expect(turn.outcomeKind).toBe('tool');
  });

  it('derives diagnostics and merges repeated file changes', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'tool',
        id: 'e1',
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: '--- a\n+++ a\n-old\n+new\n',
        status: 'done'
      },
      {
        kind: 'tool',
        id: 'e2',
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: '--- a\n+++ a\n-old2\n+new2\n+new3\n',
        status: 'error'
      }
    ];
    const turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    expect(turn.changes).toEqual([
      {
        path: '/tmp/a.ts',
        additions: 3,
        deletions: 2,
        sourceIds: ['activity-e1', 'activity-e2']
      }
    ]);
    expect(turn.diagnostics).toHaveLength(1);
    expect(turn.diagnostics[0].tone).toBe('error');
  });

  it('tracks automatic, explicit, activity, and outcome disclosure state', () => {
    const running = createTurn('run-1');
    expect(isTraceExpanded(running)).toBe(true);
    expect(isTraceExpanded(setTurnStatus(running, 'done', []))).toBe(false);

    let turn = toggleTrace(running);
    expect(turn.presentation.trace).toBe('collapsed');
    expect(isTraceExpanded(turn)).toBe(false);
    turn = toggleActivity(turn, 'activity-1');
    expect(turn.presentation.expandedActivityIds).toEqual(['activity-1']);
    turn = toggleOutcome(turn);
    expect(turn.presentation.outcomeExpanded).toBe(true);
  });

  it('reveals a failed activity and its record atomically', () => {
    const turn = revealFailedActivity(
      setTurnStatus(createTurn('run-1'), 'done', []),
      'activity-tool-1'
    );

    expect(turn.presentation.trace).toBe('expanded');
    expect(turn.presentation.expandedActivityIds).toEqual(['activity-tool-1']);
    expect(toPersistedTurn(turn).presentation).toEqual(turn.presentation);
  });

  it('round-trips persisted overlay state', () => {
    const turn = toggleTrace(createTurn('run-1'));
    const restored = restoreTurn(toPersistedTurn(turn));
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({
      id: 'run-1',
      status: 'interrupted',
      presentation: { trace: 'collapsed' }
    });
  });

  it('ignores events for another turn', () => {
    const turn = createTurn('run-1');
    expect(
      applyTurnEvent(turn, [], {
        type: 'text',
        turnId: 'run-2',
        text: 'wrong'
      })
    ).toBe(turn);
  });
});
