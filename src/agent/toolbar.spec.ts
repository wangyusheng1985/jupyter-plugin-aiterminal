jest.mock('@jupyterlab/ui-components', () => ({
  ToolbarButton: class {
    constructor(readonly options: unknown) {}
  },
  addAboveIcon: {},
  addIcon: {},
  runIcon: {},
  stopIcon: {}
}));

import type { Widget } from '@lumino/widgets';

import { installAgentToolbar } from './toolbar';

describe('Agent workspace toolbar', () => {
  it('installs only cell and run controls', () => {
    const items: string[] = [];
    const classes: string[] = [];
    const toolbar = {
      addClass: (name: string) => {
        classes.push(name);
      },
      addItem: (name: string, widget: Widget) => {
        void widget;
        items.push(name);
        return true;
      }
    };
    const host = {
      insertAbove: jest.fn(),
      insertBelow: jest.fn(),
      runAndAdvance: jest.fn(),
      interrupt: jest.fn()
    };

    installAgentToolbar(toolbar, host);

    expect(classes).toEqual([
      'jp-NotebookPanel-toolbar',
      'jp-AgentWorkspace-toolbar'
    ]);
    expect(items).toEqual(['insert-above', 'insert', 'run', 'interrupt']);
    expect(items).not.toContain('cellType');
  });
});
