import { CommandRegistry } from '@lumino/commands';

jest.mock('@jupyterlab/apputils', () => ({
  MainAreaWidget: class {},
  WidgetTracker: class {
    has(): boolean {
      return false;
    }
    add(): Promise<void> {
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  }
}));
jest.mock('@jupyterlab/application', () => ({
  ILayoutRestorer: Symbol('ILayoutRestorer')
}));
jest.mock('@jupyterlab/docmanager', () => ({
  IDocumentManager: Symbol('IDocumentManager')
}));
jest.mock('@jupyterlab/filebrowser', () => ({
  IDefaultFileBrowser: Symbol('IDefaultFileBrowser')
}));
jest.mock('@jupyterlab/docregistry', () => ({
  ABCWidgetFactory: class {
    widgetCreated = { connect: jest.fn() };
    constructor() {}
  },
  DocumentModel: class {},
  DocumentWidget: class {}
}));
jest.mock('@jupyterlab/launcher', () => ({ ILauncher: Symbol('ILauncher') }));
jest.mock('@jupyterlab/rendermime', () => ({
  IRenderMimeRegistry: Symbol('IRenderMimeRegistry'),
  renderMarkdown: jest.fn()
}));
jest.mock('@jupyterlab/cells', () => ({
  OutputPlaceholder: class {
    node = document.createElement('div');
    text = '';
    constructor(options: { text?: string }) {
      this.text = options.text ?? '';
    }
  }
}));
jest.mock('@jupyterlab/translation', () => ({
  ITranslator: Symbol('ITranslator')
}));
jest.mock('@jupyterlab/ui-components', () => ({
  terminalIcon: {},
  addAboveIcon: {},
  addIcon: {},
  runIcon: {},
  stopIcon: {},
  Toolbar: class {},
  ToolbarButton: class {},
  ReactWidget: class {},
  HTMLSelect: () => null
}));
jest.mock('@jupyterlab/coreutils', () => ({
  URLExt: {
    join: (...parts: string[]) => parts.join('/'),
    objectToQueryString: () => ''
  }
}));
jest.mock('@jupyterlab/services', () => ({
  ServerConnection: {
    makeSettings: () => ({
      wsUrl: 'ws://example',
      WebSocket: class {},
      appendToken: false,
      token: ''
    })
  }
}));

import {
  AGENT_COMMAND_ID,
  AGENT_FILE_BROWSER_COMMAND_ID,
  AGENT_RESTORE_COMMAND_ID,
  FILE_BROWSER_CONTENT_SELECTOR,
  PLUGIN_ID,
  ShutdownCoordinator,
  activate,
  resolveFileBrowserCreationPath
} from './index';

describe('jupyter-aiterminal launcher', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('registers AI Terminal only', () => {
    const commands = new CommandRegistry();
    const launcherAdd = jest.fn();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const app = { commands, shell: {} };
    const registry = {
      addFileType: jest.fn(),
      addModelFactory: jest.fn(),
      addWidgetFactory: jest.fn()
    };
    const docManager = {
      registry,
      findWidget: jest.fn(),
      open: jest.fn(),
      createNew: jest.fn(),
      newUntitled: jest.fn()
    };

    activate(
      app as never,
      { add: launcherAdd } as never,
      translator as never,
      {} as never,
      docManager as never
    );

    expect(registry.addFileType).toHaveBeenCalled();
    expect(registry.addModelFactory).toHaveBeenCalled();
    expect(registry.addWidgetFactory).toHaveBeenCalled();
    expect(PLUGIN_ID).toBe('jupyter-aiterminal:plugin');
    expect(AGENT_COMMAND_ID).toBe('aiterminal:open');
    expect(commands.hasCommand(AGENT_COMMAND_ID)).toBe(true);
    expect(commands.hasCommand(AGENT_FILE_BROWSER_COMMAND_ID)).toBe(false);
    expect(commands.hasCommand('classic-ssh:open')).toBe(false);
    expect(commands.hasCommand('classic-ssh:openAgentWorkspace')).toBe(false);
    expect(launcherAdd).toHaveBeenCalledTimes(1);
    expect(launcherAdd).toHaveBeenCalledWith({
      command: AGENT_COMMAND_ID,
      category: 'Other',
      rank: 20
    });
  });

  it('resolves the file browser creation directory from the clicked model', () => {
    const current = { path: 'work' };
    const modelForClick = jest.fn();
    const fileBrowser = { model: current, modelForClick };
    const event = new MouseEvent('contextmenu');

    modelForClick.mockReturnValue({
      type: 'directory',
      path: 'work/project'
    });
    expect(resolveFileBrowserCreationPath(fileBrowser as never, event)).toBe(
      'work/project'
    );

    modelForClick.mockReturnValue({ type: 'file', path: 'work/readme.md' });
    expect(resolveFileBrowserCreationPath(fileBrowser as never, event)).toBe(
      'work'
    );

    modelForClick.mockReturnValue(undefined);
    expect(resolveFileBrowserCreationPath(fileBrowser as never, event)).toBe(
      'work'
    );

    current.path = '';
    expect(resolveFileBrowserCreationPath(fileBrowser as never, event)).toBe(
      ''
    );
  });

  it('registers AI Terminal in the default file browser context menu', () => {
    const commands = new CommandRegistry();
    const contextMenuAdd = jest.fn();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const fileBrowser = {
      model: { path: 'work' },
      modelForClick: jest.fn(),
      node: document.createElement('div')
    };
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      open: jest.fn(),
      openOrReveal: jest.fn(),
      newUntitled: jest.fn()
    };

    activate(
      {
        commands,
        shell: {},
        contextMenu: { addItem: contextMenuAdd }
      } as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never,
      null,
      fileBrowser as never
    );

    expect(AGENT_FILE_BROWSER_COMMAND_ID).toBe(
      'aiterminal:new-from-file-browser'
    );
    expect(commands.hasCommand(AGENT_FILE_BROWSER_COMMAND_ID)).toBe(true);
    expect(commands.label(AGENT_FILE_BROWSER_COMMAND_ID)).toBe('AI Terminal');
    expect(commands.caption(AGENT_FILE_BROWSER_COMMAND_ID)).toBe(
      'Create an AI Terminal workspace in this folder'
    );
    expect(commands.icon(AGENT_FILE_BROWSER_COMMAND_ID)).toEqual({});
    expect(contextMenuAdd).toHaveBeenCalledWith({
      command: AGENT_FILE_BROWSER_COMMAND_ID,
      selector: FILE_BROWSER_CONTENT_SELECTOR,
      rank: 20
    });
  });

  it('captures the latest clicked directory and consumes it once', async () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const shell = { activateById: jest.fn() };
    const content = document.createElement('ul');
    content.className = FILE_BROWSER_CONTENT_SELECTOR.slice(1);
    const item = document.createElement('li');
    content.appendChild(item);
    const node = document.createElement('div');
    node.appendChild(content);
    const browserModel = { path: 'work' };
    const modelForClick = jest
      .fn()
      .mockReturnValueOnce({ type: 'directory', path: 'work/first' })
      .mockReturnValueOnce({ type: 'directory', path: 'work/second' });
    const selectedItems = jest.fn();
    const fileBrowser = {
      model: browserModel,
      modelForClick,
      selectedItems,
      node
    };
    const widgets = [
      { id: 'agent-workspace:work/second/Untitled1.agentnb' },
      { id: 'agent-workspace:current/Untitled.agentnb' }
    ];
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      open: jest
        .fn()
        .mockReturnValueOnce(widgets[0])
        .mockReturnValueOnce(widgets[1]),
      openOrReveal: jest.fn(),
      newUntitled: jest
        .fn()
        .mockResolvedValueOnce({ path: 'work/second/Untitled1.agentnb' })
        .mockResolvedValueOnce({ path: 'current/Untitled.agentnb' })
    };

    activate(
      {
        commands,
        shell,
        contextMenu: { addItem: jest.fn() }
      } as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never,
      null,
      fileBrowser as never
    );

    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await commands.execute(AGENT_FILE_BROWSER_COMMAND_ID);
    expect(docManager.newUntitled).toHaveBeenNthCalledWith(1, {
      type: 'file',
      ext: '.agentnb',
      path: 'work/second'
    });
    expect(docManager.open).toHaveBeenNthCalledWith(
      1,
      'work/second/Untitled1.agentnb',
      'Agent Workspace'
    );
    expect(shell.activateById).toHaveBeenNthCalledWith(1, widgets[0].id);
    expect(selectedItems).not.toHaveBeenCalled();
    expect(docManager.openOrReveal).not.toHaveBeenCalled();

    browserModel.path = 'current';
    await commands.execute(AGENT_FILE_BROWSER_COMMAND_ID);
    expect(docManager.newUntitled).toHaveBeenNthCalledWith(2, {
      type: 'file',
      ext: '.agentnb',
      path: 'current'
    });
    expect(shell.activateById).toHaveBeenNthCalledWith(2, widgets[1].id);
  });

  it('uses the invocation-time current directory for files and blank space', async () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const shell = { activateById: jest.fn() };
    const content = document.createElement('ul');
    content.className = FILE_BROWSER_CONTENT_SELECTOR.slice(1);
    const fileItem = document.createElement('li');
    content.appendChild(fileItem);
    const node = document.createElement('div');
    node.appendChild(content);
    const browserModel = { path: 'work' };
    const modelForClick = jest
      .fn()
      .mockReturnValueOnce({ type: 'file', path: 'work/readme.md' })
      .mockReturnValueOnce(undefined);
    const fileBrowser = { model: browserModel, modelForClick, node };
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      open: jest
        .fn()
        .mockReturnValueOnce({ id: 'agent-workspace:work/Untitled.agentnb' })
        .mockReturnValueOnce({ id: 'agent-workspace:Untitled1.agentnb' }),
      openOrReveal: jest.fn(),
      newUntitled: jest
        .fn()
        .mockResolvedValueOnce({ path: 'work/Untitled.agentnb' })
        .mockResolvedValueOnce({ path: 'Untitled1.agentnb' })
    };

    activate(
      {
        commands,
        shell,
        contextMenu: { addItem: jest.fn() }
      } as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never,
      null,
      fileBrowser as never
    );

    fileItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    browserModel.path = 'changed-after-menu-open';
    await commands.execute(AGENT_FILE_BROWSER_COMMAND_ID);
    expect(docManager.newUntitled).toHaveBeenNthCalledWith(1, {
      type: 'file',
      ext: '.agentnb',
      path: 'work'
    });

    browserModel.path = '';
    content.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await commands.execute(AGENT_FILE_BROWSER_COMMAND_ID);
    expect(docManager.newUntitled).toHaveBeenNthCalledWith(2, {
      type: 'file',
      ext: '.agentnb',
      path: ''
    });
    expect(docManager.open).toHaveBeenNthCalledWith(
      2,
      'Untitled1.agentnb',
      'Agent Workspace'
    );
    expect(shell.activateById).toHaveBeenCalledTimes(2);
  });

  it('opens an untitled Agent Workspace document', async () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const app = {
      commands,
      shell: { activateById: jest.fn() },
      contextMenu: { addItem: jest.fn() }
    };
    const widget = { id: 'agent-workspace:Untitled.agentnb' };
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      findWidget: jest.fn(),
      open: jest.fn(() => widget),
      openOrReveal: jest.fn(),
      createNew: jest.fn(),
      newUntitled: jest.fn(async () => ({ path: 'Untitled.agentnb' }))
    };

    activate(
      app as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never
    );

    await commands.execute(AGENT_COMMAND_ID);
    expect(docManager.newUntitled).toHaveBeenCalledWith({
      type: 'file',
      ext: '.agentnb'
    });
    expect(docManager.open).toHaveBeenCalledWith(
      'Untitled.agentnb',
      'Agent Workspace'
    );
    expect(app.shell.activateById).toHaveBeenCalledWith(widget.id);
  });

  it('restores Agent Workspace tabs through the document manager', () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const restorer = { restore: jest.fn() };
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      findWidget: jest.fn(),
      open: jest.fn(),
      createNew: jest.fn(),
      newUntitled: jest.fn()
    };

    const ready = Promise.resolve();
    activate(
      { commands, shell: {}, serviceManager: { ready } } as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never,
      restorer as never
    );

    const options = restorer.restore.mock.calls[0][1] as {
      command: string;
      args: (widget: { context: { path: string } }) => object;
      when: Promise<void>;
    };
    expect(options.command).toBe(AGENT_RESTORE_COMMAND_ID);
    expect(options.when).toBe(ready);
    expect(options.args({ context: { path: 'work/session.agentnb' } })).toEqual(
      {
        path: 'work/session.agentnb',
        factory: 'Agent Workspace'
      }
    );
  });

  it('does not restore a tab after that tab has been closed', async () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const restorer = { restore: jest.fn() };
    const registry = {
      addFileType: jest.fn(),
      addModelFactory: jest.fn(),
      addWidgetFactory: jest.fn()
    };
    const docManager = {
      registry,
      openOrReveal: jest.fn(),
      open: jest.fn(),
      newUntitled: jest.fn()
    };

    activate(
      {
        commands,
        shell: {},
        serviceManager: { ready: Promise.resolve() }
      } as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never,
      restorer as never
    );

    const factory = registry.addWidgetFactory.mock.calls[0][0] as {
      widgetCreated: { connect: jest.Mock };
    };
    const onWidgetCreated = factory.widgetCreated.connect.mock.calls[0][0] as (
      sender: unknown,
      widget: unknown
    ) => void;
    let onDisposed: (() => void) | undefined;
    const widget = {
      context: {
        path: 'work/session.agentnb',
        pathChanged: { connect: jest.fn() }
      },
      disposed: {
        connect: jest.fn((callback: () => void) => {
          onDisposed = callback;
        })
      }
    };
    onWidgetCreated(undefined, widget);
    onDisposed?.();

    await expect(
      commands.execute(AGENT_RESTORE_COMMAND_ID, {
        path: 'work/session.agentnb',
        factory: 'Agent Workspace'
      })
    ).rejects.toThrow('AI Terminal workspace was closed');
    expect(docManager.openOrReveal).not.toHaveBeenCalled();
  });

  it('reopens an existing Agent Workspace path instead of creating untitled', async () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const widget = { id: 'agent-workspace:work/session.agentnb' };
    const app = {
      commands,
      shell: { activateById: jest.fn() }
    };
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      findWidget: jest.fn(),
      open: jest.fn(),
      openOrReveal: jest.fn(() => widget),
      createNew: jest.fn(),
      newUntitled: jest.fn()
    };

    activate(
      app as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never
    );

    await commands.execute(AGENT_COMMAND_ID, { path: 'work/session.agentnb' });
    expect(docManager.newUntitled).not.toHaveBeenCalled();
    expect(docManager.openOrReveal).toHaveBeenCalledWith(
      'work/session.agentnb',
      'Agent Workspace'
    );
    expect(docManager.open).not.toHaveBeenCalled();
  });

  it('creates untitled Agent Workspace files in the file browser cwd', async () => {
    const commands = new CommandRegistry();
    const translator = { load: () => ({ __: (value: string) => value }) };
    const widget = { id: 'agent-workspace:work/Untitled.agentnb' };
    const app = {
      commands,
      shell: { activateById: jest.fn() },
      contextMenu: { addItem: jest.fn() }
    };
    const docManager = {
      registry: {
        addFileType: jest.fn(),
        addModelFactory: jest.fn(),
        addWidgetFactory: jest.fn()
      },
      findWidget: jest.fn(),
      open: jest.fn(() => widget),
      openOrReveal: jest.fn(),
      createNew: jest.fn(),
      newUntitled: jest.fn(async () => ({ path: 'work/Untitled.agentnb' }))
    };
    const fileBrowser = {
      model: { path: 'work' },
      modelForClick: jest.fn(),
      node: document.createElement('div')
    };

    activate(
      app as never,
      { add: jest.fn() } as never,
      translator as never,
      {} as never,
      docManager as never,
      null,
      fileBrowser as never
    );

    await commands.execute(AGENT_COMMAND_ID);
    expect(docManager.newUntitled).toHaveBeenCalledWith({
      type: 'file',
      ext: '.agentnb',
      path: 'work'
    });
    expect(docManager.open).toHaveBeenCalledWith(
      'work/Untitled.agentnb',
      'Agent Workspace'
    );
  });

  it('shuts a session down only once', async () => {
    const coordinator = new ShutdownCoordinator();
    const shutdown = jest.fn(async () => undefined);
    await Promise.all([coordinator.run(shutdown), coordinator.run(shutdown)]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
