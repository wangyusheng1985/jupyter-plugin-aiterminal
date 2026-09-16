import {
  AgentWorkspaceContent,
  CellView,
  type CellHandlers,
  renderBlock,
  renderCellOutput,
  renderCellOutputPreservingScroll,
  runningIndicatorNode
} from './workspace';
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

  function handlers(onSelect = jest.fn()): CellHandlers {
    return {
      onSource: jest.fn(),
      onSelect,
      onToggleCollapse: jest.fn(),
      onToggleKind: jest.fn(),
      onAddCell: jest.fn(),
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
