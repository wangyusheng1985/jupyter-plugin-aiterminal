import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { ServerConnection } from '@jupyterlab/services';

import {
  AgentWorkspaceContent,
  CellView,
  StatusBar,
  type CellHandlers,
  renderBlock,
  renderCellOutput,
  renderCellOutputPreservingScroll,
  runningIndicatorNode
} from './workspace';
import {
  getResumableDshSessionReference,
  restoreNotebook,
  serializeNotebook,
  setAgentSessionReference,
  AGENT_WORKSPACE_VERSION
} from './document';
import { WorkspaceInputHistory } from './history';
import {
  InputHistoryStorage,
  type InputHistoryStorageLike
} from './history-storage';
import { WorkspaceNotebook, type WorkspaceCell } from './notebook';
import { AgentSession } from './session';
import { createTurn, setTurnStatus, toggleActivity, toggleTrace } from './turn';
import type { ConfigurationReport } from './protocol';
import {
  workspaceOverview,
  workspaceUiState,
  type WorkspaceUiState
} from './workspace-interaction';

jest.mock('@jupyterlab/cells', () => ({
  OutputPlaceholder: class {
    node = document.createElement('div');
    isAttached = false;
    text = '';
    dispose(): void {
      return;
    }
  }
}));

jest.mock('@jupyterlab/rendermime', () => ({
  renderMarkdown: jest.fn()
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn()
  });
});

class MemoryStorage implements InputHistoryStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('renderBlock', () => {
  it('creates a presentation-only three-dot running indicator', () => {
    const node = runningIndicatorNode();

    expect(node.className).toBe('jp-AgentWorkspace-runningIndicator');
    expect(node.textContent).toBe('...');
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.getAttribute('role')).toBe('presentation');
  });

  it('marks configuration errors as actionable settings feedback', () => {
    const node = renderBlock({
      kind: 'error',
      id: 'config-1',
      code: 'config',
      message:
        'AI Terminal settings are missing. Open Settings → AI Terminal and set Base URL, Model, and API Token.'
    });

    expect(node.classList.contains('is-config')).toBe(true);
    expect(node.textContent).toContain('Settings → AI Terminal');
    expect(node.textContent).toContain('Base URL');
    expect(node.textContent).toContain('Model');
    expect(node.textContent).toContain('API Token');
  });

  it('keeps the Bash command after the tool finishes', () => {
    const node = renderBlock(
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'ping -c 4 10.9.34.84 && nc -zv 10.9.34.84 22' },
        output:
          'PING 10.9.34.84 (10.9.34.84) 56(84) bytes of data.\n---NC_EXIT:0---\n',
        status: 'done'
      },
      null
    );
    expect(node.querySelector('.jp-AgentWorkspace-toolName')?.textContent).toBe(
      'Bash  •  done'
    );
    expect(
      node.querySelector('.jp-AgentWorkspace-toolInput')?.textContent
    ).toBe('$ ping -c 4 10.9.34.84 && nc -zv 10.9.34.84 22');
    expect(
      node.querySelector('.jp-AgentWorkspace-toolOutput')?.textContent
    ).toContain('---NC_EXIT:0---');
  });

  it('shows compact input for other tools while running', () => {
    const node = renderBlock(
      {
        kind: 'tool',
        id: 't2',
        name: 'Read',
        input: { file_path: '/tmp/a.py' },
        output: '',
        status: 'running'
      },
      null
    );
    expect(
      node.querySelector('.jp-AgentWorkspace-toolInput')?.textContent
    ).toBe('file_path: /tmp/a.py');
    expect(node.querySelector('.jp-AgentWorkspace-toolOutput')).toBeNull();
  });
});

describe('renderCellOutput', () => {
  function cell(overrides: Partial<WorkspaceCell>): WorkspaceCell {
    return {
      id: 'cell-1',
      kind: 'command',
      source: '',
      output: '',
      blocks: [],
      turn: null,
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides,
      agentContextGeneration: overrides.agentContextGeneration ?? null
    };
  }

  it('shows the indicator for empty running AI and Command cells', () => {
    for (const kind of ['ai', 'command'] as const) {
      const body = document.createElement('div');
      renderCellOutput(body, cell({ kind, status: 'running' }));
      expect(
        body.querySelector('.jp-AgentWorkspace-runningIndicator')
      ).not.toBeNull();
      expect(body.textContent).toBe('...');
    }
  });

  it('keeps the indicator after the latest AI and Command output', () => {
    const aiBody = document.createElement('div');
    renderCellOutput(
      aiBody,
      cell({
        kind: 'ai',
        status: 'running',
        blocks: [{ kind: 'text', id: 't1', text: 'partial' }]
      })
    );
    expect(aiBody.lastElementChild?.className).toBe(
      'jp-AgentWorkspace-runningIndicator'
    );

    const commandBody = document.createElement('div');
    const command = cell({
      kind: 'command',
      status: 'running',
      output: 'one\n'
    });
    renderCellOutput(commandBody, command);
    command.output = 'one\ntwo\n';
    renderCellOutput(commandBody, command);
    expect(commandBody.querySelector('pre')?.textContent).toBe('one\ntwo\n');
    expect(commandBody.lastElementChild?.className).toBe(
      'jp-AgentWorkspace-runningIndicator'
    );
  });

  it.each(['done', 'interrupted'] as const)(
    'removes the indicator when execution is %s',
    status => {
      const body = document.createElement('div');
      const command = cell({
        status: 'running',
        output: 'kept output'
      });
      renderCellOutput(body, command);
      command.status = status;
      renderCellOutput(body, command);
      expect(
        body.querySelector('.jp-AgentWorkspace-runningIndicator')
      ).toBeNull();
      expect(body.textContent).toBe('kept output');
    }
  );

  it('does not show the running indicator for a queued cell', () => {
    const body = document.createElement('div');
    renderCellOutput(
      body,
      cell({ status: 'queued', output: 'previous output' })
    );
    expect(
      body.querySelector('.jp-AgentWorkspace-runningIndicator')
    ).toBeNull();
    expect(body.textContent).toBe('previous output');
  });

  it('preserves output scroll position when rerendering', () => {
    const body = document.createElement('div');
    let scrollTop = 42;
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => {
        scrollTop = value;
      }
    });
    const command = cell({ output: 'one\ntwo\nthree' });

    renderCellOutputPreservingScroll(body, command);

    expect(scrollTop).toBe(42);
    expect(body.textContent).toBe('one\ntwo\nthree');
  });

  it('preserves nested evidence scroll and focused disclosure controls', () => {
    const body = document.createElement('div');
    document.body.append(body);
    const blocks = [
      {
        kind: 'text' as const,
        id: 'text-1',
        text: 'done'
      },
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'cat output.txt' },
        output: Array.from({ length: 24 }, (_, index) => `line ${index}`).join(
          '\n'
        ),
        status: 'done' as const
      }
    ];
    let turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    turn = toggleTrace(turn);
    turn = toggleActivity(turn, 'activity-tool-1');
    const ai = cell({ kind: 'ai', status: 'done', blocks, turn });

    renderCellOutput(body, ai);
    const output = body.querySelector<HTMLElement>(
      '[data-turn-scroll-key="output:activity-tool-1"]'
    );
    let outputScrollTop = 37;
    Object.defineProperty(output, 'scrollTop', {
      configurable: true,
      get: () => outputScrollTop,
      set: value => {
        outputScrollTop = value;
      }
    });
    const evidence = body.querySelector<HTMLButtonElement>(
      '[data-turn-focus-key="evidence:activity-tool-1"]'
    );
    evidence?.focus();
    outputScrollTop = 37;

    renderCellOutputPreservingScroll(body, ai);

    const rerenderedOutput = body.querySelector<HTMLElement>(
      '[data-turn-scroll-key="output:activity-tool-1"]'
    );
    expect(rerenderedOutput?.scrollTop).toBe(37);
    expect(document.activeElement).toBe(
      body.querySelector('[data-turn-focus-key="evidence:activity-tool-1"]')
    );
    body.remove();
  });
});

describe('CellView output state', () => {
  function cell(overrides: Partial<WorkspaceCell> = {}): WorkspaceCell {
    return {
      id: 'cell-1',
      kind: 'command',
      source: '',
      output: '',
      blocks: [],
      turn: null,
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides,
      agentContextGeneration: overrides.agentContextGeneration ?? null
    };
  }

  function handlers(
    onSelect = jest.fn(),
    history = new WorkspaceInputHistory()
  ): CellHandlers {
    return {
      onSource: jest.fn(),
      onSelect,
      onToggleCollapse: jest.fn(),
      onAddCell: jest.fn(),
      onHistoryPrevious: draft => history.previous(draft),
      onHistoryNext: () => history.next(),
      onHistoryReset: () => history.resetNavigation(),
      rendermime: null
    };
  }

  it('renders [*] for queued cells without a running animation', () => {
    const notebook = new WorkspaceNotebook();
    const view = new CellView('cell-1', handlers());
    const queued = cell({ status: 'queued' });

    view.sync(queued, 0, notebook);

    expect(
      view.node.querySelector('.jp-AgentWorkspace-prompt.is-input')?.textContent
    ).toContain('[*]:');
    expect(
      view.node.querySelector('.jp-AgentWorkspace-runningIndicator')
    ).toBeNull();
  });

  it('renders a unified prompt without an AI or shell badge', () => {
    const notebook = new WorkspaceNotebook();
    const view = new CellView('cell-1', handlers());
    const command = cell({
      kind: 'command',
      source: '!pwd',
      status: 'done',
      executionCount: 2
    });

    view.sync(command, 0, notebook);

    const prompt = view.node.querySelector(
      '.jp-AgentWorkspace-prompt.is-input'
    );
    expect(prompt?.textContent).toBe('[2]:');
    expect(prompt?.querySelector('.jp-AgentWorkspace-kind')).toBeNull();
    expect(view.node.classList.contains('is-command')).toBe(false);
  });

  it('shows compact collapsed output without hiding the body', () => {
    const notebook = new WorkspaceNotebook();
    const view = new CellView('cell-1', handlers());
    const compact = cell({
      status: 'done',
      output: 'long output',
      outputCollapsed: true
    });

    view.sync(compact, 0, notebook);
    const row = view.node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-row.is-output'
    );
    const body = view.node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-cellOutput'
    );
    expect(row?.classList.contains('is-collapsed')).toBe(true);
    expect(body?.hidden).toBe(false);
    expect(body?.tabIndex).toBe(0);
    expect(body?.textContent).toBe('long output');

    compact.outputCollapsed = false;
    view.sync(compact, 0, notebook);
    expect(row?.classList.contains('is-collapsed')).toBe(false);
    expect(body?.tabIndex).toBe(-1);
  });

  it('does not change selection when interacting with compact output', () => {
    const notebook = new WorkspaceNotebook();
    const onSelect = jest.fn();
    const view = new CellView('cell-1', handlers(onSelect));
    view.sync(
      cell({
        status: 'done',
        output: 'long output',
        outputCollapsed: true
      }),
      0,
      notebook
    );

    view.node
      .querySelector('.jp-AgentWorkspace-cellOutput')
      ?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not select the cell when operating a turn disclosure control', () => {
    const notebook = new WorkspaceNotebook();
    const onSelect = jest.fn();
    const view = new CellView('cell-1', handlers(onSelect));
    const blocks = [
      {
        kind: 'text' as const,
        id: 'text-1',
        text: 'finished'
      },
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'pwd' },
        output: '/tmp\n',
        status: 'done' as const
      }
    ];
    const turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    view.sync(cell({ kind: 'ai', status: 'done', blocks, turn }), 0, notebook);

    view.node
      .querySelector('[data-turn-focus-key="trace:run-1"]')
      ?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('delegates failure navigation from the audit summary', () => {
    const notebook = new WorkspaceNotebook();
    const onRevealTurnFailure = jest.fn();
    const view = new CellView('cell-1', {
      ...handlers(),
      onRevealTurnFailure
    });
    const blocks = [
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: 'target text not found\n',
        status: 'error' as const
      }
    ];
    const turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    view.sync(cell({ kind: 'ai', status: 'done', blocks, turn }), 0, notebook);

    const failure = view.node.querySelector<HTMLButtonElement>(
      '[data-failure-navigation]'
    );
    expect(failure?.type).toBe('button');
    failure?.click();

    expect(onRevealTurnFailure).toHaveBeenCalledWith(
      'cell-1',
      'run-1',
      'activity-tool-1'
    );
  });

  it('keeps a rendered turn inside the compact output collapser', () => {
    const notebook = new WorkspaceNotebook();
    const view = new CellView('cell-1', handlers());
    const blocks = [{ kind: 'text' as const, id: 'text-1', text: 'finished' }];
    const turn = setTurnStatus(createTurn('run-1'), 'done', blocks);

    view.sync(
      cell({
        kind: 'ai',
        status: 'done',
        blocks,
        turn,
        outputCollapsed: true
      }),
      0,
      notebook
    );

    expect(view.node.querySelector('.jp-AgentWorkspace-turn')).not.toBeNull();
    expect(
      view.node
        .querySelector('.jp-AgentWorkspace-row.is-output')
        ?.classList.contains('is-collapsed')
    ).toBe(true);
  });
});

describe('CellView input history', () => {
  function cell(overrides: Partial<WorkspaceCell> = {}): WorkspaceCell {
    return {
      id: 'cell-1',
      kind: 'command',
      source: '',
      output: '',
      blocks: [],
      turn: null,
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides,
      agentContextGeneration: overrides.agentContextGeneration ?? null
    };
  }

  function press(textarea: HTMLTextAreaElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(event);
    return event;
  }

  it('navigates older and newer commands and restores the draft', () => {
    const history = new WorkspaceInputHistory();
    history.add('first');
    history.add('second');
    const command = cell({ source: 'draft' });
    const onSource = jest.fn((source: string) => {
      command.source = source;
    });
    const view = new CellView('cell-1', {
      ...new InputHistoryHandlers(history),
      onSource
    });
    view.sync(command, 0, new WorkspaceNotebook());
    const textarea = view.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    expect(textarea).not.toBeNull();
    textarea?.setSelectionRange(0, 0);

    if (!textarea) return;
    press(textarea, 'ArrowUp');
    expect(textarea.value).toBe('second');
    press(textarea, 'ArrowUp');
    expect(textarea.value).toBe('first');
    press(textarea, 'ArrowDown');
    expect(textarea.value).toBe('second');
    press(textarea, 'ArrowDown');
    expect(textarea.value).toBe('draft');
    expect(command.source).toBe('draft');
    expect(history.browsing).toBe(false);
    expect(onSource).toHaveBeenLastCalledWith('draft', { fromHistory: true });
  });

  it('uses shared history in the unified input while preserving multiline caret movement', () => {
    const history = new WorkspaceInputHistory();
    history.add('shell command');
    const previous = jest.fn(() => history.previous('ignored'));
    const next = jest.fn(() => history.next());
    const view = new CellView('cell-1', {
      onSource: jest.fn(),
      onSelect: jest.fn(),
      onToggleCollapse: jest.fn(),
      onAddCell: jest.fn(),
      onHistoryPrevious: previous,
      onHistoryNext: next,
      onHistoryReset: jest.fn(),
      rendermime: null
    });
    const notebook = new WorkspaceNotebook();
    const ai = cell({ kind: 'ai', source: 'prompt' });
    view.sync(ai, 0, notebook);
    const textarea = view.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!textarea) return;
    textarea.setSelectionRange(0, 0);
    press(textarea, 'ArrowUp');
    expect(previous).toHaveBeenCalledWith('prompt');
    expect(textarea.value).toBe('shell command');

    const multiline = cell({ source: 'one\ntwo' });
    view.sync(multiline, 0, notebook);
    textarea.setSelectionRange(5, 5);
    previous.mockClear();
    press(textarea, 'ArrowUp');
    expect(previous).not.toHaveBeenCalled();
    expect(textarea.value).toBe('one\ntwo');
  });

  it('ends history navigation when recalled text is edited or the editor blurs', () => {
    const history = new WorkspaceInputHistory();
    history.add('command');
    const view = new CellView('cell-1', new InputHistoryHandlers(history));
    view.sync(cell(), 0, new WorkspaceNotebook());
    const textarea = view.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!textarea) return;

    press(textarea, 'ArrowUp');
    expect(history.browsing).toBe(true);
    textarea.value = 'edited';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(history.browsing).toBe(false);

    press(textarea, 'ArrowUp');
    expect(history.browsing).toBe(true);
    textarea.dispatchEvent(new FocusEvent('blur'));
    expect(history.browsing).toBe(false);
  });

  class InputHistoryHandlers implements CellHandlers {
    onSource = jest.fn(
      (source: string, options?: { fromHistory?: boolean }) => {
        if (!options?.fromHistory) this.history.resetNavigation();
      }
    );
    onSelect = jest.fn();
    onToggleCollapse = jest.fn();
    onAddCell = jest.fn();
    rendermime = null;

    constructor(private readonly history: WorkspaceInputHistory) {}

    onHistoryPrevious = (draft: string) => {
      return this.history.previous(draft);
    };

    onHistoryNext = () => {
      return this.history.next();
    };

    onHistoryReset = (): void => {
      this.history.resetNavigation();
    };
  }
});

describe('CellView input height', () => {
  function cell(overrides: Partial<WorkspaceCell> = {}): WorkspaceCell {
    return {
      id: 'cell-1',
      kind: 'command',
      source: '',
      output: '',
      blocks: [],
      turn: null,
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides,
      agentContextGeneration: overrides.agentContextGeneration ?? null
    };
  }

  function handlers(history = new WorkspaceInputHistory()): CellHandlers {
    return {
      onSource: jest.fn(),
      onSelect: jest.fn(),
      onToggleCollapse: jest.fn(),
      onAddCell: jest.fn(),
      onHistoryPrevious: draft => history.previous(draft),
      onHistoryNext: () => history.next(),
      onHistoryReset: () => history.resetNavigation(),
      rendermime: null
    };
  }

  function mockScrollHeight(
    editor: HTMLTextAreaElement,
    read: () => number
  ): void {
    Object.defineProperty(editor, 'scrollHeight', {
      configurable: true,
      get: read
    });
  }

  function expectFittedHeight(
    editor: HTMLTextAreaElement,
    content: number
  ): void {
    const height = Number.parseFloat(editor.style.height);
    expect(Number.isFinite(height)).toBe(true);
    expect(height).toBeGreaterThanOrEqual(content);
    expect(height).toBeLessThanOrEqual(content + 4);
  }

  function editorOf(view: CellView): HTMLTextAreaElement {
    const editor = view.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!editor) throw new Error('missing cell input');
    return editor;
  }

  it('keeps the height when layout measurement is unavailable', () => {
    const view = new CellView('cell-1', handlers());
    view.sync(cell({ source: 'one\ntwo\nthree' }), 0, new WorkspaceNotebook());

    const editor = editorOf(view);
    expect(editor.style.height).toBe('');
    expect(editor.style.overflowY).toBe('');
  });

  it('grows with soft-wrapped content and scrolls internally past the maximum', () => {
    const onSource = jest.fn();
    const view = new CellView('cell-1', { ...handlers(), onSource });
    view.sync(cell(), 0, new WorkspaceNotebook());
    const editor = editorOf(view);
    let measured = 52;
    mockScrollHeight(editor, () => measured);

    editor.value = 'single line that wraps inside a narrow row';
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onSource).toHaveBeenLastCalledWith(editor.value);
    expectFittedHeight(editor, 52);
    expect(editor.style.overflowY).toBe('hidden');

    measured = 900;
    editor.value = 'x'.repeat(2000);
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(editor.style.height).toBe('320px');
    expect(editor.style.overflowY).toBe('auto');
  });

  it('re-measures when synced source and history navigation change the text', () => {
    const history = new WorkspaceInputHistory();
    history.add('recalled\ncommand');
    const view = new CellView('cell-1', handlers(history));
    const notebook = new WorkspaceNotebook();
    const command = cell({ source: 'short' });
    view.sync(command, 0, notebook);
    const editor = editorOf(view);
    let measured = 30;
    mockScrollHeight(editor, () => measured);

    measured = 96;
    command.source = 'longer\nsource\nblock';
    view.sync(command, 0, notebook);
    expectFittedHeight(editor, 96);

    measured = 44;
    editor.setSelectionRange(0, 0);
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );

    expect(editor.value).toBe('recalled\ncommand');
    expectFittedHeight(editor, 44);
    expect(editor.style.overflowY).toBe('hidden');
  });

  it('keeps the fitted height stable across repeated syncs of the same text', () => {
    const view = new CellView('cell-1', handlers());
    const notebook = new WorkspaceNotebook();
    const command = cell({ source: 'alpha\nbeta' });
    view.sync(command, 0, notebook);
    const editor = editorOf(view);
    let measured = 64;
    mockScrollHeight(editor, () => measured);

    view.sync(command, 0, notebook);
    expectFittedHeight(editor, 64);

    measured = 200;
    view.sync(command, 0, notebook);
    expect(editor.value).toBe('alpha\nbeta');
    expectFittedHeight(editor, 64);
  });

  it('re-measures on resize and disconnects the observer on dispose', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = jest.fn();
    const observe = jest.fn();
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe = observe;
      unobserve = jest.fn();
      disconnect = disconnect;
    }
    const globals = globalThis as { ResizeObserver?: unknown };
    const previous = globals.ResizeObserver;
    globals.ResizeObserver = MockResizeObserver;
    try {
      const view = new CellView('cell-1', handlers());
      view.sync(cell({ source: 'wrapped text' }), 0, new WorkspaceNotebook());
      const editor = editorOf(view);
      const inputRow = view.node.querySelector(
        '.jp-AgentWorkspace-row.is-input'
      );
      expect(observe).toHaveBeenCalledWith(inputRow);
      expect(callbacks).toHaveLength(1);

      let measured = 0;
      mockScrollHeight(editor, () => measured);
      callbacks[0]([], {} as ResizeObserver);
      expect(editor.style.height).toBe('');

      measured = 130;
      callbacks[0]([], {} as ResizeObserver);
      expectFittedHeight(editor, 130);

      view.dispose();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete globals.ResizeObserver;
      else globals.ResizeObserver = previous;
    }
  });
});

describe('AgentWorkspaceContent queue scheduling', () => {
  interface WorkspaceInternals {
    runCell(advance: boolean): void;
    onSessionChange(): void;
    refresh(): void;
  }

  beforeEach(() => {
    jest.spyOn(AgentSession.prototype, 'connect').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'close').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'sendUser').mockImplementation(function (
      this: AgentSession,
      text: string
    ): void {
      this.blocks = [{ kind: 'user', id: 'queued-user', text }];
      this.error = null;
      this.running = true;
    });
    jest
      .spyOn(AgentSession.prototype, 'interrupt')
      .mockImplementation(() => {});
    jest
      .spyOn(AgentSession.prototype, 'interruptExec')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('connects a drained run and reports the transport wait', () => {
    const connect = jest.mocked(AgentSession.prototype.connect);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);

    expect(connect).toHaveBeenCalled();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toContain('Connecting to the Agent server before sending the queued run');
    content.dispose();
  });

  it('queues the next request and sends it only after the active AI turn ends', () => {
    const exec = jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'done\n', returncode: 0, cwd: '/tmp' });
    const sendUser = jest.mocked(AgentSession.prototype.sendUser);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('!second');
    internals.runCell(false);

    expect(sendUser).toHaveBeenCalledTimes(1);
    expect(sendUser).toHaveBeenCalledWith(
      'first',
      expect.stringMatching(/^run-/)
    );
    expect(exec).not.toHaveBeenCalled();
    expect(content.notebook.cells[0].status).toBe('running');
    expect(content.notebook.cells[1].status).toBe('queued');
    expect(content.notebook.cells[1].turn).toBeNull();

    content.session.running = false;
    content.session.connected = true;
    content.session.error = null;
    internals.onSessionChange();

    expect(content.notebook.cells[0].status).toBe('done');
    expect(content.notebook.cells[1].status).toBe('running');
    expect(exec).toHaveBeenCalledWith('second');
    expect(content.notebook.activeRun).toMatchObject({
      kind: 'command',
      source: '!second',
      executionSource: 'second'
    });

    content.dispose();
  });

  it('keeps a user-expanded execution record expanded across session updates', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;
    content.notebook.setSource('first');
    internals.runCell(false);

    const cell = content.notebook.cells[0];
    const turnId = content.notebook.activeRun!.id;
    cell.turn = toggleTrace(setTurnStatus(createTurn(turnId), 'running', []));
    expect(cell.turn.presentation.trace).toBe('expanded');

    content.session.blocks = [
      { kind: 'text', id: 'text-1', messageId: 'm1', text: 'working' }
    ];
    content.session.turn = setTurnStatus(
      createTurn(turnId),
      'running',
      content.session.blocks
    );
    internals.onSessionChange();
    expect(cell.turn?.presentation.trace).toBe('expanded');

    content.session.running = false;
    content.session.connected = true;
    content.session.error = null;
    internals.onSessionChange();
    expect(cell.status).toBe('done');
    expect(cell.turn?.presentation.trace).toBe('expanded');

    content.dispose();
  });

  it('interrupts the active AI cell and then starts the queued cell', () => {
    const interrupt = jest.mocked(AgentSession.prototype.interrupt);
    const exec = jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'next\n', returncode: 0, cwd: '/tmp' });
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('!second');
    internals.runCell(false);

    content.interrupt();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(content.notebook.activeRun?.kind).toBe('ai');

    content.session.running = false;
    content.session.connected = true;
    internals.onSessionChange();

    expect(content.notebook.cells[0].status).toBe('interrupted');
    expect(content.notebook.cells[1].status).toBe('running');
    expect(exec).toHaveBeenCalledWith('second');

    content.dispose();
  });

  it('advances a shell command to a new unified input without moving on completion', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('!second');
    internals.runCell(true);

    const selectedAfterEnqueue = content.notebook.active;
    expect(selectedAfterEnqueue).toBe(2);
    expect(content.notebook.cells[1].status).toBe('queued');
    expect(content.notebook.current).toMatchObject({
      kind: 'ai',
      source: '',
      status: 'idle'
    });

    content.session.running = false;
    content.session.connected = true;
    internals.onSessionChange();

    expect(content.notebook.active).toBe(selectedAfterEnqueue);
    content.dispose();
  });

  it('continues draining after a queued command fails', async () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockRejectedValue(new Error('command failed'));
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('!second');
    internals.runCell(false);

    content.session.running = false;
    content.session.connected = true;
    internals.onSessionChange();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(jest.mocked(AgentSession.prototype.exec)).toHaveBeenCalledWith(
      'second'
    );
    expect(content.notebook.cells[1]).toMatchObject({
      status: 'interrupted',
      output: 'Error: command failed'
    });
    expect(content.notebook.activeRun).toBeNull();
    content.dispose();
  });

  it('runs an AI cell followed by two Command cells in FIFO order', async () => {
    let resolveFirstCommand!: (result: {
      output: string;
      returncode: number;
      cwd: string;
    }) => void;
    const firstCommand = new Promise<{
      output: string;
      returncode: number;
      cwd: string;
    }>(resolve => {
      resolveFirstCommand = resolve;
    });
    const exec = jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockImplementation(source =>
        source === 'two'
          ? firstCommand
          : new Promise(() => {
              return undefined;
            })
      );
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    const firstCount = content.notebook.cells[0].executionCount;

    content.notebook.select(1);
    content.notebook.setSource('!two');
    internals.runCell(false);
    content.notebook.select(2);
    content.notebook.setSource('!three');
    internals.runCell(false);

    expect(exec).not.toHaveBeenCalled();
    expect(content.notebook.cells.slice(0, 3).map(cell => cell.status)).toEqual(
      ['running', 'queued', 'queued']
    );
    expect(
      content.notebook.cells.slice(0, 3).map(cell => cell.executionCount)
    ).toEqual([firstCount, null, null]);

    content.session.running = false;
    content.session.connected = true;
    internals.onSessionChange();

    expect(exec).toHaveBeenNthCalledWith(1, 'two');
    expect(content.notebook.cells[1]).toMatchObject({
      status: 'running',
      executionCount: (firstCount ?? 0) + 1
    });
    expect(content.notebook.cells[2].status).toBe('queued');

    resolveFirstCommand({ output: 'two done\n', returncode: 0, cwd: '/tmp' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(exec).toHaveBeenNthCalledWith(2, 'three');
    expect(content.notebook.cells[1]).toMatchObject({
      status: 'done',
      output: 'two done\n'
    });
    expect(content.notebook.cells[2]).toMatchObject({
      status: 'running',
      executionCount: (firstCount ?? 0) + 2
    });

    content.dispose();
  });

  it('discards active and queued work when the workspace is disposed', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('!second');
    internals.runCell(false);

    content.dispose();

    expect(content.notebook.activeRun).toBeNull();
    expect(content.notebook.queuedRuns).toEqual([]);
    expect(content.notebook.cells[0].status).toBe('interrupted');
    expect(content.notebook.cells[1].status).toBe('idle');
  });

  it('reveals a failed step once and focuses it after rendering', () => {
    const scrollIntoView = jest.mocked(HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;
    const blocks = [
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: 'target text not found\n',
        status: 'error' as const,
        durationMs: 198
      }
    ];
    const cell = content.notebook.current;
    cell.kind = 'ai';
    cell.status = 'done';
    cell.source = 'update the file';
    cell.blocks = blocks;
    cell.turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    document.body.append(content.node);
    internals.refresh();

    content.node
      .querySelector<HTMLButtonElement>('[data-failure-navigation]')
      ?.click();

    const row = content.node.querySelector<HTMLElement>(
      '[data-turn-activity-id="activity-tool-1"]'
    );
    expect(cell.turn?.presentation.trace).toBe('expanded');
    expect(cell.turn?.presentation.expandedActivityIds).toContain(
      'activity-tool-1'
    );
    expect(document.activeElement).toBe(row);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth'
    });

    internals.refresh();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    content.dispose();
    content.node.remove();
  });

  it('uses instant failure navigation when reduced motion is requested', () => {
    const scrollIntoView = jest.mocked(HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn()
      })
    });

    try {
      const content = new AgentWorkspaceContent(null);
      const internals = content as unknown as WorkspaceInternals;
      const blocks = [
        {
          kind: 'tool' as const,
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'false' },
          output: 'failed\n',
          status: 'error' as const
        }
      ];
      const cell = content.notebook.current;
      cell.kind = 'ai';
      cell.status = 'done';
      cell.blocks = blocks;
      cell.turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
      document.body.append(content.node);
      internals.refresh();

      content.node
        .querySelector<HTMLButtonElement>('[data-failure-navigation]')
        ?.click();

      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto'
      });
      content.dispose();
      content.node.remove();
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          writable: true,
          value: originalMatchMedia
        });
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });
});

describe('AgentWorkspaceContent input history', () => {
  interface WorkspaceInternals {
    runCell(advance: boolean): void;
    refresh(): void;
  }

  async function attachWorkspaceContext(
    content: AgentWorkspaceContent,
    path: string
  ): Promise<void> {
    let text = serializeNotebook(content.notebook);
    const context = {
      path,
      ready: Promise.resolve(),
      isReady: true,
      model: {
        toString: () => text,
        fromString: jest.fn((value: string) => {
          text = value;
        }),
        contentChanged: {
          connect: jest.fn()
        }
      },
      save: jest.fn().mockResolvedValue(undefined)
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    content.attachContext(context);
    await Promise.resolve();
  }

  beforeEach(() => {
    jest.spyOn(AgentSession.prototype, 'connect').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'close').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'sendUser').mockImplementation(function (
      this: AgentSession,
      text: string
    ): void {
      this.blocks = [{ kind: 'user', id: 'history-user', text }];
      this.error = null;
      this.running = true;
    });
    jest
      .spyOn(AgentSession.prototype, 'interrupt')
      .mockImplementation(() => {});
    jest
      .spyOn(AgentSession.prototype, 'interruptExec')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows unified status text without an AI or Command mode label', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;
    const status = content.node.querySelector('.jp-AgentWorkspace-status');

    expect(status?.textContent).toContain('Local tools');
    expect(status?.textContent).toContain('Ready');
    content.notebook.setSource('!pwd');
    internals.refresh();
    expect(status?.textContent).not.toMatch(/AI|Command/);
    content.dispose();
  });

  it('keeps shared input histories isolated by tab and out of serialization', () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'ok\n', returncode: 0, cwd: '/tmp' });
    const first = new AgentWorkspaceContent(null);
    const second = new AgentWorkspaceContent(null);
    const firstInternals = first as unknown as WorkspaceInternals;

    first.notebook.setSource('explain this repository');
    firstInternals.runCell(false);
    first.notebook.appendCell();
    first.notebook.setSource('!pwd');
    firstInternals.runCell(false);

    expect(first.inputHistory.values).toEqual([
      'explain this repository',
      '!pwd'
    ]);
    expect(second.inputHistory.values).toEqual([]);

    const restored = new AgentWorkspaceContent(null);
    restoreNotebook(restored.notebook, serializeNotebook(first.notebook));
    expect(restored.inputHistory.values).toEqual([]);

    first.dispose();
    second.dispose();
    restored.dispose();
  });

  it('persists unified inputs by workspace path and restores shared history', async () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockImplementation(() => new Promise(() => undefined));
    const memory = new MemoryStorage();
    const storage = new InputHistoryStorage(memory);
    const path = 'work/session.agentnb';
    const first = new AgentWorkspaceContent(null, undefined, storage);
    const firstInternals = first as unknown as WorkspaceInternals;
    await attachWorkspaceContext(first, path);

    first.notebook.setSource('explain this repository');
    firstInternals.runCell(false);
    first.notebook.appendCell();
    first.notebook.setSource('!pwd');
    firstInternals.runCell(false);

    expect(first.inputHistory.values).toEqual([
      'explain this repository',
      '!pwd'
    ]);
    expect(storage.load(path)).toEqual(['explain this repository', '!pwd']);
    first.dispose();

    const restored = new AgentWorkspaceContent(null, undefined, storage);
    const restoredInternals = restored as unknown as WorkspaceInternals;
    await attachWorkspaceContext(restored, path);
    restoredInternals.refresh();

    expect(restored.inputHistory.values).toEqual([
      'explain this repository',
      '!pwd'
    ]);
    const aiInput = restored.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!aiInput) return;
    aiInput.setSelectionRange(0, 0);
    aiInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(aiInput.value).toBe('!pwd');
    aiInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(aiInput.value).toBe('explain this repository');
    aiInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(aiInput.value).toBe('!pwd');
    aiInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(aiInput.value).toBe('');

    restored.notebook.insertBelow();
    restoredInternals.refresh();
    const inputs = restored.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    const newInput = inputs[restored.notebook.active];
    newInput.setSelectionRange(0, 0);
    newInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(newInput.value).toBe('!pwd');
    restored.dispose();

    const other = new AgentWorkspaceContent(null, undefined, storage);
    await attachWorkspaceContext(other, 'work/other.agentnb');
    expect(other.inputHistory.values).toEqual([]);
    other.dispose();
  });

  it('ignores rejected, unsubmitted, and consecutive duplicate inputs', async () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockImplementation(() => new Promise(() => undefined));
    const memory = new MemoryStorage();
    const setItem = jest.spyOn(memory, 'setItem');
    const content = new AgentWorkspaceContent(
      null,
      undefined,
      new InputHistoryStorage(memory)
    );
    const internals = content as unknown as WorkspaceInternals;
    await attachWorkspaceContext(content, 'work/duplicates.agentnb');

    content.notebook.setSource('!pwd');
    internals.runCell(false);
    expect(setItem).toHaveBeenCalledTimes(1);

    content.notebook.appendCell();
    content.notebook.setSource('unsubmitted draft');
    expect(content.inputHistory.values).toEqual(['!pwd']);
    expect(setItem).toHaveBeenCalledTimes(1);

    content.notebook.setSource(' !pwd ');
    internals.runCell(false);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(content.inputHistory.values).toEqual(['!pwd']);

    content.notebook.appendCell();
    content.notebook.setSource(' !  ');
    internals.runCell(false);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(content.inputHistory.values).toEqual(['!pwd']);
    content.dispose();
  });

  it('records a command when accepted and keeps it after a failed run', async () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockRejectedValue(new Error('command failed'));
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('!false');
    internals.runCell(false);
    expect(content.inputHistory.values).toEqual(['!false']);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(content.inputHistory.values).toEqual(['!false']);
    content.dispose();
  });

  it('focuses the advanced input and recalls the command after Shift+Enter', () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockImplementation(() => new Promise(() => undefined));
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    const firstInput = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!firstInput) return;

    firstInput.value = '!pwd';
    firstInput.dispatchEvent(new Event('input', { bubbles: true }));
    firstInput.setSelectionRange(0, 0);
    firstInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );

    expect(content.notebook.active).toBe(1);
    const inputs = content.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    const nextInput = inputs[content.notebook.active];
    expect(nextInput.readOnly).toBe(false);
    expect(document.activeElement).toBe(nextInput);
    expect(content.notebook.current).toMatchObject({
      kind: 'ai',
      source: ''
    });

    nextInput.setSelectionRange(0, 0);
    nextInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(nextInput.value).toBe('!pwd');
    content.dispose();
    content.node.remove();
  });

  it('records a queued command before it starts executing', () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockImplementation(() => new Promise(() => undefined));
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first AI request');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('!pwd');
    internals.runCell(false);

    expect(content.notebook.cells[1].status).toBe('queued');
    expect(content.inputHistory.values).toEqual(['first AI request', '!pwd']);
    content.dispose();
  });

  it('adds AI submissions to shared history for unified-input recall', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('explain this repository');
    internals.runCell(false);

    expect(content.inputHistory.values).toEqual(['explain this repository']);
    content.notebook.advanceAfterRun();
    internals.refresh();
    const inputs = content.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    const input = inputs[content.notebook.active];
    input.setSelectionRange(0, 0);
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(input.value).toBe('explain this repository');
    content.dispose();
  });

  it('classifies remembered shell input and returns to AI after the marker is deleted', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;
    content.inputHistory.add('!pwd');
    internals.refresh();
    const input = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!input) return;

    input.setSelectionRange(0, 0);
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );

    expect(input.value).toBe('!pwd');
    expect(content.notebook.enqueueRun()).toMatchObject({
      kind: 'command',
      source: '!pwd',
      executionSource: 'pwd'
    });

    input.value = 'pwd';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(content.notebook.enqueueRun()).toMatchObject({
      kind: 'ai',
      source: 'pwd',
      executionSource: 'pwd'
    });
    content.dispose();
  });

  it('restores a shell marker and returns to AI when that marker is deleted', () => {
    const saved = new WorkspaceNotebook();
    saved.setSource('!pwd');
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;
    restoreNotebook(content.notebook, serializeNotebook(saved));
    internals.refresh();
    const input = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!input) return;

    expect(input.value).toBe('!pwd');
    expect(content.notebook.enqueueRun()).toMatchObject({
      kind: 'command',
      executionSource: 'pwd'
    });

    input.value = 'pwd';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(content.notebook.enqueueRun()).toMatchObject({
      kind: 'ai',
      executionSource: 'pwd'
    });
    content.dispose();
  });

  it('keeps queued command entries after interrupted execution', async () => {
    jest.spyOn(AgentSession.prototype, 'exec').mockResolvedValue({
      output: 'interrupted\n',
      returncode: 1,
      cwd: '/tmp'
    });
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('!sleep 10');
    internals.runCell(false);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(content.notebook.cells[0].status).toBe('interrupted');
    expect(content.inputHistory.values).toEqual(['!sleep 10']);
    content.dispose();
  });

  it('recalls shared AI and Command history in new AI cells per tab', () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'ok\n', returncode: 0, cwd: '/tmp' });
    const first = new AgentWorkspaceContent(null);
    const second = new AgentWorkspaceContent(null);
    const firstInternals = first as unknown as WorkspaceInternals;
    const secondInternals = second as unknown as WorkspaceInternals;

    first.notebook.setSource('!first command');
    firstInternals.runCell(false);
    first.notebook.appendCell();
    first.notebook.setSource('first prompt');
    firstInternals.runCell(false);
    first.notebook.setSource('unsubmitted draft');
    firstInternals.refresh();

    const firstInputs = first.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    const firstInput = firstInputs[first.notebook.active];
    firstInput.setSelectionRange(0, 0);
    firstInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(firstInput.value).toBe('first prompt');
    firstInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(firstInput.value).toBe('!first command');
    firstInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(firstInput.value).toBe('first prompt');
    firstInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(firstInput.value).toBe('unsubmitted draft');

    second.notebook.enterEdit();
    secondInternals.refresh();
    const secondInput = second.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    if (!secondInput) return;
    secondInput.setSelectionRange(0, 0);
    secondInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(secondInput.value).toBe('');

    first.insertBelow();
    firstInternals.refresh();
    const aiInputs = first.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    const aiInput = aiInputs[first.notebook.active];
    aiInput.setSelectionRange(0, 0);
    aiInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true
      })
    );
    expect(aiInput.value).toBe('first prompt');

    first.dispose();
    second.dispose();
  });
});

describe('AgentWorkspaceContent page interaction', () => {
  const acceptedSessionId = '123e4567-e89b-12d3-a456-426614174000';

  interface PageInternals {
    refresh(): void;
    runCell(advance: boolean): void;
    onSessionChange(): void;
    persistNow(): void;
    saveCoordinator: {
      flush(): Promise<void>;
      state: {
        phase: string;
        requestedRevision: number;
        savedRevision: number;
      };
    };
    notebookView: {
      isOutputTailNearViewport(cellId: string): boolean;
      isEditingAnotherCell(cellId: string): boolean;
      revealOutputTail(cellId: string): void;
    };
  }

  function promiseController(): {
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  } {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function attachSaveContext(
    content: AgentWorkspaceContent,
    save: jest.Mock<Promise<unknown>, []>,
    initialText = serializeNotebook(content.notebook)
  ): {
    context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    fromString: jest.Mock<void, [string]>;
    text(): string;
  } {
    let text = initialText;
    const fromString = jest.fn<void, [string]>(value => {
      text = value;
    });
    const context = {
      path: 'save-state.agentnb',
      ready: Promise.resolve(),
      isReady: true,
      model: {
        toString: () => text,
        fromString,
        contentChanged: { connect: jest.fn() }
      },
      save
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    content.attachContext(context);
    return { context, fromString, text: () => text };
  }

  beforeEach(() => {
    jest.spyOn(AgentSession.prototype, 'connect').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'close').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'sendUser').mockImplementation(function (
      this: AgentSession
    ): void {
      this.running = true;
      this.error = null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function rect(top: number, height: number, width = 800): DOMRect {
    return {
      top,
      bottom: top + height,
      left: 0,
      right: width,
      width,
      height,
      x: 0,
      y: top,
      toJSON: () => ({})
    } as DOMRect;
  }

  function historicalWorkspace(
    content: AgentWorkspaceContent,
    draftSource = '结果如何了？'
  ): { historical: WorkspaceCell; draft: WorkspaceCell } {
    const historical = content.notebook.current;
    historical.source = '清理磁盘空间';
    historical.status = 'done';
    historical.executionCount = 1;
    historical.blocks = [
      {
        kind: 'text',
        id: 'history-outcome',
        text: '清理任务仍在后台运行。'
      },
      {
        kind: 'tool',
        id: 'history-task',
        name: 'Bash',
        input: { command: 'destructive historical command' },
        output:
          'Command running in background with ID: task-1. Output is being written to: /tmp/task-1.output. You will be notified when it completes.',
        status: 'done'
      }
    ];
    const draft = content.notebook.appendCell();
    draft.source = draftSource;
    return { historical, draft };
  }

  function acceptActiveAgentRun(
    content: AgentWorkspaceContent,
    internals: PageInternals
  ): string {
    const requestId = content.notebook.activeRun?.id;
    expect(requestId).toBeDefined();
    content.session.sessionId = acceptedSessionId;
    content.session.acceptedTurnId = requestId ?? null;
    internals.onSessionChange();
    return requestId ?? '';
  }

  it('composes one notebook scroller and a reserved navigator inside the body', () => {
    const content = new AgentWorkspaceContent(null);
    const body = content.node.querySelector('.jp-AgentWorkspace-body');

    expect(body).not.toBeNull();
    expect(body?.querySelectorAll('.jp-AgentWorkspace-notebook')).toHaveLength(
      1
    );
    expect(body?.querySelectorAll('.jp-AgentWorkspace-navigator')).toHaveLength(
      1
    );
    expect(
      content.node.querySelector('.jp-AgentWorkspace-status')?.parentElement
    ).toBe(content.node);
    content.dispose();
  });

  it('renders fixed status regions for connection, cwd, and execution state', () => {
    const onStartNewContext = jest.fn();
    const onContinueFromHistory = jest.fn();
    const onStartEmptyContext = jest.fn();
    const onDismissContextChoice = jest.fn();
    const onRevealFailure = jest.fn();
    const onRevealInterrupted = jest.fn();
    const onOpenHistory = jest.fn();
    const onRefreshConfiguration = jest.fn();
    const onRetrySave = jest.fn();
    const status = new StatusBar({
      onStartNewContext,
      onContinueFromHistory,
      onStartEmptyContext,
      onDismissContextChoice,
      onRevealFailure,
      onRevealInterrupted,
      onOpenHistory,
      onRefreshConfiguration,
      onRetrySave
    });
    const overview = {
      submittedCount: 2,
      aiCount: 2,
      commandCount: 0,
      queuedCount: 0,
      runningCount: 1,
      interruptedCount: 1,
      failureCount: 2,
      firstFailureCellId: 'cell-1',
      firstInterruptedCellId: 'cell-2',
      summaryLabel: '2 turns · 1 interrupted · 2 failed'
    };
    status.sync(
      {
        connected: false,
        error: 'offline',
        cwd: '/a/very/long/workspace/path',
        selectedCellId: 'cell-1',
        activeRun: { id: 'run-1', cellId: 'cell-1' },
        queueCount: 2,
        contextState: 'unavailable',
        interruptAvailable: true,
        connectionLabel: 'Connection error',
        executionLabel: 'Running cell-1 · Queue 2',
        contextLabel: 'Context: Unavailable',
        savePhase: 'error',
        saveLabel: 'Not saved',
        saveRetryAvailable: true
      },
      overview
    );

    expect(
      status.node.querySelector('.jp-AgentWorkspace-statusConnection')
        ?.textContent
    ).toBe('Connection error');
    expect(
      status.node
        .querySelector('.jp-AgentWorkspace-statusConnection')
        ?.classList.contains('is-error')
    ).toBe(true);
    expect(
      status.node.querySelector('.jp-AgentWorkspace-statusCwd')?.textContent
    ).toBe('/a/very/long/workspace/path');
    expect(
      status.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toBe('Running cell-1 · Queue 2');
    expect(
      status.node.querySelector('.jp-AgentWorkspace-statusContext')?.textContent
    ).toBe('Context: Unavailable');
    const saveStatus = status.node.querySelector(
      '.jp-AgentWorkspace-statusSave'
    );
    expect(saveStatus?.textContent).toBe('Not savedRetry');
    expect(saveStatus?.classList.contains('is-error')).toBe(true);
    const retrySave = status.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-retrySave'
    );
    expect(retrySave?.hidden).toBe(false);
    expect(retrySave?.getAttribute('aria-label')).toBe(
      'Retry saving workspace'
    );
    retrySave?.click();
    retrySave?.click();
    expect(onRetrySave).toHaveBeenCalledTimes(1);
    document.body.append(status.node);
    const context = status.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-statusContext'
    );
    const savingState = workspaceUiState({
      connected: false,
      error: 'offline',
      cwd: '/a/very/long/workspace/path',
      selectedCellId: 'cell-1',
      activeRun: { id: 'run-1', cellId: 'cell-1' },
      queueCount: 2,
      contextState: 'unavailable',
      savePhase: 'saving'
    });
    context?.focus();
    status.sync(savingState, overview);
    expect(document.activeElement).toBe(context);
    expect(
      status.node.querySelector('.jp-AgentWorkspace-statusSaveText')
        ?.textContent
    ).toBe('Saving…');
    expect(retrySave?.hidden).toBe(true);
    status.sync(
      workspaceUiState({ ...savingState, savePhase: 'saved' }),
      overview
    );
    expect(
      status.node.querySelector('.jp-AgentWorkspace-statusSaveText')
        ?.textContent
    ).toBe('Saved');
    expect(document.activeElement).toBe(context);
    status.node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-statusOverview')
      ?.click();
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    status.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-statusIssue.is-failed'
      )
      ?.click();
    expect(onRevealFailure).toHaveBeenCalledWith('cell-1');
    status.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-statusIssue.is-interrupted'
      )
      ?.click();
    expect(onRevealInterrupted).toHaveBeenCalledWith('cell-2');
    context?.click();
    expect(
      status.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(false);
    status.node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );
    expect(
      status.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(true);
    context?.click();
    expect(onStartNewContext).not.toHaveBeenCalled();
    const reset = status.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-resetContext'
    );
    expect(reset?.disabled).toBe(true);
    if (reset) reset.disabled = false;
    reset?.click();
    expect(onStartNewContext).toHaveBeenCalledTimes(1);
    status.dispose();
    status.node.remove();
  });

  it('configures saved context before the first production connection', async () => {
    const connect = jest.mocked(AgentSession.prototype.connect);
    connect.mockClear();
    const content = new AgentWorkspaceContent(null);
    expect(connect).not.toHaveBeenCalled();
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const context = {
      path: 'resume.agentnb',
      ready: Promise.resolve(),
      isReady: true,
      model: {
        toString: () =>
          JSON.stringify({
            version: 3,
            active: 0,
            agentSessionId: id,
            cells: []
          }),
        fromString: jest.fn(),
        contentChanged: { connect: jest.fn() }
      },
      save: jest.fn().mockResolvedValue(undefined)
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;

    content.attachContext(context);
    await Promise.resolve();

    expect(content.session.sessionId).toBe(id);
    expect(connect).toHaveBeenCalledTimes(1);
    content.dispose();
  });

  it('persists a confirmed session ID without storing runtime secrets', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    let text = serializeNotebook(content.notebook);
    const fromString = jest.fn((value: string) => {
      text = value;
    });
    const context = {
      path: 'persist-session.agentnb',
      ready: Promise.resolve(),
      isReady: true,
      model: {
        toString: () => text,
        fromString,
        contentChanged: { connect: jest.fn() }
      },
      save: jest.fn().mockResolvedValue(undefined)
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    content.attachContext(context);
    await Promise.resolve();
    const id = '123e4567-e89b-12d3-a456-426614174000';
    content.session.sessionId = id;
    content.session.contextState = 'live';

    internals.onSessionChange();
    internals.persistNow();

    expect(JSON.parse(text).agentSessionId).toBe(id);
    expect(text).not.toMatch(
      /token|password|transcript|savePhase|requestedRevision|savedRevision|retrySave/i
    );
    content.notebook.current.output = 'output-only update';
    internals.refresh();
    expect(fromString).toHaveBeenCalledTimes(1);
    content.dispose();
  });

  it('restores an idle external model as saved without writing it back', async () => {
    const content = new AgentWorkspaceContent(null);
    const external = new WorkspaceNotebook();
    external.current.source = 'external authoritative state';
    let text = serializeNotebook(content.notebook);
    let contentChanged: {
      slot: () => void;
      thisArg: AgentWorkspaceContent;
    } | null = null;
    const fromString = jest.fn((value: string) => {
      text = value;
    });
    const save = jest.fn().mockResolvedValue(undefined);
    const context = {
      path: 'external.agentnb',
      ready: Promise.resolve(),
      isReady: true,
      model: {
        toString: () => text,
        fromString,
        contentChanged: {
          connect: jest.fn(
            (slot: () => void, thisArg: AgentWorkspaceContent) => {
              contentChanged = { slot, thisArg };
            }
          )
        }
      },
      save
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    content.attachContext(context);
    await Promise.resolve();

    text = serializeNotebook(external);
    const change = contentChanged as {
      slot: () => void;
      thisArg: AgentWorkspaceContent;
    } | null;
    change?.slot.call(change.thisArg);

    expect(content.notebook.current.source).toBe(
      'external authoritative state'
    );
    expect(content.uiState.savePhase).toBe('saved');
    expect(save).not.toHaveBeenCalled();
    expect(fromString).not.toHaveBeenCalled();
    content.dispose();
  });

  it('shows durable save truth and retries failure without moving focus', async () => {
    const first = promiseController();
    const second = promiseController();
    const save = jest
      .fn<Promise<unknown>, []>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    attachSaveContext(content, save);
    await Promise.resolve();
    document.body.append(content.node);
    const editor = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    editor?.focus();
    content.notebook.current.source = 'durable draft';

    internals.persistNow();

    expect(save).toHaveBeenCalledTimes(1);
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusSaveText')
        ?.textContent
    ).toBe('Saving…');
    expect(document.activeElement).toBe(editor);

    first.reject(new Error('disk unavailable'));
    await expect(internals.saveCoordinator.flush()).rejects.toThrow(
      'disk unavailable'
    );
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusSaveText')
        ?.textContent
    ).toBe('Not saved');
    const retry = content.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-retrySave'
    );
    expect(retry?.hidden).toBe(false);
    expect(document.activeElement).toBe(editor);

    retry?.click();
    retry?.click();
    expect(save).toHaveBeenCalledTimes(2);
    expect(retry?.hidden).toBe(true);
    second.resolve();
    await internals.saveCoordinator.flush();

    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusSaveText')
        ?.textContent
    ).toBe('Saved');
    expect(document.activeElement).toBe(editor);
    content.dispose();
    content.node.remove();
  });

  it('coalesces workspace mutations made during an in-flight save', async () => {
    const first = promiseController();
    const second = promiseController();
    const save = jest
      .fn<Promise<unknown>, []>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const attached = attachSaveContext(content, save);
    await Promise.resolve();

    content.notebook.current.source = 'first revision';
    internals.persistNow();
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(attached.text()).cells[0].source).toBe('first revision');

    content.notebook.current.source = 'latest revision';
    internals.persistNow();
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
    expect(JSON.parse(attached.text()).cells[0].source).toBe('latest revision');

    second.resolve();
    await internals.saveCoordinator.flush();
    expect(internals.saveCoordinator.state).toMatchObject({
      phase: 'saved',
      requestedRevision: 2,
      savedRevision: 2
    });
    content.dispose();
  });

  it('keeps AI execution usable while recovering from a save failure', async () => {
    const save = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    attachSaveContext(content, save);
    await Promise.resolve();
    content.notebook.current.source = 'first unsaved draft';
    internals.persistNow();
    await expect(internals.saveCoordinator.flush()).rejects.toThrow('offline');
    const sendUser = jest.spyOn(content.session, 'sendUser');

    content.notebook.current.source = 'run while recovering';
    internals.runCell(false);

    expect(sendUser).toHaveBeenCalledWith(
      'run while recovering',
      expect.any(String)
    );
    expect(content.notebook.activeRun).not.toBeNull();
    expect(internals.saveCoordinator.state.phase).toBe('pending');
    await internals.saveCoordinator.flush();
    expect(internals.saveCoordinator.state.phase).toBe('saved');
    content.dispose();
  });

  it('drains the newest save before closing the Agent session', async () => {
    const first = promiseController();
    const second = promiseController();
    const save = jest
      .fn<Promise<unknown>, []>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const close = jest.mocked(AgentSession.prototype.close);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    attachSaveContext(content, save);
    await Promise.resolve();

    content.notebook.current.source = 'older revision';
    internals.persistNow();
    content.notebook.current.source = 'shutdown revision';
    internals.persistNow();
    const shutdown = content.shutdownOnce();
    expect(content.shutdownOnce()).toBe(shutdown);
    expect(close).not.toHaveBeenCalled();

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();

    second.resolve();
    await shutdown;
    expect(close).toHaveBeenCalledTimes(1);
    content.dispose();
  });

  it('releases the Agent session when the final shutdown save fails', async () => {
    const save = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValue(new Error('save failed'));
    const close = jest.mocked(AgentSession.prototype.close);
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    attachSaveContext(content, save);
    await Promise.resolve();
    content.notebook.current.source = 'unsaved shutdown';
    internals.persistNow();

    await content.shutdownOnce();

    expect(close).toHaveBeenCalledTimes(1);
    expect(internals.saveCoordinator.state.phase).toBe('error');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('not saved during shutdown')
    );
    content.dispose();
  });

  it('blocks unavailable AI work, keeps Command work usable, and resets safely', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const exec = jest
      .spyOn(content.session, 'exec')
      .mockReturnValue(new Promise(() => undefined));
    content.notebook.current.source = 'continue old work';
    content.notebook.current.status = 'idle';
    content.session.contextState = 'unavailable';
    content.notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';
    content.notebook.agentContextGeneration = 2;
    const cellsBefore = content.notebook.cells.length;

    internals.runCell(false);
    expect(content.notebook.activeRun).toBeNull();
    expect(content.notebook.cells).toHaveLength(cellsBefore);

    content.notebook.current.source = '!pwd';
    internals.runCell(false);
    expect(exec).toHaveBeenCalledWith('pwd');

    content.notebook.clearRuns();
    internals.refresh();
    content.node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-statusContext')
      ?.click();
    content.node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-resetContext')
      ?.click();
    expect(content.notebook.agentSessionId).toBeNull();
    expect(content.notebook.agentContextGeneration).toBe(3);
    expect(content.notebook.cells).toHaveLength(cellsBefore + 1);
    expect(content.session.contextState).toBe('reset');
    content.dispose();
  });

  it('gates uncovered AI history while keeping Command execution available', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const { draft } = historicalWorkspace(content);
    const sendUser = jest.spyOn(content.session, 'sendUser');
    const exec = jest
      .spyOn(content.session, 'exec')
      .mockReturnValue(new Promise(() => undefined));
    internals.refresh();

    internals.runCell(false);

    expect(content.notebook.activeRun).toBeNull();
    expect(draft).toMatchObject({
      source: '结果如何了？',
      status: 'idle',
      executionCount: null,
      agentContextGeneration: null
    });
    expect(sendUser).not.toHaveBeenCalled();
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-historyChoice'
      )?.hidden
    ).toBe(false);
    expect(
      content.node.querySelector('.jp-AgentWorkspace-historyChoiceDescription')
        ?.textContent
    ).toContain('outside the current Agent context');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusContext')
        ?.textContent
    ).toContain('1 outside');

    const command = content.notebook.appendCell();
    command.source = '!pwd';
    internals.runCell(false);

    expect(exec).toHaveBeenCalledWith('pwd');
    expect(sendUser).not.toHaveBeenCalled();
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-historyChoice'
      )?.hidden
    ).toBe(false);
    content.dispose();
  });

  it('gates restored version 4 coverage when its session link is missing', () => {
    const source = new WorkspaceNotebook();
    const bridged = source.current;
    bridged.source = 'visible bridged history';
    bridged.status = 'done';
    bridged.executionCount = 1;
    const native = source.insertBelow();
    native.source = 'visible native history';
    native.status = 'done';
    native.executionCount = 2;
    native.agentContextGeneration = 0;
    const draft = source.insertBelow();
    draft.source = '结果如何了？';
    source.agentContextBridges = [{ generation: 0, cellIds: [bridged.id] }];
    source.agentSessionId = null;

    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    restoreNotebook(content.notebook, serializeNotebook(source));
    const sendUser = jest.spyOn(content.session, 'sendUser');
    internals.refresh();
    internals.runCell(false);

    expect(content.notebook.cells[1].agentContextGeneration).toBeNull();
    expect(content.notebook.agentContextBridges).toEqual([]);
    expect(content.notebook.activeRun).toBeNull();
    expect(sendUser).not.toHaveBeenCalled();
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-historyChoice'
      )?.hidden
    ).toBe(false);
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusContext')
        ?.textContent
    ).toContain('2 outside');
    content.dispose();
  });

  it('submits a bounded bridge exactly once and preserves visible source', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const { historical, draft } = historicalWorkspace(content);
    const sendUser = jest.spyOn(content.session, 'sendUser');
    internals.refresh();
    internals.runCell(false);
    const continueButton = content.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-contextChoice.is-primary'
    );

    continueButton?.click();

    expect(sendUser).toHaveBeenCalledTimes(1);
    expect(sendUser).toHaveBeenCalledWith(
      '结果如何了？',
      expect.any(String),
      expect.objectContaining({
        version: 1,
        turns: [
          expect.objectContaining({
            cellId: historical.id,
            source: '清理磁盘空间',
            taskIds: ['task-1']
          })
        ],
        tasks: [
          expect.objectContaining({
            taskId: 'task-1',
            outputPath: '/tmp/task-1.output'
          })
        ]
      })
    );
    expect(draft.source).toBe('结果如何了？');
    expect(draft.agentContextGeneration).toBeNull();
    expect(content.notebook.agentContextBridges).toEqual([]);
    expect(continueButton?.disabled).toBe(true);
    expect(continueButton?.textContent).toBe('Continuing…');
    expect(
      content.node
        .querySelector('.jp-AgentWorkspace-historyChoice')
        ?.getAttribute('aria-busy')
    ).toBe('true');

    continueButton?.click();
    expect(sendUser).toHaveBeenCalledTimes(1);
    content.node.querySelector('.jp-AgentWorkspace-status')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(false);

    acceptActiveAgentRun(content, internals);

    expect(content.notebook.agentSessionId).toBe(acceptedSessionId);
    expect(draft.agentContextGeneration).toBe(0);
    expect(content.notebook.agentContextBridges).toEqual([
      { generation: 0, cellIds: [historical.id] }
    ]);
    const reopened = new WorkspaceNotebook();
    restoreNotebook(reopened, serializeNotebook(content.notebook));
    expect(reopened.agentSessionId).toBe(acceptedSessionId);
    expect(reopened.agentContextBridges).toEqual([
      { generation: 0, cellIds: [historical.id] }
    ]);
    expect(
      reopened.cells.find(cell => cell.id === draft.id)?.agentContextGeneration
    ).toBe(0);
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusContext')
        ?.textContent
    ).toContain('1 bridged');
    content.node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-statusContext')
      ?.click();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-contextDescription')
        ?.textContent
    ).toContain('Coverage: 1 native, 1 bridged, 0 outside.');
    content.dispose();
  });

  it('returns focus from the hidden acceptance control to the submitted Cell', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    historicalWorkspace(content);
    document.body.append(content.node);
    internals.refresh();
    internals.runCell(false);
    await Promise.resolve();
    const continueButton = content.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-contextChoice.is-primary'
    );
    expect(document.activeElement).toBe(continueButton);

    continueButton?.click();
    acceptActiveAgentRun(content, internals);
    await Promise.resolve();

    expect(document.activeElement).toBe(
      content.node.querySelectorAll('.jp-AgentWorkspace-cellInput')[1]
    );
    expect(document.activeElement).not.toBe(continueButton);
    content.dispose();
    content.node.remove();
  });

  it('returns focus after pre-acceptance failure without stealing it from an advanced draft', async () => {
    const failed = new AgentWorkspaceContent(null);
    const failedInternals = failed as unknown as PageInternals;
    historicalWorkspace(failed);
    document.body.append(failed.node);
    failedInternals.refresh();
    failedInternals.runCell(false);
    await Promise.resolve();
    failed.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-contextChoice.is-primary'
      )
      ?.click();
    failed.session.error = 'query rejected';
    failed.session.running = false;
    failedInternals.onSessionChange();
    await Promise.resolve();
    expect(document.activeElement).toBe(
      failed.node.querySelectorAll('.jp-AgentWorkspace-cellInput')[1]
    );
    failed.dispose();
    failed.node.remove();

    const advanced = new AgentWorkspaceContent(null);
    const advancedInternals = advanced as unknown as PageInternals;
    const { draft } = historicalWorkspace(advanced);
    document.body.append(advanced.node);
    advancedInternals.refresh();
    advancedInternals.runCell(true);
    await Promise.resolve();
    advanced.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-contextChoice.is-primary'
      )
      ?.click();
    const nextDraft = advanced.notebook.current;
    expect(nextDraft.id).not.toBe(draft.id);
    const nextEditor = advanced.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    )[2];
    expect(document.activeElement).toBe(nextEditor);

    acceptActiveAgentRun(advanced, advancedInternals);
    await Promise.resolve();

    expect(document.activeElement).toBe(nextEditor);
    advanced.dispose();
    advanced.node.remove();
  });

  it('starts an explicit empty generation before submitting the draft', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const { historical, draft } = historicalWorkspace(content);
    content.notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';
    content.session.sessionId = content.notebook.agentSessionId;
    content.session.contextState = 'resumed';
    const sendUser = jest.spyOn(content.session, 'sendUser');
    internals.refresh();
    internals.runCell(false);

    const emptyButton = content.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-contextChoice.is-secondary'
    );
    emptyButton?.click();

    expect(content.notebook.agentSessionId).toBeNull();
    expect(content.notebook.agentContextGeneration).toBe(1);
    expect(content.notebook.agentContextBridges).toEqual([
      { generation: 1, cellIds: [] }
    ]);
    expect(historical.agentContextGeneration).toBeNull();
    expect(draft.agentContextGeneration).toBeNull();
    expect(emptyButton?.disabled).toBe(true);
    expect(emptyButton?.textContent).toBe('Starting…');
    expect(sendUser).toHaveBeenCalledWith('结果如何了？', expect.any(String));

    acceptActiveAgentRun(content, internals);

    expect(historical.agentContextGeneration).toBeNull();
    expect(draft.agentContextGeneration).toBe(1);
    content.dispose();
  });

  it('does not commit bridge membership when the SDK rejects before acceptance', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const { historical, draft } = historicalWorkspace(content);
    historical.agentContextGeneration = 2;
    content.notebook.agentContextGeneration = 2;
    content.notebook.agentContextBridges = [
      { generation: 1, cellIds: [historical.id] }
    ];
    content.session.contextState = 'unavailable';
    content.notebook.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';
    internals.refresh();
    internals.runCell(false);

    content.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-contextChoice.is-primary'
      )
      ?.click();

    expect(content.notebook.agentContextGeneration).toBe(3);
    expect(draft.agentContextGeneration).toBeNull();
    expect(content.notebook.agentContextBridges).toEqual([
      { generation: 1, cellIds: [historical.id] }
    ]);

    content.session.error = 'query rejected';
    content.session.running = false;
    internals.onSessionChange();

    expect(draft.agentContextGeneration).toBeNull();
    expect(content.notebook.agentContextBridges).toEqual([
      { generation: 1, cellIds: [historical.id] }
    ]);
    expect(historical.agentContextGeneration).toBe(2);
    expect(draft.status).toBe('interrupted');
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(true);
    content.dispose();
  });

  it('cancels a pending context choice when the draft changes or is deleted', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    historicalWorkspace(content);
    const sendUser = jest.spyOn(content.session, 'sendUser');
    document.body.append(content.node);
    internals.refresh();
    internals.runCell(false);
    const editor = content.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    )[1];

    editor.value = 'changed draft';
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(sendUser).not.toHaveBeenCalled();
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(true);

    internals.runCell(false);
    content.deleteActive();
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(true);
    expect(sendUser).not.toHaveBeenCalled();
    content.dispose();
    content.node.remove();
  });

  it('restores draft focus when the context choice is dismissed with Escape', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    historicalWorkspace(content);
    const sendUser = jest.spyOn(content.session, 'sendUser');
    document.body.append(content.node);
    internals.refresh();
    internals.runCell(false);
    await Promise.resolve();
    expect(document.activeElement).toBe(
      content.node.querySelector('.jp-AgentWorkspace-contextChoice.is-primary')
    );

    content.node.querySelector('.jp-AgentWorkspace-status')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );

    expect(sendUser).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      content.node.querySelectorAll('.jp-AgentWorkspace-cellInput')[1]
    );
    content.dispose();
    content.node.remove();
  });

  it('replaces unavailable context only after explicit bridge recovery', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const { historical, draft } = historicalWorkspace(content);
    const stale = '123e4567-e89b-12d3-a456-426614174000';
    content.notebook.agentSessionId = stale;
    content.notebook.agentContextGeneration = 2;
    content.notebook.agentContextBridges = [{ generation: 2, cellIds: [] }];
    historical.agentContextGeneration = 2;
    content.session.sessionId = stale;
    content.session.contextState = 'unavailable';
    const originalBlocks = historical.blocks;
    const sendUser = jest.spyOn(content.session, 'sendUser');
    internals.refresh();

    internals.runCell(false);
    expect(content.notebook.agentSessionId).toBe(stale);
    expect(sendUser).not.toHaveBeenCalled();
    const recovery = content.node.querySelector(
      '.jp-AgentWorkspace-historyChoiceDescription'
    );
    expect(recovery?.getAttribute('role')).toBe('status');
    expect(recovery?.getAttribute('aria-live')).toBe('polite');
    expect(recovery?.textContent).toContain(
      'The saved Agent context could not be resumed.'
    );
    expect(recovery?.textContent).not.toContain(
      'outside the current Agent context'
    );
    content.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-contextChoice.is-primary'
      )
      ?.click();

    expect(content.notebook.agentSessionId).toBeNull();
    expect(content.notebook.agentContextGeneration).toBe(3);
    expect(content.notebook.agentContextBridges).toEqual([
      { generation: 2, cellIds: [] }
    ]);
    expect(draft.agentContextGeneration).toBeNull();

    acceptActiveAgentRun(content, internals);

    expect(content.notebook.agentContextBridges).toEqual([
      { generation: 2, cellIds: [] },
      { generation: 3, cellIds: [historical.id] }
    ]);
    expect(draft.agentContextGeneration).toBe(3);
    expect(historical.blocks).toBe(originalBlocks);
    expect(draft.source).toBe('结果如何了？');
    expect(sendUser).toHaveBeenCalledTimes(1);
    content.dispose();
  });

  it('keeps keyed navigator entries and selects without entering edit mode', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const first = content.notebook.current;
    first.source = 'first prompt';
    first.status = 'done';
    first.executionCount = 1;
    const second = content.notebook.appendCell();
    second.source = '!second command';
    second.kind = 'command';
    second.status = 'done';
    second.executionCount = 2;
    content.notebook.select(0);
    content.notebook.enterEdit();
    internals.refresh();
    const firstMarker = content.node.querySelector(
      '.jp-AgentWorkspace-navigatorItem[data-cell-id="' + first.id + '"]'
    );

    second.output = 'stream-only change';
    internals.refresh();
    expect(
      content.node.querySelector(
        '.jp-AgentWorkspace-navigatorItem[data-cell-id="' + first.id + '"]'
      )
    ).toBe(firstMarker);

    content.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-navigatorItem[data-cell-id="' + second.id + '"]'
      )
      ?.click();
    expect(content.notebook.current.id).toBe(second.id);
    expect(content.notebook.mode).toBe('command');
    content.dispose();
  });

  it('prepares a failed retry as a new focused draft without executing it', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    document.body.append(content.node);
    const source = content.notebook.current;
    source.source = 'repair the failing step';
    source.status = 'interrupted';
    source.executionCount = 9;
    source.blocks = [
      {
        kind: 'tool',
        id: 'tool-failed',
        name: 'Bash',
        input: { command: 'false' },
        output: 'failed',
        status: 'error'
      }
    ];
    source.turn = setTurnStatus(
      createTurn('run-failed'),
      'interrupted',
      source.blocks
    );
    const originalTurn = source.turn;
    internals.refresh();
    const sendUser = jest.spyOn(content.session, 'sendUser');

    content.node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-retryTurn')
      ?.click();

    expect(content.notebook.cells).toHaveLength(2);
    expect(content.notebook.active).toBe(1);
    expect(content.notebook.mode).toBe('edit');
    expect(content.notebook.current).toMatchObject({
      source: 'repair the failing step',
      status: 'idle',
      executionCount: null,
      blocks: [],
      turn: null
    });
    expect(source.turn).toBe(originalTurn);
    expect(source.status).toBe('interrupted');
    expect(sendUser).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      content.node.querySelectorAll('.jp-AgentWorkspace-cellInput')[1]
    );
    content.dispose();
    content.node.remove();
  });

  it('tracks the viewport Cell without changing notebook selection or edit mode', () => {
    const originalObserver = globalThis.IntersectionObserver;
    const observerState: {
      callback?: IntersectionObserverCallback;
      observer?: IntersectionObserver;
    } = {};
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
      takeRecords = jest.fn(() => []);
      constructor(next: IntersectionObserverCallback) {
        observerState.callback = next;
        observerState.observer = this as unknown as IntersectionObserver;
      }
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: FakeIntersectionObserver
    });

    try {
      const content = new AgentWorkspaceContent(null);
      const internals = content as unknown as PageInternals;
      const first = content.notebook.current;
      first.source = 'first';
      first.status = 'done';
      first.executionCount = 1;
      const second = content.notebook.appendCell();
      second.source = 'second';
      second.status = 'done';
      second.executionCount = 2;
      content.notebook.select(0);
      content.notebook.enterEdit();
      internals.refresh();
      const notebook = content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-notebook'
      );
      const firstNode = content.node.querySelector<HTMLElement>(
        `.jp-AgentWorkspace-cell[data-cell-id="${first.id}"]`
      );
      const secondNode = content.node.querySelector<HTMLElement>(
        `.jp-AgentWorkspace-cell[data-cell-id="${second.id}"]`
      );
      const callback = observerState.callback;
      const observer = observerState.observer;
      if (!notebook || !firstNode || !secondNode || !callback || !observer) {
        throw new Error('viewport test setup failed');
      }
      jest
        .spyOn(notebook, 'getBoundingClientRect')
        .mockReturnValue(rect(0, 400));
      jest
        .spyOn(firstNode, 'getBoundingClientRect')
        .mockReturnValue(rect(0, 180));
      jest
        .spyOn(secondNode, 'getBoundingClientRect')
        .mockReturnValue(rect(180, 220));

      callback(
        [
          { target: firstNode, isIntersecting: true },
          { target: secondNode, isIntersecting: true }
        ] as unknown as IntersectionObserverEntry[],
        observer
      );

      expect(content.notebook.current.id).toBe(first.id);
      expect(content.notebook.mode).toBe('edit');
      expect(
        content.node
          .querySelector(
            `.jp-AgentWorkspace-navigatorItem[data-cell-id="${second.id}"]`
          )
          ?.classList.contains('is-current')
      ).toBe(true);
      content.dispose();
    } finally {
      if (originalObserver) {
        Object.defineProperty(globalThis, 'IntersectionObserver', {
          configurable: true,
          value: originalObserver
        });
      } else {
        Reflect.deleteProperty(globalThis, 'IntersectionObserver');
      }
    }
  });

  it('uses an animation-frame scroll fallback when observers are unavailable', () => {
    const originalObserver = globalThis.IntersectionObserver;
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    const frames: FrameRequestCallback[] = [];
    const frameSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        frames.push(callback);
        return frames.length;
      });
    try {
      const content = new AgentWorkspaceContent(null);
      const internals = content as unknown as PageInternals;
      const first = content.notebook.current;
      first.source = 'first';
      first.status = 'done';
      first.executionCount = 1;
      const second = content.notebook.appendCell();
      second.source = 'second';
      second.status = 'done';
      second.executionCount = 2;
      content.notebook.select(0);
      internals.refresh();
      const notebook = content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-notebook'
      );
      const firstNode = content.node.querySelector<HTMLElement>(
        `.jp-AgentWorkspace-cell[data-cell-id="${first.id}"]`
      );
      const secondNode = content.node.querySelector<HTMLElement>(
        `.jp-AgentWorkspace-cell[data-cell-id="${second.id}"]`
      );
      if (!notebook || !firstNode || !secondNode) {
        throw new Error('scroll fallback setup failed');
      }
      jest
        .spyOn(notebook, 'getBoundingClientRect')
        .mockReturnValue(rect(0, 400));
      jest
        .spyOn(firstNode, 'getBoundingClientRect')
        .mockReturnValue(rect(-300, 320));
      jest
        .spyOn(secondNode, 'getBoundingClientRect')
        .mockReturnValue(rect(20, 380));

      notebook.dispatchEvent(new Event('scroll'));
      frames.shift()?.(0);

      expect(content.notebook.current.id).toBe(first.id);
      expect(
        content.node
          .querySelector(
            `.jp-AgentWorkspace-navigatorItem[data-cell-id="${second.id}"]`
          )
          ?.classList.contains('is-current')
      ).toBe(true);
      content.dispose();
    } finally {
      frameSpy.mockRestore();
      if (originalObserver) {
        Object.defineProperty(globalThis, 'IntersectionObserver', {
          configurable: true,
          value: originalObserver
        });
      }
    }
  });

  it('reveals offscreen navigation targets with motion-preference behavior', () => {
    const scrollIntoView = jest.mocked(HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const originalMatchMedia = window.matchMedia;
    let reduced = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({ matches: reduced }))
    });
    try {
      const content = new AgentWorkspaceContent(null);
      const internals = content as unknown as PageInternals;
      const first = content.notebook.current;
      first.source = 'first';
      first.status = 'done';
      first.executionCount = 1;
      const second = content.notebook.appendCell();
      second.source = 'second';
      second.status = 'done';
      second.executionCount = 2;
      content.notebook.select(0);
      internals.refresh();
      const notebook = content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-notebook'
      );
      const secondNode = content.node.querySelector<HTMLElement>(
        `.jp-AgentWorkspace-cell[data-cell-id="${second.id}"]`
      );
      if (!notebook || !secondNode) throw new Error('reveal setup failed');
      jest
        .spyOn(notebook, 'getBoundingClientRect')
        .mockReturnValue(rect(0, 400));
      jest
        .spyOn(secondNode, 'getBoundingClientRect')
        .mockReturnValue(rect(600, 120));

      content.node
        .querySelector<HTMLButtonElement>(
          `.jp-AgentWorkspace-navigatorItem[data-cell-id="${second.id}"]`
        )
        ?.click();

      expect(content.notebook.current.id).toBe(second.id);
      expect(content.notebook.mode).toBe('command');
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
        inline: 'nearest',
        behavior: 'smooth'
      });

      scrollIntoView.mockClear();
      content.notebook.select(0);
      internals.refresh();
      reduced = true;
      content.node
        .querySelector<HTMLButtonElement>(
          `.jp-AgentWorkspace-navigatorItem[data-cell-id="${second.id}"]`
        )
        ?.click();
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto'
      });
      content.dispose();
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          writable: true,
          value: originalMatchMedia
        });
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });

  it('emits coarse UI state without output-only notifications', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const states: string[] = [];
    const unsubscribe = content.subscribeUiState(state => {
      states.push(`${state.connectionLabel}|${state.executionLabel}`);
    });
    const count = states.length;

    content.notebook.current.output = 'new streamed text';
    internals.refresh();
    expect(states).toHaveLength(count);

    content.session.connected = true;
    content.session.execCwd = '/workspace';
    internals.refresh();
    expect(states[states.length - 1]).toBe('Connected|Ready');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusCwd')?.textContent
    ).toBe('/workspace');
    unsubscribe();
    content.dispose();
  });

  it('follows a near running tail, detaches on user movement, and returns', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const nearTail = jest
      .spyOn(internals.notebookView, 'isOutputTailNearViewport')
      .mockReturnValue(true);
    jest
      .spyOn(internals.notebookView, 'isEditingAnotherCell')
      .mockReturnValue(false);
    const reveal = jest
      .spyOn(internals.notebookView, 'revealOutputTail')
      .mockImplementation(() => {});
    content.notebook.setSource('stream an answer');
    internals.runCell(false);
    const runningId = content.notebook.activeRun?.cellId as string;

    content.session.blocks = [
      { kind: 'text', id: 'partial-1', text: 'partial answer' }
    ];
    internals.onSessionChange();
    await Promise.resolve();
    expect(reveal).toHaveBeenCalledWith(runningId);

    nearTail.mockReturnValue(false);
    const notebook = content.node.querySelector('.jp-AgentWorkspace-notebook');
    notebook?.dispatchEvent(new Event('wheel'));
    notebook?.dispatchEvent(new Event('scroll'));
    const latest = content.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-returnLatest'
    );
    expect(latest?.hidden).toBe(false);
    latest?.click();
    expect(reveal).toHaveBeenLastCalledWith(runningId);
    expect(latest?.hidden).toBe(true);
    content.dispose();
  });

  it('does not steal selection or editor focus when another Cell streams', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    const internals = content as unknown as PageInternals;
    content.notebook.setSource('run in the first cell');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.enterEdit();
    internals.refresh();
    const editor = content.node.querySelectorAll<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    )[1];
    editor.focus();
    editor.value = 'draft in another cell';
    editor.setSelectionRange(5, 5);
    content.session.blocks = [
      { kind: 'text', id: 'partial-2', text: 'new running output' }
    ];

    internals.onSessionChange();

    expect(content.notebook.active).toBe(1);
    expect(content.notebook.mode).toBe('edit');
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(5);
    content.dispose();
    content.node.remove();
  });

  it('publishes running state before any output event arrives', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as PageInternals;
    const states: WorkspaceUiState[] = [];
    const unsubscribe = content.subscribeUiState(state => states.push(state));
    content.notebook.setSource('start immediately');

    internals.runCell(false);

    const current = states[states.length - 1];
    expect(current.activeRun?.cellId).toBe(content.notebook.cells[0].id);
    expect(current.interruptAvailable).toBe(true);
    expect(current.executionLabel).toContain('Running');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-navigatorItem.is-running')
    ).not.toBeNull();
    unsubscribe();
    content.dispose();
  });
});

describe('cell context submission', () => {
  interface CellSubmitInternals {
    refresh(): void;
    runCell(advance: boolean): void;
    onSessionChange(): void;
  }

  beforeEach(() => {
    jest.spyOn(AgentSession.prototype, 'connect').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'close').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'sendUser').mockImplementation(function (
      this: AgentSession,
      text: string
    ): void {
      this.blocks = [{ kind: 'user', id: 'queued-user', text }];
      this.error = null;
      this.running = true;
    });
    jest
      .spyOn(AgentSession.prototype, 'interrupt')
      .mockImplementation(() => {});
    jest
      .spyOn(AgentSession.prototype, 'interruptExec')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
  });

  function cellInputs(content: AgentWorkspaceContent): HTMLTextAreaElement[] {
    return Array.from(
      content.node.querySelectorAll<HTMLTextAreaElement>(
        '.jp-AgentWorkspace-cellInput'
      )
    );
  }

  function cellInput(
    content: AgentWorkspaceContent,
    index = content.notebook.active
  ): HTMLTextAreaElement {
    const input = cellInputs(content)[index];
    expect(input).toBeDefined();
    return input!;
  }

  function typeIntoCell(
    content: AgentWorkspaceContent,
    source: string,
    index = content.notebook.active
  ): HTMLTextAreaElement {
    const input = cellInput(content, index);
    input.value = source;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input;
  }

  function submitCell(
    content: AgentWorkspaceContent,
    source: string,
    options: { advance?: boolean; index?: number; select?: boolean } = {}
  ): void {
    if (options.select) {
      content.notebook.select(options.index ?? content.notebook.active);
      (content as unknown as CellSubmitInternals).refresh();
    }
    const input = typeIntoCell(content, source, options.index);
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: options.advance === true,
        ctrlKey: options.advance !== true,
        bubbles: true,
        cancelable: true
      })
    );
  }

  function seedDoneAiCell(content: AgentWorkspaceContent): WorkspaceCell {
    const cell = content.notebook.current;
    cell.source = 'previous ai';
    cell.kind = 'ai';
    cell.status = 'done';
    cell.executionCount = 1;
    return cell;
  }

  function appendInputCell(content: AgentWorkspaceContent): WorkspaceCell {
    const cell = content.notebook.appendCell();
    (content as unknown as CellSubmitInternals).refresh();
    return cell;
  }

  function contextButtons(content: AgentWorkspaceContent): {
    bridge: HTMLButtonElement | null;
    empty: HTMLButtonElement | null;
  } {
    return {
      bridge: content.node.querySelector(
        '.jp-AgentWorkspace-contextChoice.is-primary'
      ),
      empty: content.node.querySelector(
        '.jp-AgentWorkspace-contextChoice.is-secondary'
      )
    };
  }

  function dismissContextChoice(content: AgentWorkspaceContent): void {
    content.node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );
  }

  it('runs an AI cell submit and queues a ! shell submit', () => {
    const exec = jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'ok\n', returncode: 0, cwd: '/tmp' });
    const sendUser = jest.mocked(AgentSession.prototype.sendUser);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as CellSubmitInternals;
    document.body.append(content.node);

    submitCell(content, 'explain this notebook');
    expect(content.notebook.cells[0].kind).toBe('ai');
    expect(content.notebook.cells[0].status).toBe('running');
    expect(sendUser).toHaveBeenCalledWith(
      'explain this notebook',
      expect.stringMatching(/^run-/)
    );
    expect(content.notebook.cells[1]).toMatchObject({
      kind: 'ai',
      source: '',
      status: 'idle'
    });

    submitCell(content, '!ls -la', { index: 1, select: true });
    const shell = content.notebook.cells.find(
      cell => cell.source === '!ls -la'
    );
    expect(shell?.kind).toBe('command');
    expect(shell?.status).toBe('queued');
    expect(exec).not.toHaveBeenCalled();

    content.session.running = false;
    content.session.connected = true;
    content.session.error = null;
    internals.onSessionChange();

    expect(content.notebook.cells[0].status).toBe('done');
    expect(exec).toHaveBeenCalledWith('ls -la');
    expect(content.notebook.activeRun).toMatchObject({
      kind: 'command',
      source: '!ls -la',
      executionSource: 'ls -la'
    });

    content.dispose();
  });

  it('refuses a second cell submit while a context choice is pending', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    seedDoneAiCell(content);
    appendInputCell(content);
    content.session.contextState = 'unavailable';

    submitCell(content, 'continue the analysis');
    const pendingId = content.notebook.cells.find(
      cell => cell.source === 'continue the analysis'
    )?.id;
    expect(contextButtons(content).bridge).not.toBeNull();
    expect(content.notebook.cells).toHaveLength(2);

    cellInput(content).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    );

    expect(
      content.notebook.cells.filter(
        cell => cell.source === 'continue the analysis'
      )
    ).toHaveLength(1);
    expect(content.notebook.cells).toHaveLength(2);
    expect(
      content.notebook.cells.find(cell => cell.id === pendingId)?.status
    ).toBe('idle');
    expect(content.node.textContent).toContain(
      'Resolve the pending context choice before submitting again.'
    );

    content.dispose();
  });

  it('reopens and focuses the context choice when a second submit is refused', async () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    seedDoneAiCell(content);
    appendInputCell(content);
    content.session.contextState = 'unavailable';

    submitCell(content, 'continue the analysis');
    // Simulate the user not noticing the panel: hide it without cancelling the
    // pending choice, then submit again.
    (
      content as unknown as { status: { closeHistoryChoice(): void } }
    ).status.closeHistoryChoice();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-historyChoice')
    ).toBeNull();

    cellInput(content).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    await Promise.resolve();

    expect(contextButtons(content).bridge).not.toBeNull();
    expect(
      content.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-contextPopover'
      )?.hidden
    ).toBe(false);
    expect(document.activeElement).toBe(contextButtons(content).bridge);
    expect(content.node.textContent).toContain(
      'The saved Agent context is unavailable. Resolve the pending context choice before submitting again.'
    );

    content.dispose();
  });

  it('runs the pending cell once after the context choice is confirmed', () => {
    const sendUser = jest.mocked(AgentSession.prototype.sendUser);
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    seedDoneAiCell(content);
    const input = appendInputCell(content);
    content.session.contextState = 'unavailable';

    submitCell(content, 'original question');
    expect(content.notebook.cells).toHaveLength(2);
    contextButtons(content).bridge?.click();

    expect(content.notebook.cells).toHaveLength(2);
    expect(
      content.notebook.cells.some(cell => cell.source === 'original question')
    ).toBe(true);
    expect(sendUser).toHaveBeenCalledWith(
      'original question',
      expect.stringMatching(/^run-/),
      expect.anything()
    );
    expect(
      content.notebook.cells.find(cell => cell.id === input.id)?.status
    ).toBe('running');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-contextChoice')
        ?.textContent
    ).toContain('Continuing…');

    content.dispose();
  });

  it('keeps the pending cell when the choice is cancelled', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    seedDoneAiCell(content);
    appendInputCell(content);
    const before = content.notebook.cells.map(cell => cell.id);
    content.session.contextState = 'unavailable';

    submitCell(content, 'will be cancelled');
    expect(content.notebook.cells.map(cell => cell.id)).toEqual(before);
    dismissContextChoice(content);

    expect(content.notebook.cells.map(cell => cell.id)).toEqual(before);
    expect(content.notebook.current.source).toBe('will be cancelled');
    expect(cellInput(content).value).toBe('will be cancelled');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-contextChoice')
    ).toBeNull();

    content.dispose();
  });

  it('does not leave an idle cell when an AI submit is refused as unavailable', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    content.session.contextState = 'unavailable';
    const before = content.notebook.cells.map(cell => cell.id);

    submitCell(content, 'cannot run yet');

    expect(content.notebook.cells.map(cell => cell.id)).toEqual(before);
    expect(content.notebook.cells[0].source).toBe('cannot run yet');
    expect(
      content.notebook.cells.some(
        cell => cell.status === 'queued' || cell.status === 'running'
      )
    ).toBe(false);
    expect(cellInput(content).value).toBe('cannot run yet');
    expect(content.node.textContent).toContain(
      'Start a new context before continuing with an AI request.'
    );

    content.dispose();
  });

  it('deletes only the pending cell, preserving history', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    const historical = seedDoneAiCell(content);
    historical.blocks = [
      { kind: 'text', id: 'history-outcome', text: '历史结果保留' }
    ];
    appendInputCell(content);
    const historyIds = [historical.id];
    content.session.contextState = 'unavailable';

    submitCell(content, 'pending question');
    const pending = content.notebook.cells.find(
      cell => cell.source === 'pending question'
    );
    expect(pending).toBeDefined();
    expect(content.notebook.current.id).toBe(pending!.id);
    expect(content.notebook.cells).toHaveLength(historyIds.length + 1);

    content.deleteActive();

    expect(content.notebook.cells.map(cell => cell.id)).toEqual(historyIds);
    expect(historical.source).toBe('previous ai');
    expect(historical.blocks).toEqual([
      { kind: 'text', id: 'history-outcome', text: '历史结果保留' }
    ]);
    expect(
      content.notebook.cells.some(cell => cell.source === 'pending question')
    ).toBe(false);
    expect(content.node.textContent).not.toContain(
      'Cannot delete a running cell.'
    );

    content.dispose();
  });

  it('keeps the edited text when the pending cell source changes', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    seedDoneAiCell(content);
    const input = appendInputCell(content);
    content.session.contextState = 'unavailable';

    submitCell(content, 'pending question');
    expect(contextButtons(content).bridge).not.toBeNull();

    typeIntoCell(content, 'edited while pending');

    expect(
      content.notebook.cells.find(cell => cell.id === input.id)?.source
    ).toBe('edited while pending');
    expect(
      content.notebook.cells.find(cell => cell.id === input.id)?.status
    ).toBe('idle');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-contextChoice')
    ).toBeNull();

    content.dispose();
  });

  it('ignores submit keys while an IME composition is active', async () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    const input = typeIntoCell(content, '拼写中');

    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    expect(content.notebook.cells[0].status).toBe('idle');
    expect(content.notebook.cells).toHaveLength(1);

    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    expect(content.notebook.cells[0].status).toBe('idle');

    await new Promise(resolve => setTimeout(resolve, 0));
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    expect(content.notebook.cells[0].status).toBe('running');

    content.dispose();
  });

  it('keeps unavailable-context prompts while compaction stays not observable', () => {
    jest
      .spyOn(AgentSession.prototype, 'configurationReport', 'get')
      .mockReturnValue({
        runtimeLifetime: 'runtime-1',
        generation: 1,
        state: 'active',
        active: null,
        desired: null,
        differences: {},
        compaction: 'not-observable',
        preflightApplied: false
      });
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    seedDoneAiCell(content);
    appendInputCell(content);
    content.session.contextState = 'unavailable';
    (content as unknown as CellSubmitInternals).refresh();

    submitCell(content, 'continue the analysis');

    const choice = content.node.querySelector(
      '.jp-AgentWorkspace-historyChoiceDescription'
    );
    expect(choice?.textContent).toContain(
      'The saved Agent context could not be resumed.'
    );
    expect(choice?.textContent).not.toContain('Compaction');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-configurationContent')
        ?.textContent
    ).toContain('Compaction: not observable');
    // The pending choice is still an unavailable context, not a reset one.
    expect(content.session.contextState).toBe('unavailable');
    const context = content.node.querySelector(
      '.jp-AgentWorkspace-contextDescription'
    );
    expect(context?.textContent).toContain(
      'its Agent context is unavailable on this server'
    );
    expect(context?.textContent).not.toContain(
      'The previous context link was cleared'
    );
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusContext')
        ?.textContent
    ).toContain('Context: Unavailable');

    // Without visible AI history the same state keeps its explicit
    // start-a-new-context hint instead of compaction or reset copy.
    const fresh = new AgentWorkspaceContent(null);
    document.body.append(fresh.node);
    fresh.session.contextState = 'unavailable';
    (fresh as unknown as CellSubmitInternals).refresh();
    submitCell(fresh, 'needs a context');

    expect(
      fresh.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toContain('Start a new context before continuing with an AI request.');
    expect(fresh.session.contextState).toBe('unavailable');
    expect(
      fresh.node.querySelector('.jp-AgentWorkspace-configurationContent')
        ?.textContent
    ).toContain('Compaction: not observable');
    expect(
      fresh.node.querySelector('.jp-AgentWorkspace-contextDescription')
        ?.textContent
    ).not.toContain('The previous context link was cleared');

    content.dispose();
    fresh.dispose();
  });
});

class FakeDshSocket {
  static readonly instances: FakeDshSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeDshSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeDshSocket.OPEN;
    this.onopen?.();
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('DSH records without inspection UI', () => {
  const sessionId = 'session-1';
  const runtimeId = 'runtime-1';

  let makeSettingsSpy: jest.SpyInstance;

  beforeEach(() => {
    FakeDshSocket.instances.length = 0;
    makeSettingsSpy = jest
      .spyOn(ServerConnection, 'makeSettings')
      .mockReturnValue({
        wsUrl: 'ws://example',
        WebSocket: FakeDshSocket,
        appendToken: false,
        token: ''
      } as never);
  });

  afterEach(() => {
    makeSettingsSpy.mockRestore();
    document.body.replaceChildren();
  });

  function emit(socket: FakeDshSocket, event: Record<string, unknown>): void {
    socket.onmessage?.({ data: JSON.stringify(event) });
  }

  function connect(content: AgentWorkspaceContent): FakeDshSocket {
    content.start();
    const socket = FakeDshSocket.instances[0];
    socket.open();
    return socket;
  }

  function handshake(socket: FakeDshSocket): void {
    emit(socket, {
      type: 'dsh/v1/connection',
      runtimeId,
      phase: 'connected'
    });
    emit(socket, {
      type: 'dsh/v1/session',
      sessionId,
      runtimeId,
      phase: 'attached'
    });
  }

  function artifact(): Record<string, unknown> {
    return {
      type: 'dsh/v1/artifact',
      sessionId,
      runtimeId,
      runId: 'run-1',
      artifactId: 'artifact-1',
      phase: 'created',
      name: 'notes.md',
      uri: 'notes/a.md',
      mediaType: 'text/markdown',
      source: 'presented'
    };
  }

  function activity(): Record<string, unknown> {
    return {
      type: 'dsh/v1/activity',
      sessionId,
      runtimeId,
      runId: 'run-1',
      activityId: 'activity-1',
      phase: 'started',
      toolName: 'bash',
      label: 'List files'
    };
  }

  function question(): Record<string, unknown> {
    return {
      type: 'dsh/v1/interaction.requested',
      sessionId,
      runtimeId,
      runId: 'run-1',
      requestId: 'req-1',
      kind: 'question',
      prompt: 'Which file?',
      options: [{ id: 'a', label: 'a.md' }]
    };
  }

  it('surfaces no DSH inspection UI or hidden record cache', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    const socket = connect(content);

    handshake(socket);
    emit(socket, artifact());
    emit(socket, activity());
    emit(socket, question());

    for (const selector of [
      '.jp-AgentWorkspace-inspection',
      '.jp-AgentWorkspace-inspectionReopen',
      '.jp-Dsh-activityList',
      '.jp-Dsh-activityFallback',
      '.jp-Dsh-artifactHost',
      '.jp-Dsh-artifactFallback',
      '.jp-Dsh-interactionList',
      '.jp-Dsh-interactionFallback',
      '.jp-Dsh-interactionDeliveryNote'
    ]) {
      expect(content.node.querySelector(selector)).toBeNull();
    }
    // Removing inspection must not leave a detached record cache behind.
    expect('activityElements' in content).toBe(false);
    expect('artifactView' in content).toBe(false);
    expect('interactionCoordinator' in content).toBe(false);

    content.dispose();
  });

  it('keeps Cell output activity visible while DSH records are not re-rendered', () => {
    const content = new AgentWorkspaceContent(null);
    const blocks = [
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls' },
        output: 'a.ts\n',
        status: 'done' as const
      }
    ];
    const cell = content.notebook.current;
    cell.kind = 'ai';
    cell.status = 'done';
    cell.source = 'list files';
    cell.blocks = blocks;
    cell.turn = toggleTrace(setTurnStatus(createTurn('run-1'), 'done', blocks));
    document.body.append(content.node);
    (content as unknown as { refresh(): void }).refresh();

    const socket = connect(content);
    handshake(socket);
    emit(socket, activity());

    const activityNodes = content.node.querySelectorAll(
      '[data-turn-activity-id]'
    );
    expect(activityNodes).toHaveLength(1);
    expect(
      content.node.querySelector('[data-turn-activity-id="activity-tool-1"]')
    ).not.toBeNull();
    expect(content.node.querySelector('.jp-Dsh-activityList')).toBeNull();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-inspection')
    ).toBeNull();

    content.dispose();
  });

  it('keeps the adopted DSH session persisted after removing inspection UI', () => {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    const socket = connect(content);

    handshake(socket);

    expect(content.session.dshSessionId).toBe(sessionId);
    expect(getResumableDshSessionReference(content.notebook)).toEqual({
      engine: 'dsh',
      sessionId
    });

    content.dispose();
  });
});

describe('DSH session binding persistence', () => {
  interface BindingInternals {
    startNewContext(): void;
    saveCoordinator: { flush(): Promise<void> };
    pendingContextSubmission: {
      cellId: string;
      source: string;
      advance: boolean;
    } | null;
    resolveContextChoice(mode: 'bridge' | 'empty'): void;
  }

  function makeContext(initialText: string) {
    let text = initialText;
    const fromString = jest.fn<void, [string]>(value => {
      text = value;
    });
    const save = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    let contentChanged: { slot: () => void; thisArg: unknown } | null = null;
    const context = {
      path: 'dsh-session.agentnb',
      ready: Promise.resolve(),
      isReady: true,
      model: {
        toString: () => text,
        fromString,
        contentChanged: {
          connect: jest.fn((slot: () => void, thisArg: unknown) => {
            contentChanged = { slot, thisArg };
          })
        }
      },
      save
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    return {
      context,
      fromString,
      save,
      text: () => text,
      setText: (value: string) => {
        text = value;
      },
      change: () => contentChanged?.slot.call(contentChanged.thisArg)
    };
  }

  function emitEvent(
    socket: FakeDshSocket,
    event: Record<string, unknown>
  ): void {
    socket.onmessage?.({ data: JSON.stringify(event) });
  }

  function attach(harness: {
    context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
  }) {
    const content = new AgentWorkspaceContent(null);
    document.body.append(content.node);
    content.attachContext(harness.context);
    return content;
  }

  let makeSettingsSpy: jest.SpyInstance;

  beforeEach(() => {
    FakeDshSocket.instances.length = 0;
    makeSettingsSpy = jest
      .spyOn(ServerConnection, 'makeSettings')
      .mockReturnValue({
        wsUrl: 'ws://example',
        WebSocket: FakeDshSocket,
        appendToken: false,
        token: ''
      } as never);
  });

  afterEach(() => {
    makeSettingsSpy.mockRestore();
    document.body.replaceChildren();
  });

  it('persists the adopted DSH session and resumes it on reopen', async () => {
    const initial = new WorkspaceNotebook();
    initial.current.source = 'question';
    const first = makeContext(serializeNotebook(initial));
    const content = attach(first);
    await Promise.resolve();

    const socket = FakeDshSocket.instances[0];
    socket.open();
    emitEvent(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-1',
      phase: 'connected'
    });
    emitEvent(socket, {
      type: 'dsh/v1/session',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      phase: 'attached'
    });
    await (content as unknown as BindingInternals).saveCoordinator.flush();

    expect(JSON.parse(first.text()).sessionReference).toEqual({
      engine: 'dsh',
      sessionId: 'session-1'
    });
    expect(getResumableDshSessionReference(content.notebook)).toEqual({
      engine: 'dsh',
      sessionId: 'session-1'
    });
    content.dispose();

    const reopened = makeContext(first.text());
    const resumed = attach(reopened);
    await Promise.resolve();

    expect(resumed.session.dshSessionId).toBe('session-1');
    expect(
      FakeDshSocket.instances[FakeDshSocket.instances.length - 1].url
    ).toContain('dshSessionId=session-1');
    resumed.dispose();
  });

  it('clears the saved DSH binding when a new context starts', async () => {
    const initial = new WorkspaceNotebook();
    initial.current.source = 'question';
    const harness = makeContext(serializeNotebook(initial));
    const content = attach(harness);
    await Promise.resolve();

    const socket = FakeDshSocket.instances[0];
    socket.open();
    emitEvent(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-1',
      phase: 'connected'
    });
    emitEvent(socket, {
      type: 'dsh/v1/session',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      phase: 'attached'
    });
    await (content as unknown as BindingInternals).saveCoordinator.flush();
    expect(JSON.parse(harness.text()).sessionReference).not.toBeNull();

    const internals = content as unknown as BindingInternals;
    internals.startNewContext();
    await internals.saveCoordinator.flush();

    expect(JSON.parse(harness.text()).sessionReference).toBeNull();
    expect(getResumableDshSessionReference(content.notebook)).toBeNull();
    expect(content.session.dshSessionId).toBeNull();

    // The reconnect URL must not advertise the cleared session either.
    content.session.connect();
    expect(
      FakeDshSocket.instances[FakeDshSocket.instances.length - 1].url
    ).not.toContain('dshSessionId=');

    content.dispose();
  });

  it('clears the DSH binding when starting an empty context', async () => {
    const initial = new WorkspaceNotebook();
    initial.current.source = 'first question';
    setAgentSessionReference(initial, {
      engine: 'dsh',
      sessionId: 'session-1'
    });
    const harness = makeContext(serializeNotebook(initial));
    const content = attach(harness);
    await Promise.resolve();

    const socket = FakeDshSocket.instances[0];
    socket.open();
    emitEvent(socket, {
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-1',
      phase: 'connected'
    });
    emitEvent(socket, {
      type: 'dsh/v1/session',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      phase: 'attached'
    });

    const internals = content as unknown as BindingInternals;
    const cell = content.notebook.appendCell();
    content.notebook.setSource('second question');
    internals.pendingContextSubmission = {
      cellId: cell.id,
      source: 'second question',
      advance: true
    };
    internals.resolveContextChoice('empty');

    expect(content.session.dshSessionId).toBeNull();
    expect(getResumableDshSessionReference(content.notebook)).toBeNull();

    content.session.connect();
    expect(
      FakeDshSocket.instances[FakeDshSocket.instances.length - 1].url
    ).not.toContain('dshSessionId=');

    content.dispose();
  });

  it('refuses a recovered DSH session that differs from the live binding', async () => {
    const initial = new WorkspaceNotebook();
    initial.current.source = 'live question';
    setAgentSessionReference(initial, {
      engine: 'dsh',
      sessionId: 'session-a'
    });
    const harness = makeContext(serializeNotebook(initial));
    const content = attach(harness);
    await Promise.resolve();

    const socket = FakeDshSocket.instances[0];
    socket.open();
    expect(content.session.dshSessionId).toBe('session-a');
    expect(content.documentLoadError).toBeNull();

    harness.setText(
      JSON.stringify({
        version: AGENT_WORKSPACE_VERSION + 1,
        active: 0,
        cells: []
      })
    );
    harness.change();
    expect(content.documentLoadError?.kind).toBe('unsupported-version');

    const recovered = new WorkspaceNotebook();
    recovered.current.source = 'recovered question';
    setAgentSessionReference(recovered, {
      engine: 'dsh',
      sessionId: 'session-b'
    });
    const recoveredText = serializeNotebook(recovered);
    harness.setText(recoveredText);
    harness.change();

    expect(content.documentLoadError).toMatchObject({
      kind: 'session-mismatch'
    });
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();

    // The stale connection's first handshake for session A must not be adopted
    // over the recovered document's session B, nor persisted.
    emitEvent(socket, {
      type: 'dsh/v1/session',
      sessionId: 'session-a',
      runtimeId: 'runtime-1',
      phase: 'attached'
    });
    expect(getResumableDshSessionReference(content.notebook)?.sessionId).toBe(
      'session-b'
    );
    expect(harness.text()).toBe(recoveredText);
    expect(harness.save).not.toHaveBeenCalled();

    content.dispose();
  });
});

describe('AgentWorkspaceContent future document protection', () => {
  interface ProtectionInternals {
    runCell(advance: boolean): void;
    persistSoon(): void;
    persistNow(): void;
    synchronizeDocumentModel(): void;
    startNewContext(): void;
    onSessionChange(): void;
    selectCell(index: number, options?: { focusEditor?: boolean }): void;
    applyingModel: boolean;
    saveCoordinator: { flush(): Promise<void> };
  }

  interface ContextHarness {
    context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    fromString: jest.Mock<void, [string]>;
    save: jest.Mock<Promise<void>, []>;
    text(): string;
    setText(value: string): void;
    change(): void;
  }

  function futureText(): string {
    return JSON.stringify({
      version: AGENT_WORKSPACE_VERSION + 1,
      active: 0,
      futureRootField: { nested: true },
      cells: [
        {
          id: 'future-cell',
          kind: 'ai',
          source: 'future question',
          output: '',
          blocks: [],
          status: 'done',
          executionCount: 1,
          futureCellField: [1, 2, 3]
        }
      ]
    });
  }

  function makeContext(
    initialText: string,
    ready: Promise<void> = Promise.resolve()
  ): ContextHarness {
    let text = initialText;
    const fromString = jest.fn<void, [string]>(value => {
      text = value;
    });
    const save = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    let contentChanged: { slot: () => void; thisArg: unknown } | null = null;
    const context = {
      path: 'future.agentnb',
      ready,
      isReady: true,
      model: {
        toString: () => text,
        fromString,
        contentChanged: {
          connect: jest.fn((slot: () => void, thisArg: unknown) => {
            contentChanged = { slot, thisArg };
          })
        }
      },
      save
    } as unknown as DocumentRegistry.IContext<DocumentRegistry.ICodeModel>;
    return {
      context,
      fromString,
      save,
      text: () => text,
      setText: value => {
        text = value;
      },
      change: () => contentChanged?.slot.call(contentChanged.thisArg)
    };
  }

  beforeEach(() => {
    jest.spyOn(AgentSession.prototype, 'connect').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'close').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'sendUser').mockImplementation(() => {});
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: '', returncode: 0, cwd: '/tmp' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('protects a newer document without a session, save, or mutation', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    const future = futureText();
    const harness = makeContext(future);

    content.attachContext(harness.context);
    await Promise.resolve();

    expect(content.documentLoadError).toMatchObject({
      kind: 'unsupported-version',
      foundVersion: AGENT_WORKSPACE_VERSION + 1,
      supportedVersion: AGENT_WORKSPACE_VERSION
    });
    expect(internals.applyingModel).toBe(false);
    expect(AgentSession.prototype.connect).not.toHaveBeenCalled();
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.text()).toBe(future);
    expect(
      content.notebook.cells.some(cell => cell.source === 'future question')
    ).toBe(false);
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toContain('newer format');

    // Even an explicit persist/flush/synchronize must refuse to write memory.
    internals.persistNow();
    await internals.saveCoordinator.flush();
    expect(() => internals.synchronizeDocumentModel()).toThrow(/protected/i);
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.text()).toBe(future);

    content.dispose();
  });

  it('refuses runs while keeping the cell source', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    const harness = makeContext(futureText());

    content.attachContext(harness.context);
    await Promise.resolve();

    content.notebook.appendCell();
    content.notebook.setSource('run this');

    internals.runCell(true);

    expect(
      content.notebook.cells.some(
        cell => cell.status === 'queued' || cell.status === 'running'
      )
    ).toBe(false);
    expect(AgentSession.prototype.sendUser).not.toHaveBeenCalled();
    expect(AgentSession.prototype.exec).not.toHaveBeenCalled();
    expect(content.notebook.current.source).toBe('run this');

    content.dispose();
  });

  it('never overwrites a newer document when local edits are pending', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    const harness = makeContext(serializeNotebook(content.notebook));

    content.attachContext(harness.context);
    await Promise.resolve();

    content.notebook.setSource('pending local edit');
    internals.persistSoon();

    const future = futureText();
    harness.setText(future);
    harness.change();

    expect(content.documentLoadError?.kind).toBe('unsupported-version');
    await expect(internals.saveCoordinator.flush()).rejects.toThrow();
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.text()).toBe(future);

    content.dispose();
  });

  it('refuses to start a new context while protected', async () => {
    const connect = jest.mocked(AgentSession.prototype.connect);
    connect.mockClear();
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    const harness = makeContext(futureText());

    content.attachContext(harness.context);
    await Promise.resolve();
    expect(content.documentLoadError).not.toBeNull();

    internals.startNewContext();

    expect(connect).not.toHaveBeenCalled();
    expect(content.documentLoadError).not.toBeNull();
    expect(content.notebook.agentSessionId).toBeNull();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toContain('newer format');

    content.dispose();
  });

  it('rejects focused cell edits while protected and restores the kept text', async () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    const harness = makeContext(futureText());
    content.notebook.select(0);
    content.notebook.setSource('kept source');
    document.body.append(content.node);

    content.attachContext(harness.context);
    await Promise.resolve();
    expect(content.documentLoadError).not.toBeNull();

    internals.selectCell(0, { focusEditor: true });
    const textarea = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    expect(textarea).not.toBeNull();
    if (!textarea) return;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.readOnly).toBe(true);
    textarea.value = 'typed while protected';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(content.notebook.current.source).toBe('kept source');
    const after = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    expect(after?.value).toBe('kept source');
    expect(after?.readOnly).toBe(true);
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.text()).toBe(futureText());

    // A supported replacement clears the protection and makes the editor
    // writable again, so the read-only guard is confined to the protected state.
    const supported = new WorkspaceNotebook();
    supported.current.source = 'recovered question';
    supported.agentSessionId = '123e4567-e89b-12d3-a456-426614174003';
    harness.setText(serializeNotebook(supported));
    harness.change();
    await Promise.resolve();

    expect(content.documentLoadError).toBeNull();
    const editable = content.node.querySelector<HTMLTextAreaElement>(
      '.jp-AgentWorkspace-cellInput'
    );
    expect(editable?.value).toBe('recovered question');
    expect(editable?.readOnly).toBe(false);

    content.node.remove();
    content.dispose();
  });

  it('keeps an unknown load error visible without connecting or saving', async () => {
    const connect = jest.mocked(AgentSession.prototype.connect);
    connect.mockClear();
    const content = new AgentWorkspaceContent(null);
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    const original = futureText();
    const harness = makeContext(original, ready);

    content.attachContext(harness.context);
    rejectReady(new Error('disk read failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(content.documentLoadError).toMatchObject({ kind: 'unknown' });
    expect(content.documentLoadError?.message).toContain('disk read failed');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toContain('disk read failed');
    expect(connect).not.toHaveBeenCalled();
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.text()).toBe(original);

    content.dispose();
  });

  it('refuses a different recovered session on a live connection', async () => {
    const connect = jest.mocked(AgentSession.prototype.connect);
    connect.mockClear();
    const oldId = '123e4567-e89b-12d3-a456-426614174001';
    const newId = '123e4567-e89b-12d3-a456-426614174002';
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    content.notebook.appendCell();
    content.notebook.setSource('open question');
    content.notebook.agentSessionId = oldId;
    const harness = makeContext(serializeNotebook(content.notebook));

    content.attachContext(harness.context);
    await Promise.resolve();
    expect(content.documentLoadError).toBeNull();
    expect(content.session.sessionId).toBe(oldId);
    expect(connect).toHaveBeenCalledTimes(1);

    harness.setText(futureText());
    harness.change();
    expect(content.documentLoadError?.kind).toBe('unsupported-version');

    const recovered = new WorkspaceNotebook();
    recovered.current.source = 'recovered question';
    recovered.agentSessionId = newId;
    const recoveredText = serializeNotebook(recovered);
    harness.setText(recoveredText);
    harness.change();

    expect(content.documentLoadError).toMatchObject({
      kind: 'session-mismatch'
    });
    expect(content.documentLoadError?.message).toContain('Reopen');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(harness.fromString).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();

    // The old live connection reporting its id must not cross into the new
    // recovered document, neither in memory nor on disk.
    content.session.contextState = 'live';
    internals.onSessionChange();
    expect(content.notebook.agentSessionId).toBe(newId);
    expect(harness.text()).toBe(recoveredText);

    content.dispose();
  });

  it('recovers from an external supported document and starts once', async () => {
    const connect = jest.mocked(AgentSession.prototype.connect);
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ProtectionInternals;
    const harness = makeContext(futureText());

    content.attachContext(harness.context);
    await Promise.resolve();
    expect(content.documentLoadError).not.toBeNull();
    expect(connect).not.toHaveBeenCalled();

    const supported = new WorkspaceNotebook();
    supported.current.source = 'recovered question';
    supported.agentSessionId = '123e4567-e89b-12d3-a456-426614174000';
    harness.setText(serializeNotebook(supported));
    harness.change();
    await Promise.resolve();

    expect(content.documentLoadError).toBeNull();
    expect(internals.applyingModel).toBe(false);
    expect(content.notebook.current.source).toBe('recovered question');
    expect(content.session.sessionId).toBe(
      '123e4567-e89b-12d3-a456-426614174000'
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(harness.fromString).not.toHaveBeenCalled();

    const later = new WorkspaceNotebook();
    later.current.source = 'later external state';
    harness.setText(serializeNotebook(later));
    harness.change();
    await Promise.resolve();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(content.documentLoadError).toBeNull();
    content.dispose();
  });
});

describe('AgentWorkspaceContent execution record toggle', () => {
  interface ToggleInternals {
    refresh(): void;
    notebookView: { node: HTMLElement };
  }

  function rect(top: number): DOMRect {
    return {
      top,
      bottom: top,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: top,
      toJSON: () => ({})
    } as DOMRect;
  }

  it('anchors the clicked execution record toggle in the notebook viewport', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ToggleInternals;
    const blocks = [
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls' },
        output: 'a.ts\n',
        status: 'done' as const
      }
    ];
    const cell = content.notebook.current;
    cell.kind = 'ai';
    cell.status = 'done';
    cell.source = 'list files';
    cell.blocks = blocks;
    cell.turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    document.body.append(content.node);
    internals.refresh();

    const scrollNode = internals.notebookView.node;
    let scrollTop = 240;
    Object.defineProperty(scrollNode, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => {
        scrollTop = value;
      }
    });

    const rectSpy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const expanded = this.getAttribute('aria-expanded') === 'true';
        return rect(
          this.dataset.turnFocusKey === 'trace:run-1'
            ? expanded
              ? 40
              : 100
            : 0
        );
      });

    const before = content.node.querySelector<HTMLButtonElement>(
      '[data-turn-focus-key="trace:run-1"]'
    );
    expect(before?.getAttribute('aria-expanded')).toBe('false');

    before?.click();

    const after = content.node.querySelector<HTMLButtonElement>(
      '[data-turn-focus-key="trace:run-1"]'
    );
    expect(after?.getAttribute('aria-expanded')).toBe('true');
    expect(scrollTop).toBe(180);
    expect(cell.turn?.presentation.trace).toBe('expanded');
    expect(document.activeElement).not.toBe(
      content.node.querySelector('.jp-AgentWorkspace-cellInput')
    );

    rectSpy.mockRestore();
    content.node.remove();
    content.dispose();
  });

  it('mirrors a user toggle into the session turn for the active run', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as ToggleInternals;
    const blocks = [
      {
        kind: 'tool' as const,
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls' },
        output: 'a.ts\n',
        status: 'done' as const
      }
    ];
    const cell = content.notebook.current;
    cell.kind = 'ai';
    cell.status = 'done';
    cell.source = 'list files';
    cell.blocks = blocks;
    cell.turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    content.session.turn = setTurnStatus(createTurn('run-1'), 'done', blocks);
    document.body.append(content.node);
    internals.refresh();

    const before = content.node.querySelector<HTMLButtonElement>(
      '[data-turn-focus-key="trace:run-1"]'
    );
    before?.click();

    expect(cell.turn?.presentation.trace).toBe('expanded');
    expect(content.session.turn?.presentation.trace).toBe('expanded');

    content.node.remove();
    content.dispose();
  });
});

describe('effective configuration report', () => {
  function readyState(): WorkspaceUiState {
    return workspaceUiState({
      connected: true,
      error: null,
      cwd: '/tmp',
      selectedCellId: null,
      activeRun: null,
      queueCount: 0,
      contextState: 'live'
    });
  }

  function handlers(
    onRefreshConfiguration = jest.fn()
  ): ConstructorParameters<typeof StatusBar>[0] {
    return {
      onStartNewContext: jest.fn(),
      onContinueFromHistory: jest.fn(),
      onStartEmptyContext: jest.fn(),
      onDismissContextChoice: jest.fn(),
      onRevealFailure: jest.fn(),
      onRevealInterrupted: jest.fn(),
      onOpenHistory: jest.fn(),
      onRefreshConfiguration,
      onRetrySave: jest.fn()
    };
  }

  function report(
    overrides: Partial<ConfigurationReport> = {}
  ): ConfigurationReport {
    return {
      runtimeLifetime: 'runtime-1',
      generation: 3,
      state: 'active',
      active: null,
      desired: null,
      differences: {},
      compaction: 'not-observable',
      preflightApplied: false,
      ...overrides
    };
  }

  function configurationText(status: StatusBar): string {
    return (
      status.node.querySelector('.jp-AgentWorkspace-configurationContent')
        ?.textContent ?? ''
    );
  }

  function configurationErrorText(status: StatusBar): string {
    return (
      status.node.querySelector('.jp-AgentWorkspace-configurationError')
        ?.textContent ?? ''
    );
  }

  function executionText(status: StatusBar): string {
    return (
      status.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent ?? ''
    );
  }

  const configurationErrorCopy =
    'AI Terminal configuration could not be refreshed; the current turn keeps running.';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders active/desired values with user, default, and derived provenance', () => {
    const status = new StatusBar(handlers());
    status.sync(
      readyState(),
      workspaceOverview([]),
      report({
        active: {
          contextWindow: 200000,
          maxOutputTokens: 8192,
          compaction: { enabled: true, thresholdRatio: 0.8 },
          computed: { messageBudget: 100, pressure: 0.4 },
          provenance: {
            context_window: { source: 'user' },
            max_output_tokens: { source: 'default' },
            message_budget: {
              source: 'derived',
              derivedFrom: ['context_window', 'max_output_tokens']
            }
          }
        },
        desired: { contextWindow: 100000, maxOutputTokens: 4096 },
        compaction: 'disabled'
      })
    );

    const text = configurationText(status);
    expect(status.node.textContent).toContain('Effective configuration');
    expect(text).toContain('runtime-1');
    expect(text).toContain('3');
    expect(text).toContain(
      '200000 tokens (declared metadata, not measured capacity)'
    );
    expect(text).toContain('Provenance context_window');
    expect(text).toContain('user');
    expect(text).toContain('default');
    expect(text).toContain('derived from context_window, max_output_tokens');
    expect(text).toContain('Computed message budget');
    expect(text).toContain('Compaction threshold ratio');
    expect(text).toContain('Compaction: disabled');
    expect(text).toContain('declared metadata, not measured capacity');
    expect(text).toContain('does not repair gateway or provider truncation');
  });

  it('reports pending next-runtime changes without claiming they are applied', () => {
    const status = new StatusBar(handlers());
    status.sync(
      readyState(),
      workspaceOverview([]),
      report({
        state: 'pending-next-runtime',
        active: { contextWindow: 100000 },
        desired: { contextWindow: 200000 },
        differences: {
          context_window: { active: 100000, desired: 200000 },
          compaction_enabled: { active: true, desired: false }
        }
      })
    );

    const text = configurationText(status);
    expect(text).toContain('Pending next runtime');
    expect(text).toContain('not active now');
    expect(text).toContain('administrator explicitly restarts Jupyter');
    expect(text).toContain('A new session does not activate them');
    expect(text).toContain('never restarts or interrupts the runtime');
    expect(text).toContain('100000 → 200000');
    expect(text).toContain('true → false');
    expect(text).not.toContain(
      'Active: these values are applied to the currently running runtime.'
    );
  });

  it('shows no active values when the runtime has not started', () => {
    const status = new StatusBar(handlers());
    status.sync(
      readyState(),
      workspaceOverview([]),
      report({
        state: 'not-started',
        active: null,
        desired: { contextWindow: 100000 }
      })
    );

    const text = configurationText(status);
    expect(text).toContain('Not started');
    expect(text).toContain('no active configuration is applied yet');
    expect(text).toContain('Not reported by the runtime.');
    expect(text).toContain('ValuesNot reported by the runtime.');
    expect(text).not.toContain('200000 tokens');
  });

  it('states that effective configuration is unavailable without a report', () => {
    const status = new StatusBar(handlers());
    status.sync(readyState(), workspaceOverview([]), null);

    const text = configurationText(status);
    expect(text).toContain(
      'Effective configuration is unavailable until the runtime reports it'
    );
    expect(text).toContain('No values are inferred.');
  });

  it('shows a configuration failure as a persistent panel notice that keeps the active report', () => {
    const status = new StatusBar(handlers());
    const activeReport = report({
      runtimeLifetime: 'runtime-7',
      generation: 7,
      active: { contextWindow: 200000 }
    });
    status.sync(
      readyState(),
      workspaceOverview([]),
      activeReport,
      configurationErrorCopy
    );

    expect(configurationErrorText(status)).toBe(configurationErrorCopy);
    const text = configurationText(status);
    expect(text).toContain('runtime-7');
    expect(text).toContain('200000 tokens');
    expect(text).toContain(
      'Active: these values are applied to the currently running runtime.'
    );
    // The failure is a panel row, not a transient execution message.
    expect(executionText(status)).not.toContain(configurationErrorCopy);

    status.sync(
      readyState(),
      workspaceOverview([]),
      activeReport,
      '<img src=x onerror=alert(1)>'
    );
    expect(configurationErrorText(status)).toBe('<img src=x onerror=alert(1)>');
    expect(
      status.node.querySelector('.jp-AgentWorkspace-configurationError img')
    ).toBeNull();
    expect(
      status.node.querySelector('.jp-AgentWorkspace-configurationContent')!
        .textContent
    ).toContain('runtime-7');
  });

  it('clears the configuration failure notice after a successful report', () => {
    const status = new StatusBar(handlers());
    const activeReport = report({ generation: 5 });
    status.sync(
      readyState(),
      workspaceOverview([]),
      activeReport,
      configurationErrorCopy
    );
    expect(configurationErrorText(status)).toBe(configurationErrorCopy);

    // Same report object: only the cleared error makes the dedupe key differ.
    status.sync(readyState(), workspaceOverview([]), activeReport, null);

    expect(configurationErrorText(status)).toBe('');
    expect(
      status.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-configurationError'
      )?.hidden
    ).toBe(true);
    expect(configurationText(status)).toContain('runtime-1');
    expect(executionText(status)).not.toContain(configurationErrorCopy);
  });

  it('skips an empty difference path instead of rendering a blank label', () => {
    const status = new StatusBar(handlers());
    status.sync(
      readyState(),
      workspaceOverview([]),
      report({
        differences: {
          '': { active: null, desired: { contextWindow: 100000 } },
          context_window: { active: 100000, desired: 200000 }
        }
      })
    );

    const labels = Array.from(
      status.node.querySelectorAll<HTMLElement>(
        '.jp-AgentWorkspace-configurationLabel'
      )
    ).map(node => node.textContent);
    expect(labels).not.toContain('');
    expect(configurationText(status)).toContain('100000 → 200000');
  });

  it('refreshes configuration through the handler without other side effects', () => {
    const onRefreshConfiguration = jest.fn();
    const status = new StatusBar(handlers(onRefreshConfiguration));

    status.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-refreshConfiguration'
      )
      ?.click();

    expect(onRefreshConfiguration).toHaveBeenCalledTimes(1);
    status.dispose();
  });

  it('renders the session report and updates after a session change', () => {
    const getter = jest.spyOn(
      AgentSession.prototype,
      'configurationReport',
      'get'
    );
    getter.mockReturnValue(report({ generation: 3 }));
    const content = new AgentWorkspaceContent(null);
    expect(content.node.textContent).toContain('runtime-1');

    getter.mockReturnValue(
      report({ generation: 4, runtimeLifetime: 'runtime-2' })
    );
    (content as unknown as { onSessionChange(): void }).onSessionChange();
    expect(content.node.textContent).toContain('runtime-2');
    content.dispose();
  });

  it('asks the session for a fresh report without connecting or changing context', () => {
    const requestConfiguration = jest
      .spyOn(AgentSession.prototype, 'requestConfiguration')
      .mockImplementation(() => {});
    const connect = jest
      .spyOn(AgentSession.prototype, 'connect')
      .mockImplementation(() => {});
    const resetContext = jest.spyOn(AgentSession.prototype, 'resetContext');
    const content = new AgentWorkspaceContent(null);
    const contextState = content.session.contextState;
    const serialized = serializeNotebook(content.notebook);

    content.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-refreshConfiguration'
      )
      ?.click();

    expect(requestConfiguration).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(resetContext).not.toHaveBeenCalled();
    expect(content.session.contextState).toBe(contextState);
    expect(content.notebook.activeRun).toBeNull();
    expect(serializeNotebook(content.notebook)).toBe(serialized);
    content.dispose();
  });

  it('reports that configuration cannot be refreshed while disconnected without connecting', () => {
    const requestConfiguration = jest
      .spyOn(AgentSession.prototype, 'requestConfiguration')
      .mockReturnValue(false);
    const connect = jest
      .spyOn(AgentSession.prototype, 'connect')
      .mockImplementation(() => {});
    const resetContext = jest.spyOn(AgentSession.prototype, 'resetContext');
    const content = new AgentWorkspaceContent(null);
    const contextState = content.session.contextState;
    const serialized = serializeNotebook(content.notebook);

    content.node
      .querySelector<HTMLButtonElement>(
        '.jp-AgentWorkspace-refreshConfiguration'
      )
      ?.click();

    expect(requestConfiguration).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(resetContext).not.toHaveBeenCalled();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).toContain('not connected');
    expect(content.session.contextState).toBe(contextState);
    expect(content.notebook.activeRun).toBeNull();
    expect(serializeNotebook(content.notebook)).toBe(serialized);
    content.dispose();
  });

  it('keeps a bodyless running turn and live context while showing the configuration failure', () => {
    jest
      .spyOn(AgentSession.prototype, 'configurationReport', 'get')
      .mockReturnValue(report({ runtimeLifetime: 'runtime-9', generation: 9 }));
    const configurationError = jest.spyOn(
      AgentSession.prototype,
      'configurationError',
      'get'
    );
    configurationError.mockReturnValue(null);
    jest.spyOn(AgentSession.prototype, 'connect').mockImplementation(() => {});
    jest.spyOn(AgentSession.prototype, 'sendUser').mockImplementation(function (
      this: AgentSession
    ): void {
      this.running = true;
      this.error = null;
    });
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as {
      runCell(advance: boolean): void;
      onSessionChange(): void;
    };

    content.notebook.setSource('do the work');
    internals.runCell(false);
    const requestId = content.notebook.activeRun!.id;
    content.session.acceptedTurnId = requestId;
    content.session.contextState = 'live';
    content.session.blocks = [];
    content.session.turn = setTurnStatus(createTurn(requestId), 'running', []);
    internals.onSessionChange();
    expect(content.notebook.cells[0].status).toBe('running');
    expect(content.node.textContent).not.toContain(configurationErrorCopy);

    configurationError.mockReturnValue(configurationErrorCopy);
    internals.onSessionChange();

    expect(content.node.textContent).toContain(configurationErrorCopy);
    expect(content.node.textContent).toContain('runtime-9');
    expect(content.notebook.cells[0].status).toBe('running');
    expect(content.session.turn?.status).toBe('running');
    expect(content.session.running).toBe(true);
    expect(content.session.contextState).toBe('live');
    expect(
      content.node.querySelector('.jp-AgentWorkspace-statusExecution')
        ?.textContent
    ).not.toContain(configurationErrorCopy);
    content.dispose();
  });

  it('states not-observable compaction without downgrading a live context', () => {
    const status = new StatusBar(handlers());
    status.sync(readyState(), workspaceOverview([]), report());

    const configuration = configurationText(status);
    expect(configuration).toContain('Compaction: not observable');
    expect(configuration).toContain(
      'The runtime did not prove whether compaction is active.'
    );
    expect(configuration).not.toContain('Compaction: disabled');

    // Scoped to the context nodes: the popover also contains the always-present
    // "Start new context" button, which must not be read as a warning.
    const context =
      status.node.querySelector('.jp-AgentWorkspace-contextDescription')
        ?.textContent ?? '';
    expect(context).toBe(
      'The current Agent context is live and linked to this workspace.'
    );
    expect(context).not.toMatch(
      /unavailable|reset|could not be resumed|cleared/i
    );
    expect(executionText(status)).not.toMatch(
      /unavailable|reset|could not be resumed|cleared/i
    );
    expect(
      status.node
        .querySelector('.jp-AgentWorkspace-statusContext')
        ?.classList.contains('is-unavailable')
    ).toBe(false);
    expect(
      status.node.querySelector<HTMLElement>('.jp-AgentWorkspace-historyChoice')
        ?.hidden
    ).toBe(true);
    expect(
      status.node.querySelector('.jp-AgentWorkspace-historyChoiceDescription')
        ?.textContent
    ).toBe('');
  });
});
