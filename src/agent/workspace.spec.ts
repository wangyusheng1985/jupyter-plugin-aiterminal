import type { DocumentRegistry } from '@jupyterlab/docregistry';

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
import { restoreNotebook, serializeNotebook } from './document';
import { WorkspaceInputHistory } from './history';
import {
  InputHistoryStorage,
  type InputHistoryStorageLike
} from './history-storage';
import { WorkspaceNotebook, type WorkspaceCell } from './notebook';
import { AgentSession } from './session';
import { createTurn, setTurnStatus, toggleActivity, toggleTrace } from './turn';
import {
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
    const onRetrySave = jest.fn();
    const status = new StatusBar({
      onStartNewContext,
      onContinueFromHistory,
      onStartEmptyContext,
      onDismissContextChoice,
      onRevealFailure,
      onRevealInterrupted,
      onOpenHistory,
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
