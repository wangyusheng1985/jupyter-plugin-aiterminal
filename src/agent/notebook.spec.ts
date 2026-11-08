import { WorkspaceNotebook } from './notebook';
import { createTurn, toggleOutcome, toggleTrace } from './turn';

describe('WorkspaceNotebook', () => {
  it('starts with one editable unified input', () => {
    const notebook = new WorkspaceNotebook();
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.current.kind).toBe('ai');
    expect(notebook.mode).toBe('edit');
  });

  it('makes running and finished cells read-only', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    const request = notebook.enqueueRun();
    expect(notebook.isEditable()).toBe(true);
    notebook.promoteNextRun();
    expect(notebook.isEditable()).toBe(false);
    notebook.enterEdit();
    expect(notebook.mode).toBe('command');
    notebook.setSource('rm -rf /');
    expect(notebook.current.source).toBe('pwd');
    expect(notebook.setDraftKind('command')).toBeNull();
    notebook.finishRun(request?.id ?? '', 'done');
    expect(notebook.isEditable()).toBe(false);
    notebook.setSource('ls');
    expect(notebook.current.source).toBe('pwd');
  });

  it('does not enter edit mode when advancing into a historical cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('first');
    const first = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(first?.id ?? '', 'one');
    notebook.insertBelow();
    notebook.setSource('second');
    const second = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(second?.id ?? '', 'two');
    notebook.select(0);

    notebook.advanceAfterRun();

    expect(notebook.active).toBe(1);
    expect(notebook.isEditable()).toBe(false);
    expect(notebook.mode).toBe('command');
  });

  it('inserts above and below the active cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    notebook.insertBelow();
    notebook.setSource('ls');
    notebook.select(0);
    notebook.insertAbove();
    expect(notebook.cells.map(cell => cell.source)).toEqual(['', 'pwd', 'ls']);
    expect(notebook.cells.map(cell => cell.kind)).toEqual(['ai', 'ai', 'ai']);
    expect(notebook.active).toBe(0);
  });

  it('prepares a clean retry draft without copying result evidence', () => {
    const notebook = new WorkspaceNotebook();
    const source = notebook.current;
    source.kind = 'ai';
    source.source = 'retry this task';
    source.status = 'interrupted';
    source.executionCount = 7;
    source.output = 'partial';
    source.outputCollapsed = true;
    source.blocks = [{ kind: 'text', id: 'text-1', text: 'evidence' }];
    source.turn = createTurn('run-source');

    const retry = notebook.prepareRetry(0);

    expect(retry).toMatchObject({
      kind: 'ai',
      source: 'retry this task',
      status: 'idle',
      executionCount: null,
      output: '',
      outputCollapsed: false,
      blocks: [],
      turn: null
    });
    expect(notebook.active).toBe(1);
    expect(notebook.mode).toBe('edit');
    expect(source).toMatchObject({
      status: 'interrupted',
      executionCount: 7,
      output: 'partial',
      outputCollapsed: true
    });
  });

  it('classifies ordinary, marked, whitespace-prefixed, and marker-only input', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('list files');
    const ordinary = notebook.enqueueRun();
    expect(ordinary).toMatchObject({
      kind: 'ai',
      source: 'list files',
      executionSource: 'list files'
    });

    notebook.setSource('!pwd');
    const marked = notebook.enqueueRun();
    expect(marked).toMatchObject({
      kind: 'command',
      source: '!pwd',
      executionSource: 'pwd'
    });

    notebook.setSource(' \n ! ls -la ');
    const whitespaceMarked = notebook.enqueueRun();
    expect(whitespaceMarked).toMatchObject({
      kind: 'command',
      source: '! ls -la',
      executionSource: 'ls -la'
    });

    notebook.setSource('  !  ');
    expect(notebook.enqueueRun()).toBeNull();
  });

  it('respects explicit shell mode without requiring exclamation mark', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setDraftKind('command');
    notebook.setSource('git status');

    const request = notebook.enqueueRun();
    expect(request).toMatchObject({
      kind: 'command',
      source: 'git status',
      executionSource: 'git status'
    });

    // Does not accidentally strip the first character of command
    notebook.insertBelow();
    notebook.setDraftKind('command');
    notebook.setSource('echo hello');
    const echoRequest = notebook.enqueueRun();
    expect(echoRequest).toMatchObject({
      kind: 'command',
      source: 'echo hello',
      executionSource: 'echo hello'
    });

    // Bang shortcut still works and strips bang
    notebook.insertBelow();
    notebook.setDraftKind('command');
    notebook.setSource('!pwd');
    const bangRequest = notebook.enqueueRun();
    expect(bangRequest).toMatchObject({
      kind: 'command',
      source: '!pwd',
      executionSource: 'pwd'
    });
  });

  it('preserves queued run mode snapshot and rejects toggling kind on queued cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setDraftKind('command');
    notebook.setSource('echo first');
    const queued = notebook.enqueueRun();
    expect(queued).toMatchObject({
      kind: 'command',
      source: 'echo first',
      executionSource: 'echo first'
    });

    // Toggle draft kind after enqueueing should be rejected because cell is queued
    expect(notebook.current.status).toBe('queued');
    const rejected = notebook.setDraftKind('ai');
    expect(rejected).toBeNull();
    expect(notebook.current.kind).toBe('command');
    expect(notebook.queuedRuns[0]).toMatchObject({
      kind: 'command',
      source: 'echo first',
      executionSource: 'echo first'
    });

    // New run in AI mode
    notebook.insertBelow();
    notebook.setSource('summarize progress');
    const aiQueued = notebook.enqueueRun();
    expect(aiQueued).toMatchObject({
      kind: 'ai',
      source: 'summarize progress',
      executionSource: 'summarize progress'
    });
  });

  it('rejects setDraftKind on invalid index or non-draft cells (done/interrupted/running/queued/idle with executionCount)', () => {
    const notebook = new WorkspaceNotebook();
    // Invalid index
    expect(notebook.setDraftKind('command', -1)).toBeNull();
    expect(notebook.setDraftKind('command', 99)).toBeNull();

    // Valid editable draft
    expect(notebook.current.status).toBe('idle');
    expect(notebook.current.executionCount).toBeNull();
    expect(notebook.setDraftKind('command')).not.toBeNull();
    expect(notebook.current.kind).toBe('command');
    expect(notebook.setDraftKind('ai')).not.toBeNull();
    expect(notebook.current.kind).toBe('ai');

    // running status
    notebook.current.status = 'running';
    expect(notebook.setDraftKind('command')).toBeNull();
    expect(notebook.current.kind).toBe('ai');

    // done status
    notebook.current.status = 'done';
    expect(notebook.setDraftKind('command')).toBeNull();
    expect(notebook.current.kind).toBe('ai');

    // interrupted status
    notebook.current.status = 'interrupted';
    expect(notebook.setDraftKind('command')).toBeNull();
    expect(notebook.current.kind).toBe('ai');

    // queued status
    notebook.current.status = 'queued';
    expect(notebook.setDraftKind('command')).toBeNull();
    expect(notebook.current.kind).toBe('ai');

    // status is idle but already has execution history (e.g. executionCount !== null)
    notebook.current.status = 'idle';
    notebook.current.executionCount = 1;
    expect(notebook.setDraftKind('command')).toBeNull();
    expect(notebook.current.kind).toBe('ai');
  });

  it('assigns AI work to the active generation only after acceptance', () => {
    const notebook = new WorkspaceNotebook();
    notebook.agentContextGeneration = 3;
    notebook.setSource('continue with context');

    const request = notebook.enqueueRun();
    expect(request).toMatchObject({ kind: 'ai' });
    notebook.promoteNextRun();
    expect(notebook.current.agentContextGeneration).toBeNull();

    expect(notebook.commitRunContext(request?.id ?? '')).toBe(true);
    expect(notebook.current.agentContextGeneration).toBe(3);
    expect(notebook.commitRunContext(request?.id ?? '')).toBe(false);

    notebook.clearRuns();
    notebook.insertBelow();
    notebook.setSource('!pwd');
    expect(notebook.enqueueRun()).toMatchObject({ kind: 'command' });
    expect(notebook.current.agentContextGeneration).toBeNull();
  });

  it('starts a new context generation without rewriting historical evidence', () => {
    const notebook = new WorkspaceNotebook();
    const historical = notebook.current;
    historical.source = 'historical';
    historical.status = 'done';
    historical.blocks = [
      { kind: 'text', id: 'historical-text', text: 'preserved evidence' }
    ];
    historical.agentContextGeneration = 1;
    notebook.agentContextGeneration = 1;
    notebook.agentContextBridges = [{ generation: 1, cellIds: ['older-cell'] }];
    notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';

    expect(notebook.startNewAgentContext()).toBe(2);

    expect(notebook.agentSessionId).toBeNull();
    expect(notebook.agentContextBridges).toEqual([
      { generation: 1, cellIds: ['older-cell'] },
      { generation: 2, cellIds: [] }
    ]);
    expect(historical).toMatchObject({
      source: 'historical',
      agentContextGeneration: 1,
      blocks: [
        { kind: 'text', id: 'historical-text', text: 'preserved evidence' }
      ]
    });
  });

  it('advances after a command run by creating a unified AI input', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('!pwd');
    const request = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(request?.id ?? '', '/root\n');
    notebook.advanceAfterRun();
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.active).toBe(1);
    expect(notebook.cells[0].output).toBe('/root\n');
    expect(notebook.current.kind).toBe('ai');
    expect(notebook.current.source).toBe('');
  });

  it('toggles output collapsed on a cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    const request = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(request?.id ?? '', '/root\n');
    expect(notebook.current.outputCollapsed).toBe(false);
    notebook.toggleOutputCollapsed();
    expect(notebook.current.outputCollapsed).toBe(true);
    notebook.toggleOutputCollapsed();
    expect(notebook.current.outputCollapsed).toBe(false);
  });

  it('does not reuse restored cell ids for new cells', () => {
    const notebook = new WorkspaceNotebook();
    notebook.cells[0].id = 'cell-9';
    notebook.cells[0].executionCount = 4;
    notebook.restoreCounters();
    notebook.insertBelow();
    expect(notebook.cells[1].id).not.toBe('cell-9');
    expect(notebook.cells[1].id).toBe('cell-10');
  });

  it('deletes the active cell and selects the next one', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('one');
    notebook.insertBelow();
    notebook.setSource('two');
    notebook.insertBelow();
    notebook.setSource('three');
    notebook.select(1);
    expect(notebook.deleteActive()).toBe(true);
    expect(notebook.current.source).toBe('three');
    expect(notebook.cells.map(cell => cell.source)).toEqual(['one', 'three']);
    expect(notebook.active).toBe(1);
    expect(notebook.mode).toBe('command');
  });

  it('can delete the last remaining cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('!pwd');
    expect(notebook.deleteActive()).toBe(true);
    expect(notebook.cells).toHaveLength(0);
    expect(notebook.empty).toBe(true);
    const cell = notebook.appendCell();
    expect(cell.kind).toBe('ai');
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.active).toBe(0);
    expect(notebook.mode).toBe('edit');
  });

  it('refuses to delete a running cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    notebook.enqueueRun();
    notebook.promoteNextRun();
    expect(notebook.deleteActive()).toBe(false);
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.current.status).toBe('running');
  });

  it('keeps a single empty trailing input after a finished cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('list files');
    const request = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(request?.id ?? '', '', 'done');
    notebook.ensureTrailingInput();
    notebook.ensureTrailingInput();
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[1].source).toBe('');
    expect(notebook.cells[1].status).toBe('idle');
    notebook.advanceAfterRun();
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.active).toBe(1);
  });

  it('snapshots source for every queued submission', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('first');
    const first = notebook.enqueueRun();
    notebook.setSource('!second');
    const second = notebook.enqueueRun();

    expect(first).toMatchObject({
      source: 'first',
      executionSource: 'first',
      kind: 'ai'
    });
    expect(second).toMatchObject({
      source: '!second',
      executionSource: 'second',
      kind: 'command'
    });
    expect(notebook.queuedRuns.map(request => request.source)).toEqual([
      'first',
      '!second'
    ]);
  });

  it('promotes queued runs FIFO and assigns counts only when they start', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('one');
    const first = notebook.enqueueRun();
    notebook.insertBelow();
    notebook.setSource('!two');
    const second = notebook.enqueueRun();

    expect(first?.id).not.toBe(second?.id);
    expect(notebook.cells.map(cell => cell.executionCount)).toEqual([
      null,
      null
    ]);
    expect(notebook.cells.map(cell => cell.status)).toEqual([
      'queued',
      'queued'
    ]);

    const active = notebook.promoteNextRun();
    const firstCount = notebook.cells[0].executionCount;
    expect(active?.id).toBe(first?.id);
    expect(notebook.cells[0]).toMatchObject({
      status: 'running',
      executionCount: firstCount
    });
    expect(notebook.cells[1]).toMatchObject({
      status: 'queued',
      executionCount: null
    });

    notebook.finishRun(active?.id ?? '', 'first output');
    const next = notebook.promoteNextRun();
    expect(next?.id).toBe(second?.id);
    expect(notebook.cells[1]).toMatchObject({
      status: 'running',
      executionCount: (firstCount ?? 0) + 1
    });
  });

  it('preserves prior output while waiting and clears it on promotion', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('first');
    const first = notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.finishRun(first?.id ?? '', 'old output');
    const second = notebook.enqueueRun();

    expect(second).not.toBeNull();
    expect(notebook.current).toMatchObject({
      status: 'queued',
      output: 'old output'
    });

    notebook.promoteNextRun();
    expect(notebook.current).toMatchObject({
      status: 'running',
      output: ''
    });
  });

  it('cancels every queued request for a deleted cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('one');
    notebook.enqueueRun();
    notebook.enqueueRun();
    notebook.insertBelow();
    notebook.setSource('!two');
    const other = notebook.enqueueRun();

    notebook.select(0);
    expect(notebook.deleteActive()).toBe(true);
    expect(notebook.queuedRuns).toEqual([other]);
    expect(notebook.queuedRuns.map(request => request.source)).toEqual([
      '!two'
    ]);
  });

  it('does not delete the active running cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('!pwd');
    notebook.enqueueRun();
    notebook.promoteNextRun();

    expect(notebook.deleteActive()).toBe(false);
    expect(notebook.current.kind).toBe('command');
    expect(notebook.current.status).toBe('running');
  });

  it('clears queued work without leaving pending cell state', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('one');
    notebook.enqueueRun();
    notebook.promoteNextRun();
    notebook.insertBelow();
    notebook.setSource('!two');
    notebook.enqueueRun();

    notebook.clearRuns();
    expect(notebook.queuedRuns).toEqual([]);
    expect(notebook.activeRun).toBeNull();
    expect(notebook.cells[0].status).toBe('interrupted');
    expect(notebook.cells[1].status).toBe('idle');
  });

  it('resets persisted presentation choices when a cell starts a new run', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('run again');
    let turn = createTurn('run-old');
    turn = toggleTrace(turn);
    turn = toggleOutcome(turn);
    notebook.current.turn = turn;

    notebook.enqueueRun();
    notebook.promoteNextRun();

    expect(notebook.current.turn).toBeNull();
    expect(notebook.current.status).toBe('running');
  });

  it('isolates execution counters across distinct WorkspaceNotebook instances', () => {
    const firstNotebook = new WorkspaceNotebook();
    firstNotebook.setSource('first cell run 1');
    const firstRequest = firstNotebook.enqueueRun();
    firstNotebook.promoteNextRun();
    expect(firstNotebook.cells[0].executionCount).toBe(1);
    firstNotebook.finishRun(firstRequest?.id ?? '', 'done');

    // Simulate runs up to 18 in the first notebook
    firstNotebook.cells[0].executionCount = 18;
    firstNotebook.restoreCounters();
    firstNotebook.insertBelow();
    firstNotebook.setSource('first cell run 19');
    firstNotebook.enqueueRun();
    firstNotebook.promoteNextRun();
    expect(firstNotebook.cells[1].executionCount).toBe(19);

    // A brand new notebook document must strictly start its executionCount at 1
    const freshNotebook = new WorkspaceNotebook();
    expect(freshNotebook.cells[0].executionCount).toBeNull();
    freshNotebook.setSource('fresh notebook first command');
    freshNotebook.enqueueRun();
    freshNotebook.promoteNextRun();
    expect(freshNotebook.cells[0].executionCount).toBe(1);
  });
});
