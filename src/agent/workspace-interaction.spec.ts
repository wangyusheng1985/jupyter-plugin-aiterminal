import { createWorkspaceCell, type WorkspaceCell } from './notebook';
import {
  INACTIVE_FOLLOW_STATE,
  detachFollow,
  inputPreview,
  markerProximity,
  moveRovingId,
  navigationEntries,
  navigationLabel,
  retainRovingId,
  resumeFollow,
  shouldFollowUpdate,
  syncFollowRequest,
  workspaceUiState,
  workspaceUiStateKey,
  workspaceOverview,
  type SegmenterLike
} from './workspace-interaction';
import { createTurn, setTurnStatus } from './turn';

function cell(
  id: string,
  status: WorkspaceCell['status'],
  executionCount: number | null,
  source = id
): WorkspaceCell {
  return {
    ...createWorkspaceCell(),
    id,
    status,
    executionCount,
    source
  };
}

describe('Cell navigation projection', () => {
  it('keeps accepted Cells in document order and excludes drafts', () => {
    const cells = [
      cell('done', 'done', 1),
      cell('draft', 'idle', null),
      cell('queued', 'queued', null),
      cell('running', 'running', 2),
      cell('interrupted', 'interrupted', 3)
    ];

    expect(navigationEntries(cells, 2).map(entry => entry.id)).toEqual([
      'done',
      'queued',
      'running',
      'interrupted'
    ]);
    expect(navigationEntries(cells, 2)[1].selected).toBe(true);
  });

  it('represents a rerun once and follows insertion or deletion order', () => {
    const rerun = cell('same', 'running', 7, 'again');
    const before = navigationEntries(
      [cell('first', 'done', 1), rerun, cell('last', 'done', 6)],
      1
    );
    expect(before.map(entry => entry.id)).toEqual(['first', 'same', 'last']);

    rerun.status = 'done';
    rerun.executionCount = 8;
    const after = navigationEntries([rerun, cell('last', 'done', 6)], 0);
    expect(after.map(entry => entry.id)).toEqual(['same', 'last']);
    expect(after[0].executionCount).toBe(8);
  });

  it('adds explicit accessible context membership to navigation labels', () => {
    const entries = navigationEntries(
      [
        cell('native', 'done', 1),
        cell('bridged', 'done', 2),
        cell('outside', 'done', 3)
      ],
      0,
      new Map([
        ['native', 'native' as const],
        ['bridged', 'bridged' as const],
        ['outside', 'outside' as const]
      ])
    );

    expect(entries.map(navigationLabel)).toEqual([
      'Cell 1, native context: native',
      'Cell 2, bridged history: bridged',
      'Cell 3, outside current context: outside'
    ]);
  });
});

describe('Cell navigation preview', () => {
  it('normalizes whitespace and truncates after ten characters', () => {
    expect(inputPreview('  short\n text  ')).toBe('short text');
    expect(inputPreview('!printf  one two')).toBe('!printf on…');
    expect(inputPreview('这是一个超过十个字符的中文命令')).toBe(
      '这是一个超过十个字符…'
    );
  });

  it('uses grapheme segmentation and has a code-point fallback', () => {
    const family = '👨‍👩‍👧‍👦';
    const segmenter = {
      segment: (input: string) =>
        Array.from(
          input === `${family}abcdefghij` ? [family, ...'abcdefghij'] : input
        ).map(segment => ({ segment }))
    } satisfies SegmenterLike;
    expect(inputPreview(`${family}abcdefghij`, 10, () => segmenter)).toBe(
      `${family}abcdefghi…`
    );
    expect(inputPreview('😀abcdefghiZ', 10, () => null)).toBe('😀abcdefghi…');
  });

  it('builds a stateful accessible label', () => {
    const entry = navigationEntries(
      [cell('cell-1', 'running', 4, 'hello')],
      0
    )[0];
    expect(navigationLabel(entry)).toBe('Cell 4, running: hello');
  });
});

describe('Navigator interaction helpers', () => {
  it('finds the closest marker and weights one neighbor on each side', () => {
    expect(markerProximity([10, 30, 50, 70], 47)).toEqual({
      targetIndex: 2,
      weights: [0, 0.5, 1, 0.5]
    });
    expect(markerProximity([], 10)).toEqual({ targetIndex: -1, weights: [] });
  });

  it('moves and retains roving focus at stable boundaries', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveRovingId(ids, 'a', -1)).toBe('a');
    expect(moveRovingId(ids, 'a', 1)).toBe('b');
    expect(moveRovingId(ids, 'c', 1)).toBe('c');
    expect(retainRovingId(ids, 'b', 'c')).toBe('b');
    expect(retainRovingId(['a', 'c'], 'b', 'c')).toBe('c');
    expect(retainRovingId([], 'b', 'c')).toBeNull();
  });
});

describe('Streaming follow state', () => {
  it('starts, detaches, resumes, replaces, and clears requests', () => {
    const started = syncFollowRequest(INACTIVE_FOLLOW_STATE, 'run-1');
    expect(started).toEqual({ requestId: 'run-1', mode: 'following' });
    expect(detachFollow(started)).toEqual({
      requestId: 'run-1',
      mode: 'detached'
    });
    expect(resumeFollow(detachFollow(started))).toEqual(started);
    expect(syncFollowRequest(detachFollow(started), 'run-2')).toEqual({
      requestId: 'run-2',
      mode: 'following'
    });
    expect(syncFollowRequest(started, null)).toEqual(INACTIVE_FOLLOW_STATE);
  });

  it('follows only the matching near tail outside another editor', () => {
    const state = syncFollowRequest(INACTIVE_FOLLOW_STATE, 'run-1');
    expect(shouldFollowUpdate(state, 'run-1', true, false)).toBe(true);
    expect(shouldFollowUpdate(state, 'run-1', false, false)).toBe(false);
    expect(shouldFollowUpdate(state, 'run-1', true, true)).toBe(false);
    expect(shouldFollowUpdate(detachFollow(state), 'run-1', true, false)).toBe(
      false
    );
    expect(shouldFollowUpdate(state, 'run-2', true, false)).toBe(false);
  });
});

describe('Workspace UI state', () => {
  it.each([
    ['connecting', 'Connecting'],
    ['new', 'New'],
    ['live', 'Live'],
    ['resumed', 'Resumed'],
    ['unavailable', 'Unavailable'],
    ['reset', 'Reset']
  ] as const)(
    'keeps %s context truth visible with bridged coverage',
    (contextState, label) => {
      const state = workspaceUiState({
        connected: true,
        error: null,
        cwd: '/work',
        selectedCellId: null,
        activeRun: null,
        queueCount: 0,
        contextState,
        contextNativeCount: 1,
        contextBridgedCount: 2,
        contextOutsideCount: 3
      });

      expect(state.contextLabel).toBe(`Context: ${label} · 2 bridged`);
    }
  );

  it('omits coverage clutter for an empty workspace', () => {
    expect(
      workspaceUiState({
        connected: false,
        error: null,
        cwd: null,
        selectedCellId: null,
        activeRun: null,
        queueCount: 0,
        contextState: 'new',
        contextNativeCount: 0,
        contextBridgedCount: 0,
        contextOutsideCount: 0
      }).contextLabel
    ).toBe('Context: New');
  });

  it('derives connection, active execution, queue, and interrupt state', () => {
    const state = workspaceUiState({
      connected: true,
      error: null,
      cwd: '/work',
      selectedCellId: 'cell-2',
      activeRun: { id: 'run-1', cellId: 'cell-1' },
      queueCount: 2,
      contextState: 'resumed',
      contextNativeCount: 1,
      contextBridgedCount: 2,
      contextOutsideCount: 3
    });
    expect(state.connectionLabel).toBe('Connected');
    expect(state.executionLabel).toBe('Running cell-1 · Queue 2');
    expect(state.interruptAvailable).toBe(true);
    expect(state.contextLabel).toBe('Context: Resumed · 2 bridged');
    expect(state.savePhase).toBe('saved');
    expect(state.saveLabel).toBe('Saved');
    expect(state.saveRetryAvailable).toBe(false);
    expect(
      workspaceUiState({
        ...state,
        contextBridgedCount: 0,
        contextOutsideCount: 3
      }).contextLabel
    ).toBe('Context: Resumed · 3 outside');
  });

  it.each([
    ['saved', 'Saved', false],
    ['pending', 'Saving…', false],
    ['saving', 'Saving…', false],
    ['error', 'Not saved', true]
  ] as const)('projects %s save truth', (savePhase, label, retry) => {
    const state = workspaceUiState({
      connected: true,
      error: null,
      cwd: '/work',
      selectedCellId: 'cell-1',
      activeRun: null,
      queueCount: 0,
      contextState: 'live',
      savePhase
    });

    expect(state.savePhase).toBe(savePhase);
    expect(state.saveLabel).toBe(label);
    expect(state.saveRetryAvailable).toBe(retry);
  });

  it('produces the same coarse key when output-only state changes elsewhere', () => {
    const input = {
      connected: false,
      error: null,
      cwd: null,
      selectedCellId: 'cell-1',
      activeRun: null,
      queueCount: 0,
      contextState: 'new' as const
    };
    expect(workspaceUiStateKey(workspaceUiState(input))).toBe(
      workspaceUiStateKey(workspaceUiState({ ...input }))
    );
    expect(workspaceUiState(input).executionLabel).toBe('Ready');
    expect(workspaceUiState({ ...input, error: 'down' }).connectionLabel).toBe(
      'Connection error'
    );
    expect(
      workspaceUiState({ ...input, connected: true, error: 'config' })
        .connectionLabel
    ).toBe('Connected');
    expect(
      workspaceUiStateKey(workspaceUiState({ ...input, savePhase: 'saving' }))
    ).not.toBe(workspaceUiStateKey(workspaceUiState(input)));
  });

  it('summarizes submitted, interrupted, and failed work without output text', () => {
    const done = cell('done', 'done', 1, 'ask');
    done.kind = 'ai';
    const failed = cell('failed', 'interrupted', 2, '!false');
    failed.kind = 'command';
    failed.turn = setTurnStatus(createTurn('run-failed'), 'interrupted', [
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'false' },
        output: 'failed',
        status: 'error'
      }
    ]);
    const overview = workspaceOverview([
      done,
      failed,
      cell('draft', 'idle', null)
    ]);

    expect(overview).toMatchObject({
      submittedCount: 2,
      aiCount: 1,
      commandCount: 1,
      interruptedCount: 1,
      failureCount: 1,
      firstFailureCellId: 'failed',
      firstInterruptedCellId: 'failed'
    });
    expect(overview.summaryLabel).toBe('2 turns · 1 interrupted · 1 failed');

    done.output = 'streamed output only';
    expect(workspaceOverview([done, failed])).toEqual(overview);
  });
});
