jest.mock('@jupyterlab/ui-components', () => ({
  ToolbarButton: class {
    enabled = true;
    constructor(readonly options: unknown) {}
  },
  addAboveIcon: {},
  addIcon: {},
  runIcon: {},
  stopIcon: {}
}));

import type { Widget } from '@lumino/widgets';

import { installAgentToolbar } from './toolbar';
import type { WorkspaceUiState } from './workspace-interaction';

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
    const uiState: WorkspaceUiState = {
      connected: true,
      error: null,
      cwd: '/work',
      selectedCellId: 'cell-1',
      activeRun: null,
      queueCount: 0,
      contextState: 'new',
      interruptAvailable: false,
      connectionLabel: 'Connected',
      executionLabel: 'Ready',
      contextLabel: 'Context: New',
      savePhase: 'saved',
      saveLabel: 'Saved',
      saveRetryAvailable: false
    };
    const host = {
      insertAbove: jest.fn(),
      insertBelow: jest.fn(),
      runAndAdvance: jest.fn(),
      interrupt: jest.fn(),
      uiState,
      subscribeUiState: jest.fn(
        (listener: (state: WorkspaceUiState) => void) => {
          listener(uiState);
          return jest.fn();
        }
      )
    };

    installAgentToolbar(toolbar, host);

    expect(classes).toEqual([
      'jp-NotebookPanel-toolbar',
      'jp-AgentWorkspace-toolbar'
    ]);
    expect(items).toEqual([
      'insert-above',
      'insert',
      'execution-separator',
      'run',
      'interrupt'
    ]);
    expect(items).not.toContain('cellType');
  });

  it('synchronizes interrupt availability and releases its subscription', () => {
    const widgets = new Map<string, Widget>();
    const toolbar = {
      addClass: jest.fn(),
      addItem: (name: string, widget: Widget) => {
        widgets.set(name, widget);
        return true;
      }
    };
    const idle: WorkspaceUiState = {
      connected: true,
      error: null,
      cwd: '/work',
      selectedCellId: 'cell-1',
      activeRun: null,
      queueCount: 0,
      contextState: 'new',
      interruptAvailable: false,
      connectionLabel: 'Connected',
      executionLabel: 'Ready',
      contextLabel: 'Context: New',
      savePhase: 'saved',
      saveLabel: 'Saved',
      saveRetryAvailable: false
    };
    let listener: ((state: WorkspaceUiState) => void) | null = null;
    const unsubscribe = jest.fn();
    const host = {
      insertAbove: jest.fn(),
      insertBelow: jest.fn(),
      runAndAdvance: jest.fn(),
      interrupt: jest.fn(),
      uiState: idle,
      subscribeUiState: (next: (state: WorkspaceUiState) => void) => {
        listener = next;
        next(idle);
        return unsubscribe;
      }
    };

    const dispose = installAgentToolbar(toolbar, host);
    const interrupt = widgets.get('interrupt') as Widget & { enabled: boolean };
    expect(interrupt.enabled).toBe(false);

    const running: WorkspaceUiState = {
      ...idle,
      activeRun: { id: 'run-1', cellId: 'cell-1' },
      interruptAvailable: true,
      executionLabel: 'Running cell-1'
    };
    const notify = listener as ((state: WorkspaceUiState) => void) | null;
    notify?.(running);
    expect(interrupt.enabled).toBe(true);

    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
