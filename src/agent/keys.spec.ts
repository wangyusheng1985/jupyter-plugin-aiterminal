import { mapWorkspaceKey } from './keys';

describe('mapWorkspaceKey', () => {
  it('uses Enter to edit, not run, in command mode', () => {
    expect(
      mapWorkspaceKey(
        { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command'
      )
    ).toEqual({ type: 'enter-edit' });
  });

  it('runs with Shift+Enter and Ctrl+Enter while editing', () => {
    expect(
      mapWorkspaceKey(
        { key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false },
        'notebook',
        'edit'
      )
    ).toEqual({ type: 'run-advance' });
    expect(
      mapWorkspaceKey(
        { key: 'Enter', shiftKey: false, ctrlKey: true, metaKey: false },
        'notebook',
        'edit'
      )
    ).toEqual({ type: 'run-stay' });
  });

  it('inserts cells with A and B in command mode', () => {
    expect(
      mapWorkspaceKey(
        { key: 'a', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command'
      )
    ).toEqual({ type: 'insert-above' });
    expect(
      mapWorkspaceKey(
        { key: 'b', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command'
      )
    ).toEqual({ type: 'insert-below' });
  });

  it('starts a delete chord with D in command mode', () => {
    expect(
      mapWorkspaceKey(
        { key: 'd', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command'
      )
    ).toEqual({ type: 'delete-chord' });
  });

  it('does not treat Cmd+A as insert-above', () => {
    expect(
      mapWorkspaceKey(
        { key: 'a', shiftKey: false, ctrlKey: false, metaKey: true },
        'notebook',
        'command'
      )
    ).toBeNull();
  });

  it('lets Cmd+C copy unless a cell is running with no selection', () => {
    expect(
      mapWorkspaceKey(
        { key: 'c', shiftKey: false, ctrlKey: false, metaKey: true },
        'notebook',
        'edit'
      )
    ).toBeNull();
    expect(
      mapWorkspaceKey(
        { key: 'c', shiftKey: false, ctrlKey: true, metaKey: false },
        'notebook',
        'edit',
        true,
        { running: true, hasSelection: true }
      )
    ).toBeNull();
    expect(
      mapWorkspaceKey(
        { key: 'c', shiftKey: false, ctrlKey: false, metaKey: true },
        'notebook',
        'edit',
        false,
        { running: true, hasSelection: false }
      )
    ).toEqual({ type: 'interrupt' });
  });

  it('interrupts with Ctrl/Cmd+Shift+C', () => {
    expect(
      mapWorkspaceKey(
        { key: 'c', shiftKey: true, ctrlKey: false, metaKey: true },
        'notebook',
        'edit'
      )
    ).toEqual({ type: 'interrupt' });
    expect(
      mapWorkspaceKey(
        { key: 'C', shiftKey: true, ctrlKey: true, metaKey: false },
        'notebook',
        'command'
      )
    ).toEqual({ type: 'interrupt' });
  });

  it('lets Cmd+V and Cmd+X reach the browser', () => {
    expect(
      mapWorkspaceKey(
        { key: 'v', shiftKey: false, ctrlKey: false, metaKey: true },
        'notebook',
        'edit',
        true
      )
    ).toBeNull();
    expect(
      mapWorkspaceKey(
        { key: 'x', shiftKey: false, ctrlKey: true, metaKey: false },
        'notebook',
        'edit',
        true
      )
    ).toBeNull();
  });

  it('ignores F4', () => {
    expect(
      mapWorkspaceKey(
        { key: 'F4', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command'
      )
    ).toBeNull();
  });

  it('does not send on Enter in an AI cell', () => {
    expect(
      mapWorkspaceKey(
        { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'edit'
      )
    ).toBeNull();
  });

  it('does not steal typing from a focused editor', () => {
    expect(
      mapWorkspaceKey(
        { key: 'a', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command',
        true
      )
    ).toBeNull();
    expect(
      mapWorkspaceKey(
        { key: 'd', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'command',
        true
      )
    ).toBeNull();
    expect(
      mapWorkspaceKey(
        { key: 'h', shiftKey: false, ctrlKey: false, metaKey: false },
        'notebook',
        'edit',
        true
      )
    ).toBeNull();
  });
});
