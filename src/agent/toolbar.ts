import {
  ToolbarButton,
  addAboveIcon,
  addIcon,
  runIcon,
  stopIcon
} from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';

export interface AgentToolbarHost {
  insertAbove(): void;
  insertBelow(): void;
  runAndAdvance(): void;
  interrupt(): void;
}

export interface ToolbarHost {
  addClass(name: string): void;
  addItem(name: string, widget: Widget): boolean;
}

export function installAgentToolbar(
  toolbar: ToolbarHost,
  host: AgentToolbarHost
): void {
  toolbar.addClass('jp-NotebookPanel-toolbar');
  toolbar.addClass('jp-AgentWorkspace-toolbar');
  toolbar.addItem(
    'insert-above',
    new ToolbarButton({
      icon: addAboveIcon,
      tooltip: 'Insert a cell above',
      noFocusOnClick: true,
      onClick: () => host.insertAbove()
    })
  );
  toolbar.addItem(
    'insert',
    new ToolbarButton({
      icon: addIcon,
      tooltip: 'Insert a cell below',
      noFocusOnClick: true,
      onClick: () => host.insertBelow()
    })
  );
  toolbar.addItem(
    'run',
    new ToolbarButton({
      icon: runIcon,
      tooltip: 'Run the selected cell and advance',
      noFocusOnClick: true,
      onClick: () => host.runAndAdvance()
    })
  );
  toolbar.addItem(
    'interrupt',
    new ToolbarButton({
      icon: stopIcon,
      tooltip: 'Interrupt the running cell',
      noFocusOnClick: true,
      onClick: () => host.interrupt()
    })
  );
}
