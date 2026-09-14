import { restoreCounters, WorkspaceNotebook } from './notebook';

describe('WorkspaceNotebook', () => {
  it('starts with one editable AI cell', () => {
    const notebook = new WorkspaceNotebook();
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.current.kind).toBe('ai');
    expect(notebook.mode).toBe('edit');
  });

  it('inserts above and below the active cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    notebook.insertBelow('command');
    notebook.setSource('ls');
    notebook.select(0);
    notebook.insertAbove('ai');
    expect(notebook.cells.map(cell => cell.source)).toEqual(['', 'pwd', 'ls']);
    expect(notebook.cells.map(cell => cell.kind)).toEqual([
      'ai',
      'ai',
      'command'
    ]);
    expect(notebook.active).toBe(0);
  });

  it('cycles the active cell between AI and Command', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('list files');
    expect(notebook.toggleKind()).toBe('command');
    expect(notebook.current.kind).toBe('command');
    expect(notebook.current.source).toBe('list files');
    expect(notebook.toggleKind()).toBe('ai');
    expect(notebook.current.kind).toBe('ai');
  });

  it('keeps sibling cells when changing the active kind', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('list files');
    notebook.insertBelow('command');
    notebook.setSource('pwd');
    notebook.select(0);
    notebook.setKind('command');
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[0].kind).toBe('command');
    expect(notebook.cells[0].source).toBe('list files');
    expect(notebook.cells[1].kind).toBe('command');
    expect(notebook.cells[1].source).toBe('pwd');
  });

  it('clears output when changing a run cell kind', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    notebook.beginRun();
    notebook.finishRun('/root');
    notebook.setKind('command');
    expect(notebook.current.source).toBe('pwd');
    expect(notebook.current.output).toBe('');
    expect(notebook.current.blocks).toEqual([]);
    expect(notebook.current.status).toBe('idle');
  });

  it('advances after a run by creating a trailing cell of the same kind', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setKind('command');
    notebook.setSource('pwd');
    notebook.beginRun();
    notebook.finishRun('/root\n');
    notebook.advanceAfterRun();
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.active).toBe(1);
    expect(notebook.cells[0].output).toBe('/root\n');
    expect(notebook.current.kind).toBe('command');
  });

  it('toggles output collapsed on a cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    notebook.beginRun();
    notebook.finishRun('/root\n');
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
    notebook.setKind('command');
    notebook.setSource('pwd');
    expect(notebook.deleteActive()).toBe(true);
    expect(notebook.cells).toHaveLength(0);
    expect(notebook.empty).toBe(true);
    expect(notebook.insertKind).toBe('command');
    const cell = notebook.appendCell();
    expect(cell.kind).toBe('command');
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.active).toBe(0);
    expect(notebook.mode).toBe('edit');
  });

  it('refuses to delete a running cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('pwd');
    notebook.beginRun();
    expect(notebook.deleteActive()).toBe(false);
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.current.status).toBe('running');
  });

  it('keeps a single empty trailing input after a finished cell', () => {
    const notebook = new WorkspaceNotebook();
    notebook.setSource('list files');
    notebook.beginRun();
    notebook.finishRun('', 'done');
    notebook.ensureTrailingInput();
    notebook.ensureTrailingInput();
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[1].source).toBe('');
    expect(notebook.cells[1].status).toBe('idle');
    notebook.advanceAfterRun();
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.active).toBe(1);
  });
});
