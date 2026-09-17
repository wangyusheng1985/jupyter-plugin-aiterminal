import { restoreCounters, WorkspaceNotebook } from './notebook';
import { createTurn, toggleOutcome, toggleTrace } from './turn';

describe('WorkspaceNotebook', () => {
  it('starts with one editable unified input', () => {
    const notebook = new WorkspaceNotebook();
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.current.kind).toBe('ai');
    expect(notebook.mode).toBe('edit');
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
    restoreCounters(notebook.cells);
    notebook.insertBelow();
    expect(notebook.cells[1].id).not.toBe('cell-9');
    expect(notebook.cells[1].id.startsWith('cell-')).toBe(true);
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
});
