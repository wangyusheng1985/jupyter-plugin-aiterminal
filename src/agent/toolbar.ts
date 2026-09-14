import {
  HTMLSelect,
  ReactWidget,
  ToolbarButton,
  addAboveIcon,
  addIcon,
  runIcon,
  stopIcon
} from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';
import * as React from 'react';

import type { WorkspaceMode } from './protocol';

export interface AgentToolbarHost {
  readonly mode: WorkspaceMode;
  setCellKind(kind: WorkspaceMode): void;
  insertAbove(): void;
  insertBelow(): void;
  runAndAdvance(): void;
  interrupt(): void;
}

const TOOLBAR_CELLTYPE_CLASS = 'jp-Notebook-toolbarCellType';
const TOOLBAR_CELLTYPE_DROPDOWN_CLASS = 'jp-Notebook-toolbarCellTypeDropdown';

export class CellTypeSwitcher extends ReactWidget {
  constructor(private readonly host: AgentToolbarHost) {
    super();
    this.addClass(TOOLBAR_CELLTYPE_CLASS);
  }

  render(): React.ReactElement {
    return React.createElement(HTMLSelect, {
      className: TOOLBAR_CELLTYPE_DROPDOWN_CLASS,
      value: this.host.mode,
      'aria-label': 'Cell type',
      title: 'Select the cell type',
      options: [
        { value: 'ai', label: 'AI' },
        { value: 'command', label: 'Command' }
      ],
      onChange: this.handleChange
    });
  }

  private readonly handleChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    const value = event.target.value;
    if (value === 'ai' || value === 'command') {
      this.host.setCellKind(value);
    }
  };
}

export interface ToolbarHost {
  addClass(name: string): void;
  addItem(name: string, widget: Widget): boolean;
}

export function installAgentToolbar(
  toolbar: ToolbarHost,
  host: AgentToolbarHost
): CellTypeSwitcher {
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
  const cellType = new CellTypeSwitcher(host);
  toolbar.addItem('cellType', cellType);
  return cellType;
}
