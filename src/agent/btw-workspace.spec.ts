import { AgentSession } from './session';
import { createTurn, setTurnStatus } from './turn';
import { AgentWorkspaceContent } from './workspace';

jest.mock('@jupyterlab/apputils', () => ({
  Notification: { emit: jest.fn() }
}));

jest.mock('@jupyterlab/cells', () => ({
  OutputPlaceholder: class {
    node = document.createElement('div');
    isAttached = false;
    text = '';
    dispose(): void {}
  }
}));

jest.mock('@jupyterlab/rendermime', () => ({
  renderMarkdown: jest.fn()
}));

jest.mock('./btw-protocol', () => {
  const actual = jest.requireActual('./btw-protocol');
  return {
    ...actual,
    btwRestoreThread: jest.fn().mockResolvedValue({ thread: null }),
    btwOpenThread: jest.fn(),
    btwSend: jest.fn(),
    btwCancel: jest.fn()
  };
});

interface WorkspaceInternals {
  openBtwTurn: (cellId: string, turnId: string) => void;
  insertSendBackCell: (text: string) => {
    status: 'sent' | 'inserted' | 'blocked';
    runId?: string;
    message?: string;
  };
}

function internals(content: AgentWorkspaceContent): WorkspaceInternals {
  return content as unknown as WorkspaceInternals;
}

function btwPanel(content: AgentWorkspaceContent): HTMLElement {
  const node = content.node.querySelector('.jp-BtwPanel');
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

function panelHidden(content: AgentWorkspaceContent): boolean {
  return btwPanel(content).classList.contains('lm-mod-hidden');
}

function attachContext(content: AgentWorkspaceContent, path: string): void {
  // A minimal not-ready context: the workspace needs the document path for
  // BTW, and persistNow() must skip a document that is not ready yet.
  (content as unknown as { context: unknown }).context = {
    path,
    isReady: false
  };
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn()
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('workspace BTW wiring', () => {
  it('opens the panel for a finished answer and labels its number', async () => {
    const { btwRestoreThread } = jest.requireMock('./btw-protocol') as {
      btwRestoreThread: jest.Mock;
    };
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');
    content.notebook.setSource('what is this?');
    const cell = content.notebook.cells[0];
    // Answer text lives in committed blocks; the persisted turn carries the
    // terminal status, exactly as a saved document stores it.
    cell.blocks = [
      { kind: 'text', id: 'text-1', messageId: 'm1', text: 'It is a thing.' }
    ];
    cell.turn = setTurnStatus(createTurn('run-1'), 'done', cell.blocks);
    expect(panelHidden(content)).toBe(true);

    internals(content).openBtwTurn(cell.id, 'run-1');
    await Promise.resolve();
    expect(panelHidden(content)).toBe(false);
    expect(btwPanel(content).textContent).toContain('source answer #1');
    // Opening only restores state; it never sends a message.
    expect(btwRestoreThread).toHaveBeenCalledWith(
      'folder/note.agentnb',
      cell.id
    );
    content.dispose();
  });

  it('offers no BTW for a legacy cell without a persisted turn', () => {
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');
    content.notebook.setSource('legacy question');
    const cell = content.notebook.cells[0];
    // A legacy cell keeps its answer text only in blocks: the server refuses
    // to snapshot it, so the UI must not offer the entry point either.
    cell.turn = null;
    cell.blocks = [
      {
        kind: 'text',
        id: 'text-legacy',
        messageId: 'm1',
        text: 'legacy answer'
      }
    ];
    (content as unknown as { refresh: () => void }).refresh();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-outcomeBtwButton')
    ).toBeNull();
    // The Copy control is unrelated and stays available.
    expect(
      content.node.querySelector('.jp-AgentWorkspace-outcomeCopyButton')
    ).not.toBeNull();

    internals(content).openBtwTurn(cell.id, 'legacy-run');
    expect(panelHidden(content)).toBe(true);
    content.dispose();
  });

  it('ignores a running turn because there is no finished answer yet', () => {
    const content = new AgentWorkspaceContent(null);
    content.notebook.setSource('still running');
    const cell = content.notebook.cells[0];
    cell.turn = setTurnStatus(createTurn('run-1'), 'running', []);
    (content as unknown as { refresh: () => void }).refresh();
    expect(
      content.node.querySelector('.jp-AgentWorkspace-outcomeBtwButton')
    ).toBeNull();
    content.dispose();
  });

  it('submits send-back text exactly once when the session is idle', () => {
    const sendUser = jest.spyOn(AgentSession.prototype, 'sendUser');
    jest.spyOn(AgentSession.prototype, 'connect').mockReturnValue(undefined);
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');
    content.notebook.setSource('original question');
    const original = content.notebook.cells[0];

    const outcome = internals(content).insertSendBackCell('BTW answer text');
    expect(outcome.status).toBe('sent');
    // The submitted run plus the trailing input cell the notebook keeps after
    // a run with advance=true.
    expect(content.notebook.cells).toHaveLength(3);
    const added = content.notebook.cells[1];
    expect(added.source).toBe('BTW answer text');
    expect(added.id).not.toBe(original.id);
    // Existing history is untouched; the new run is sent once.
    expect(original.source).toBe('original question');
    expect(sendUser).toHaveBeenCalledTimes(1);
    expect(sendUser.mock.calls[0][0]).toBe('BTW answer text');
    if (outcome.status === 'sent') {
      expect(sendUser.mock.calls[0][1]).toBe(outcome.runId);
    }
    content.dispose();
  });

  it('inserts nothing while the main session is busy', () => {
    const sendUser = jest.spyOn(AgentSession.prototype, 'sendUser');
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');
    content.session.running = true;

    const outcome = internals(content).insertSendBackCell('BTW answer text');
    expect(outcome.status).toBe('inserted');
    // Busy is decided before any cell exists, so no stray cell is left behind
    // and a later retry cannot insert a second copy.
    expect(content.notebook.cells).toHaveLength(1);
    expect(sendUser).not.toHaveBeenCalled();
    content.dispose();
  });

  it('reuses an already inserted send-back cell instead of duplicating it', () => {
    const sendUser = jest.spyOn(AgentSession.prototype, 'sendUser');
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');
    // Force the "inserted but not accepted" path once, then retry the same
    // text: the second delivery must reuse the first cell.
    const internalsAny = content as unknown as {
      acceptRun: (...args: unknown[]) => unknown;
    };
    const acceptRun = internalsAny.acceptRun;
    internalsAny.acceptRun = () => null;
    expect(
      internals(content).insertSendBackCell('BTW answer text').status
    ).toBe('inserted');
    expect(content.notebook.cells).toHaveLength(2);
    expect(
      internals(content).insertSendBackCell('BTW answer text').status
    ).toBe('inserted');
    expect(content.notebook.cells).toHaveLength(2);
    expect(sendUser).not.toHaveBeenCalled();

    // Once the notebook can accept runs again, the reused cell is submitted.
    internalsAny.acceptRun = acceptRun;
    const outcome = internals(content).insertSendBackCell('BTW answer text');
    expect(outcome.status).toBe('sent');
    // The reused cell plus the trailing input cell; never a second copy.
    expect(content.notebook.cells).toHaveLength(3);
    expect(
      content.notebook.cells.filter(cell => cell.source === 'BTW answer text')
    ).toHaveLength(1);
    expect(sendUser).toHaveBeenCalledTimes(1);
    content.dispose();
  });

  it('blocks every send-back while the workspace is closing', () => {
    const sendUser = jest.spyOn(AgentSession.prototype, 'sendUser');
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');
    (content as unknown as { closing: boolean }).closing = true;

    const outcome = internals(content).insertSendBackCell('BTW answer text');
    expect(outcome.status).toBe('blocked');
    if (outcome.status === 'blocked') {
      expect(outcome.message).toMatch(/closing/i);
    }
    expect(content.notebook.cells).toHaveLength(1);
    expect(sendUser).not.toHaveBeenCalled();
    content.dispose();
  });

  it('explains why a shell-looking answer is refused', () => {
    const sendUser = jest.spyOn(AgentSession.prototype, 'sendUser');
    const content = new AgentWorkspaceContent(null);
    attachContext(content, 'folder/note.agentnb');

    const outcome = internals(content).insertSendBackCell('! rm -rf /tmp/x');
    expect(outcome.status).toBe('blocked');
    if (outcome.status === 'blocked') {
      expect(outcome.message).toContain('"!"');
      expect(outcome.message).toMatch(/shell command/i);
    }
    expect(content.notebook.cells).toHaveLength(1);
    expect(sendUser).not.toHaveBeenCalled();
    content.dispose();
  });

  it('keeps the panel hidden until BTW is opened and never starts a turn', () => {
    const sendUser = jest.spyOn(AgentSession.prototype, 'sendUser');
    const content = new AgentWorkspaceContent(null);
    expect(panelHidden(content)).toBe(true);
    expect(content.notebook.cells).toHaveLength(1);
    expect(sendUser).not.toHaveBeenCalled();
    content.dispose();
  });
});
