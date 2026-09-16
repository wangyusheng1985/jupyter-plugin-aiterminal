import {
  AgentWorkspaceContent,
  CellView,
  type CellHandlers,
  renderBlock,
  renderCellOutput,
  renderCellOutputPreservingScroll,
  runningIndicatorNode
} from './workspace';
import { restoreNotebook, serializeNotebook } from './document';
import { CommandHistory } from './history';
import { WorkspaceNotebook, type WorkspaceCell } from './notebook';
import { AgentSession } from './session';

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
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides
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
});

describe('CellView output state', () => {
  function cell(overrides: Partial<WorkspaceCell> = {}): WorkspaceCell {
    return {
      id: 'cell-1',
      kind: 'command',
      source: '',
      output: '',
      blocks: [],
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides
    };
  }

  function handlers(
    onSelect = jest.fn(),
    history = new CommandHistory()
  ): CellHandlers {
    return {
      onSource: jest.fn(),
      onSelect,
      onToggleCollapse: jest.fn(),
      onToggleKind: jest.fn(),
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
});

describe('CellView command history', () => {
  function cell(overrides: Partial<WorkspaceCell> = {}): WorkspaceCell {
    return {
      id: 'cell-1',
      kind: 'command',
      source: '',
      output: '',
      blocks: [],
      status: 'idle',
      executionCount: null,
      outputCollapsed: false,
      ...overrides
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
    const history = new CommandHistory();
    history.add('first');
    history.add('second');
    const command = cell({ source: 'draft' });
    const onSource = jest.fn((source: string) => {
      command.source = source;
    });
    const view = new CellView('cell-1', {
      ...new CommandHistoryHandlers(history),
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

  it('leaves AI and multiline editor arrow behavior untouched', () => {
    const history = new CommandHistory();
    history.add('shell command');
    const previous = jest.fn(() => history.previous('ignored'));
    const next = jest.fn(() => history.next());
    const view = new CellView('cell-1', {
      onSource: jest.fn(),
      onSelect: jest.fn(),
      onToggleCollapse: jest.fn(),
      onToggleKind: jest.fn(),
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
    expect(previous).not.toHaveBeenCalled();
    expect(textarea.value).toBe('prompt');

    const multiline = cell({ source: 'one\ntwo' });
    view.sync(multiline, 0, notebook);
    textarea.setSelectionRange(5, 5);
    press(textarea, 'ArrowUp');
    expect(previous).not.toHaveBeenCalled();
    expect(textarea.value).toBe('one\ntwo');
  });

  it('ends history navigation when recalled text is edited or the editor blurs', () => {
    const history = new CommandHistory();
    history.add('command');
    const view = new CellView('cell-1', new CommandHistoryHandlers(history));
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

  class CommandHistoryHandlers implements CellHandlers {
    onSource = jest.fn(
      (source: string, options?: { fromHistory?: boolean }) => {
        if (!options?.fromHistory) this.history.resetNavigation();
      }
    );
    onSelect = jest.fn();
    onToggleCollapse = jest.fn();
    onToggleKind = jest.fn();
    onAddCell = jest.fn();
    rendermime = null;

    constructor(private readonly history: CommandHistory) {}

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
    content.notebook.setKind('command');
    content.notebook.setSource('second');
    internals.runCell(false);

    expect(sendUser).toHaveBeenCalledTimes(1);
    expect(sendUser).toHaveBeenCalledWith('first');
    expect(exec).not.toHaveBeenCalled();
    expect(content.notebook.cells[0].status).toBe('running');
    expect(content.notebook.cells[1].status).toBe('queued');

    content.session.running = false;
    content.session.connected = true;
    content.session.error = null;
    internals.onSessionChange();

    expect(content.notebook.cells[0].status).toBe('done');
    expect(content.notebook.cells[1].status).toBe('running');
    expect(exec).toHaveBeenCalledWith('second');

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
    content.notebook.setKind('command');
    content.notebook.setSource('second');
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

  it('advances immediately at enqueue and does not move selection on completion', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('first');
    internals.runCell(false);
    content.notebook.select(1);
    content.notebook.setSource('second');
    internals.runCell(true);

    const selectedAfterEnqueue = content.notebook.active;
    expect(selectedAfterEnqueue).toBe(2);
    expect(content.notebook.cells[1].status).toBe('queued');

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
    content.notebook.setKind('command');
    content.notebook.setSource('second');
    internals.runCell(false);

    content.session.running = false;
    content.session.connected = true;
    internals.onSessionChange();
    await new Promise(resolve => setTimeout(resolve, 0));

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
    content.notebook.setKind('command');
    content.notebook.setSource('two');
    internals.runCell(false);
    content.notebook.select(2);
    content.notebook.setSource('three');
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
    content.notebook.setKind('command');
    content.notebook.setSource('second');
    internals.runCell(false);

    content.dispose();

    expect(content.notebook.activeRun).toBeNull();
    expect(content.notebook.queuedRuns).toEqual([]);
    expect(content.notebook.cells[0].status).toBe('interrupted');
    expect(content.notebook.cells[1].status).toBe('idle');
  });
});

describe('AgentWorkspaceContent command history', () => {
  interface WorkspaceInternals {
    runCell(advance: boolean): void;
    refresh(): void;
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

  it('keeps command histories isolated by tab and out of serialization', () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'ok\n', returncode: 0, cwd: '/tmp' });
    const first = new AgentWorkspaceContent(null);
    const second = new AgentWorkspaceContent(null);
    const firstInternals = first as unknown as WorkspaceInternals;

    first.notebook.setKind('command');
    first.notebook.setSource('pwd');
    firstInternals.runCell(false);

    expect(first.commandHistory.values).toEqual(['pwd']);
    expect(second.commandHistory.values).toEqual([]);

    const restored = new AgentWorkspaceContent(null);
    restoreNotebook(restored.notebook, serializeNotebook(first.notebook));
    expect(restored.commandHistory.values).toEqual([]);

    first.dispose();
    second.dispose();
    restored.dispose();
  });

  it('records a command when accepted and keeps it after a failed run', async () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockRejectedValue(new Error('command failed'));
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setKind('command');
    content.notebook.setSource('false');
    internals.runCell(false);
    expect(content.commandHistory.values).toEqual(['false']);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(content.commandHistory.values).toEqual(['false']);
    content.dispose();
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
    content.notebook.setKind('command');
    content.notebook.setSource('pwd');
    internals.runCell(false);

    expect(content.notebook.cells[1].status).toBe('queued');
    expect(content.commandHistory.values).toEqual(['pwd']);
    content.dispose();
  });

  it('does not add AI submissions to command history', () => {
    const content = new AgentWorkspaceContent(null);
    const internals = content as unknown as WorkspaceInternals;

    content.notebook.setSource('explain this repository');
    internals.runCell(false);

    expect(content.commandHistory.values).toEqual([]);
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

    content.notebook.setKind('command');
    content.notebook.setSource('sleep 10');
    internals.runCell(false);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(content.notebook.cells[0].status).toBe('interrupted');
    expect(content.commandHistory.values).toEqual(['sleep 10']);
    content.dispose();
  });

  it('recalls per-tab history in real inputs and leaves AI arrows unchanged', () => {
    jest
      .spyOn(AgentSession.prototype, 'exec')
      .mockResolvedValue({ output: 'ok\n', returncode: 0, cwd: '/tmp' });
    const first = new AgentWorkspaceContent(null);
    const second = new AgentWorkspaceContent(null);
    const firstInternals = first as unknown as WorkspaceInternals;
    const secondInternals = second as unknown as WorkspaceInternals;

    first.notebook.setKind('command');
    first.notebook.setSource('first command');
    firstInternals.runCell(false);
    first.notebook.select(1);
    first.notebook.enterEdit();
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
    expect(firstInput.value).toBe('first command');
    firstInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    expect(firstInput.value).toBe('');

    second.notebook.setKind('command');
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

    first.setCellKind('ai');
    first.notebook.setSource('prompt text');
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
    expect(aiInput.value).toBe('prompt text');

    first.dispose();
    second.dispose();
  });
});
