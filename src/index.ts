import {
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { WidgetTracker } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentWidget } from '@jupyterlab/docregistry';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator } from '@jupyterlab/translation';
import { terminalIcon } from '@jupyterlab/ui-components';

import {
  AGENT_FACTORY,
  AGENT_FILE_EXT,
  AGENT_MODEL_NAME,
  AgentWorkspaceModelFactory,
  AgentWorkspaceWidgetFactory,
  agentFileType
} from './agent/factory';
import type { AgentWorkspaceContent } from './agent/workspace';
import {
  AGENT_COMMAND_ID,
  PLUGIN_ID,
  TRACKER_NAMESPACE,
  TRANSLATION_DOMAIN
} from './theme';

export {
  AGENT_COMMAND_ID,
  AGENT_PANEL_CLASS,
  PLUGIN_ID,
  ShutdownCoordinator
} from './theme';
export { AGENT_FACTORY, AGENT_FILE_EXT } from './agent/factory';
export { mapWorkspaceKey } from './agent/keys';
export { formatToolInput } from './agent/tool';
export { resolveSelectedText } from './agent/selectioncopy';
export { applyServerEvent } from './agent/protocol';
export {
  parseWorkspaceSnapshot,
  restoreNotebook,
  serializeNotebook
} from './agent/document';
export {
  CommandNotebook,
  WorkspaceNotebook,
  createCommandCell,
  createWorkspaceCell
} from './agent/notebook';

type AgentDocument = DocumentWidget<AgentWorkspaceContent>;

export function activate(
  app: JupyterFrontEnd,
  launcher: ILauncher,
  translator: ITranslator,
  rendermime: IRenderMimeRegistry,
  docManager: IDocumentManager,
  restorer: ILayoutRestorer | null = null,
  fileBrowser: IDefaultFileBrowser | null = null
): void {
  const trans = translator.load(TRANSLATION_DOMAIN);
  const tracker = new WidgetTracker<AgentDocument>({
    namespace: TRACKER_NAMESPACE
  });
  docManager.registry.addFileType(agentFileType(), [AGENT_FACTORY]);
  docManager.registry.addModelFactory(
    new AgentWorkspaceModelFactory() as never
  );
  const factory = new AgentWorkspaceWidgetFactory(rendermime, {
    name: AGENT_FACTORY,
    label: trans.__('Agent Workspace'),
    modelName: AGENT_MODEL_NAME,
    fileTypes: ['agent-workspace'],
    defaultFor: ['agent-workspace'],
    translator
  });
  docManager.registry.addWidgetFactory(factory as never);
  factory.widgetCreated.connect((_sender, widget) => {
    void tracker.add(widget);
    widget.context.pathChanged.connect(() => {
      void tracker.save(widget);
    });
  });
  if (restorer) {
    void restorer.restore(tracker as never, {
      command: 'docmanager:open',
      args: (widget: AgentDocument) => ({
        path: widget.context.path,
        factory: AGENT_FACTORY
      }),
      name: (widget: AgentDocument) => widget.context.path,
      when: app.serviceManager.ready
    });
  }

  app.commands.addCommand(AGENT_COMMAND_ID, {
    label: trans.__('AI Terminal'),
    caption: trans.__('Open an AI Terminal workspace'),
    icon: terminalIcon,
    describedBy: {
      args: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        }
      }
    },
    execute: async args => {
      const path = args['path'] as string | undefined;
      const widget = await openAgentWorkspace(
        docManager,
        path,
        fileBrowser?.model.path
      );
      if (!widget) {
        return;
      }
      app.shell.activateById(widget.id);
      return widget;
    }
  });
  launcher.add({ command: AGENT_COMMAND_ID, category: 'Other', rank: 20 });
}

async function openAgentWorkspace(
  docManager: IDocumentManager,
  path?: string,
  cwd?: string
): Promise<AgentDocument | undefined> {
  if (path) {
    return docManager.openOrReveal(path, AGENT_FACTORY) as
      AgentDocument | undefined;
  }
  const model = await docManager.newUntitled({
    type: 'file',
    ext: AGENT_FILE_EXT,
    ...(cwd !== undefined ? { path: cwd } : {})
  });
  return docManager.open(model.path, AGENT_FACTORY) as
    AgentDocument | undefined;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Adds AI Terminal (Agent Workspace) to the JupyterLab Launcher.',
  autoStart: true,
  requires: [ILauncher, ITranslator, IRenderMimeRegistry, IDocumentManager],
  optional: [ILayoutRestorer, IDefaultFileBrowser],
  activate
};

export default plugin;
