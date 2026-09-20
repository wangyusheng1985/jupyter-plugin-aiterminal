import {
  ABCWidgetFactory,
  DocumentModel,
  DocumentWidget,
  type DocumentRegistry
} from '@jupyterlab/docregistry';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { terminalIcon } from '@jupyterlab/ui-components';

import {
  AGENT_FACTORY,
  AGENT_FILE_EXT,
  AGENT_FILE_TYPE,
  AGENT_MODEL_NAME
} from './document';
import { installAgentToolbar } from './toolbar';
import { AgentWorkspaceContent } from './workspace';

export class AgentWorkspaceModelFactory implements DocumentRegistry.IModelFactory<DocumentRegistry.ICodeModel> {
  readonly name = AGENT_MODEL_NAME;
  readonly contentType = 'file';
  readonly fileFormat = 'text';
  readonly collaborative = false;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }

  createNew(
    options?: DocumentRegistry.IModelOptions
  ): DocumentRegistry.ICodeModel {
    return new DocumentModel({
      languagePreference: options?.languagePreference,
      collaborationEnabled: false
    });
  }

  preferredLanguage(path: string): string {
    void path;
    return '';
  }
}

export class AgentWorkspaceWidgetFactory extends ABCWidgetFactory<
  DocumentWidget<AgentWorkspaceContent>,
  DocumentRegistry.ICodeModel
> {
  constructor(
    private readonly rendermime: IRenderMimeRegistry,
    options: DocumentRegistry.IWidgetFactoryOptions<
      DocumentWidget<AgentWorkspaceContent>
    >
  ) {
    super(options);
  }

  protected createNewWidget(
    context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel>
  ): DocumentWidget<AgentWorkspaceContent> {
    const separator = Math.max(
      context.path.lastIndexOf('/'),
      context.path.lastIndexOf('\\')
    );
    const cwd = separator >= 0 ? context.path.slice(0, separator) : '';
    const content = new AgentWorkspaceContent(
      this.rendermime,
      cwd || undefined
    );
    const widget = new DocumentWidget({ content, context });
    const disposeToolbar = installAgentToolbar(widget.toolbar, content);
    widget.disposed.connect(() => disposeToolbar());
    content.attachContext(context);
    widget.id = `agent-workspace:${context.path}`;
    widget.title.icon = terminalIcon;
    widget.title.closable = true;
    return widget;
  }
}

export function agentFileType(): Partial<DocumentRegistry.IFileType> {
  return {
    name: AGENT_FILE_TYPE,
    displayName: 'Agent Workspace',
    extensions: [AGENT_FILE_EXT],
    fileFormat: 'text',
    contentType: 'file',
    mimeTypes: ['application/x-jupyter-agent-workspace']
  };
}

export { AGENT_FACTORY, AGENT_FILE_EXT, AGENT_FILE_TYPE, AGENT_MODEL_NAME };
