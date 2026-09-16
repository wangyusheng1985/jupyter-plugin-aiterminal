export const PLUGIN_ID = 'jupyter-aiterminal:plugin';
export const AGENT_COMMAND_ID = 'aiterminal:open';
export const AGENT_RESTORE_COMMAND_ID = 'aiterminal:restore';
export const AGENT_PANEL_CLASS = 'jp-AgentWorkspace';
export const TRACKER_NAMESPACE = 'aiterminal-workspace';
export const TRANSLATION_DOMAIN = 'jupyter-aiterminal';

export class ShutdownCoordinator {
  private promise: Promise<void> | null = null;
  run(shutdown: () => Promise<void>): Promise<void> {
    if (!this.promise) this.promise = shutdown();
    return this.promise;
  }
}
