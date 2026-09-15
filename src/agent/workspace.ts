import { OutputPlaceholder } from '@jupyterlab/cells';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Message } from '@lumino/messaging';
import { Panel, Widget } from '@lumino/widgets';

import { AGENT_PANEL_CLASS, ShutdownCoordinator } from '../theme';
import { restoreNotebook, serializeNotebook } from './document';
import { mapWorkspaceKey, strokeFromEvent } from './keys';
import { renderMarkdownSource } from './markdown';
import { WorkspaceNotebook, type WorkspaceCell } from './notebook';
import { AgentSession } from './session';
import { SelectionCopyButton } from './selectioncopy';
import { formatToolInput } from './tool';
import type { AgentToolbarHost, CellTypeSwitcher } from './toolbar';
import type { ChatBlock, WorkspaceMode } from './protocol';

interface CellHandlers {
  onSource: (source: string) => void;
  onSelect: (index: number, options?: { focusEditor?: boolean }) => void;
  onToggleCollapse: (index: number) => void;
  onToggleKind: (index: number) => void;
  onAddCell: () => void;
  rendermime: IRenderMimeRegistry | null;
}

export class AgentWorkspaceContent extends Panel implements AgentToolbarHost {
  readonly notebook = new WorkspaceNotebook();
  readonly session: AgentSession;
  private closing = false;
  private runningCellId: string | null = null;
  private advanceAfterRun = false;
  private readonly shutdown = new ShutdownCoordinator();
  private readonly notebookView: NotebookView;
  private readonly status: StatusBar;
  private context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel> | null =
    null;
  private applyingModel = false;
  private persistTimer = 0;
  private deleteChordTimer = 0;
  private readonly copyButton: SelectionCopyButton;
  cellTypeSwitcher: CellTypeSwitcher | null = null;

  constructor(
    private readonly rendermime: IRenderMimeRegistry | null = null,
    cwd?: string
  ) {
    super();
    this.session = new AgentSession(undefined, cwd);
    this.addClass(AGENT_PANEL_CLASS);
    this.notebookView = new NotebookView(this.notebook, {
      onSource: source => {
        this.notebook.setSource(source);
        this.persistSoon();
      },
      onSelect: (index, options) => this.selectCell(index, options),
      onToggleCollapse: index => this.toggleOutputCollapsed(index),
      onToggleKind: index => this.toggleCellKind(index),
      onAddCell: () => this.addCellFromFooter(),
      rendermime: this.rendermime
    });
    this.status = new StatusBar('AI cell  •  Local tools');
    this.addWidget(this.notebookView);
    this.addWidget(this.status);
    this.node.tabIndex = -1;
    this.copyButton = new SelectionCopyButton(this.node);
    this.node.addEventListener('keydown', event => this.onKey(event), true);
    this.session.subscribe(() => this.onSessionChange());
    this.refresh();
    this.start();
  }

  get mode(): WorkspaceMode {
    return this.notebook.empty
      ? this.notebook.insertKind
      : this.notebook.current.kind;
  }

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus({ preventScroll: true });
  }

  start(): void {
    if (this.closing || this.isDisposed) return;
    this.session.connect();
    this.refresh();
    queueMicrotask(() => this.notebookView.focusActive());
  }

  attachContext(
    context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel>
  ): void {
    this.context = context;
    void context.ready.then(() => {
      if (this.isDisposed || this.closing) return;
      this.applyModel();
      if (!context.model.toString().trim()) {
        this.persistNow();
      }
      this.start();
      context.model.contentChanged.connect(this.onModelContentChanged, this);
    });
  }

  private onModelContentChanged(): void {
    if (this.applyingModel) return;
    this.applyModel();
  }

  setCellKind(kind: WorkspaceMode): void {
    this.notebook.setKind(kind);
    if (this.notebook.empty) {
      this.refresh();
      this.persistSoon();
      return;
    }
    this.notebook.enterEdit();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  insertAbove(): void {
    this.notebook.insertAbove();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  insertBelow(): void {
    this.notebook.insertBelow();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  addCellFromFooter(): void {
    this.clearDeleteChord();
    if (this.notebook.empty) {
      this.notebook.appendCell();
    } else {
      this.notebook.select(this.notebook.cells.length - 1);
      this.notebook.insertBelow();
    }
    this.refresh();
    this.persistNow();
    this.notebookView.focusActive();
  }

  deleteActive(): void {
    this.clearDeleteChord();
    if (this.notebook.empty) {
      return;
    }
    if (this.notebook.current.status === 'running') {
      this.status.setMessage('Cannot delete a running cell.');
      return;
    }
    if (!this.notebook.deleteActive()) {
      this.status.setMessage('Cannot delete a running cell.');
      return;
    }
    this.refresh();
    this.persistNow();
    if (!this.notebook.empty) {
      this.notebookView.focusActive({ preventScroll: true });
    }
  }

  runAndAdvance(): void {
    void this.runCell(true);
  }

  interrupt(): void {
    if (this.session.running) {
      this.session.interrupt();
      return;
    }
    this.session.interruptExec();
  }

  shutdownOnce(): Promise<void> {
    return this.shutdown.run(async () => {
      this.persistNow();
      this.session.close();
    });
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.closing = true;
    this.clearDeleteChord();
    this.copyButton.dispose();
    this.persistNow();
    void this.shutdownOnce().catch(error => {
      console.error(`Agent Workspace not shut down: ${error}`);
    });
    super.dispose();
  }

  private selectCell(
    index: number,
    options: { focusEditor?: boolean } = {}
  ): void {
    if (this.notebook.empty) return;
    const focusEditor = options.focusEditor !== false;
    const alreadyActive = this.notebook.active === index;
    const alreadyEditing = alreadyActive && this.notebook.mode === 'edit';
    this.notebook.select(index);
    if (!focusEditor) {
      const alreadyCommand = alreadyActive && this.notebook.mode === 'command';
      this.notebook.exitEdit();
      blurEditor();
      if (!alreadyCommand) {
        this.refresh();
        this.persistSoon();
      }
      return;
    }
    this.notebook.enterEdit();
    if (alreadyEditing) {
      this.notebookView.focusActive({ preventScroll: true });
      return;
    }
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  private toggleOutputCollapsed(index: number): void {
    this.notebook.toggleOutputCollapsed(index);
    this.refresh();
    this.persistSoon();
  }

  private toggleCellKind(index: number): void {
    if (this.notebook.empty) return;
    this.notebook.select(index);
    this.notebook.toggleKind();
    this.notebook.enterEdit();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  private onKey(event: KeyboardEvent): void {
    if (this.notebook.empty) {
      const action = mapWorkspaceKey(
        strokeFromEvent(event),
        'notebook',
        'command',
        false
      );
      if (
        action?.type === 'insert-above' ||
        action?.type === 'insert-below' ||
        action?.type === 'enter-edit'
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.addCellFromFooter();
      }
      return;
    }
    const action = mapWorkspaceKey(
      strokeFromEvent(event),
      'notebook',
      this.notebook.mode,
      isEditorTarget(event.target),
      {
        running: this.session.running || this.notebook.busy(),
        hasSelection: hasTextSelection(event.target)
      }
    );
    if (!action) {
      if (this.deleteChordTimer && this.notebook.mode === 'command') {
        this.clearDeleteChord();
        this.refresh();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case 'interrupt':
        this.clearDeleteChord();
        this.interrupt();
        break;
      case 'enter-edit':
        this.clearDeleteChord();
        this.notebook.enterEdit();
        this.refresh();
        this.notebookView.focusActive();
        break;
      case 'exit-edit':
        this.clearDeleteChord();
        this.notebook.exitEdit();
        blurEditor();
        this.refresh();
        break;
      case 'insert-above':
        this.clearDeleteChord();
        this.insertAbove();
        break;
      case 'insert-below':
        this.clearDeleteChord();
        this.insertBelow();
        break;
      case 'delete-chord':
        this.onDeleteChord();
        break;
      case 'run-advance':
        this.clearDeleteChord();
        void this.runCell(true);
        break;
      case 'run-stay':
        this.clearDeleteChord();
        void this.runCell(false);
        break;
    }
  }

  private onDeleteChord(): void {
    if (this.deleteChordTimer) {
      this.deleteActive();
      return;
    }
    this.deleteChordTimer = window.setTimeout(() => {
      this.deleteChordTimer = 0;
      this.refresh();
    }, 1000);
    this.status.setMessage('Press d again to delete the cell.');
  }

  private clearDeleteChord(): void {
    if (!this.deleteChordTimer) return;
    window.clearTimeout(this.deleteChordTimer);
    this.deleteChordTimer = 0;
  }

  private async runCell(advance: boolean): Promise<void> {
    if (this.notebook.empty) return;
    const source = this.notebook.current.source.trim();
    if (!source) return;
    if (this.notebook.busy()) {
      this.status.setMessage('A cell is already running.');
      return;
    }
    const cell = this.notebook.beginRun();
    this.runningCellId = cell.id;
    this.advanceAfterRun = advance;
    this.refresh();
    try {
      if (cell.kind === 'ai') {
        this.session.sendUser(source);
        return;
      }
      const result = await this.session.exec(source);
      this.finishCommandCell(
        cell.id,
        result.output,
        result.returncode === 0 ? 'done' : 'interrupted'
      );
    } catch (error) {
      this.finishCommandCell(cell.id, String(error), 'interrupted');
    }
  }

  private finishCommandCell(
    cellId: string,
    output: string,
    status: 'done' | 'interrupted'
  ): void {
    const index = this.notebook.cells.findIndex(cell => cell.id === cellId);
    if (index >= 0) {
      this.notebook.select(index);
    }
    this.notebook.finishRun(output, status);
    this.completeRun(index >= 0 ? index : undefined);
  }

  private onSessionChange(): void {
    const cellId = this.runningCellId;
    if (cellId) {
      const index = this.notebook.cells.findIndex(cell => cell.id === cellId);
      if (index >= 0) {
        const cell = this.notebook.cells[index];
        if (cell.kind === 'ai') {
          cell.blocks = this.session.blocks;
          if (this.session.error) {
            cell.status = 'interrupted';
          } else if (!this.session.running) {
            cell.status = 'done';
          }
          if (!this.session.running) {
            this.completeRun(index);
            return;
          }
        } else if (cell.status === 'running') {
          cell.output = this.session.execOutput;
        }
      }
    }
    this.refresh();
    if (this.runningCellId) {
      this.persistSoon();
    }
  }

  private completeRun(cellIndex?: number): void {
    this.runningCellId = null;
    if (cellIndex !== undefined) {
      this.notebook.select(cellIndex);
    }
    const shouldAdvance =
      this.advanceAfterRun ||
      this.notebook.active === this.notebook.cells.length - 1;
    this.advanceAfterRun = false;
    this.notebook.ensureTrailingInput();
    if (shouldAdvance) {
      this.notebook.advanceAfterRun();
    }
    this.refresh();
    this.persistNow();
    if (shouldAdvance) {
      this.notebookView.focusActive();
    }
  }

  private applyModel(): void {
    if (!this.context) return;
    const text = this.context.model.toString();
    if (text === serializeNotebook(this.notebook)) return;
    this.applyingModel = true;
    restoreNotebook(this.notebook, text);
    this.applyingModel = false;
    this.refresh();
  }

  private persistSoon(): void {
    if (!this.context || this.applyingModel || this.closing) return;
    if (this.persistTimer) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = 0;
      this.persistNow();
    }, 400);
  }

  private persistNow(): void {
    if (this.persistTimer) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = 0;
    }
    if (
      !this.context ||
      !this.context.isReady ||
      this.applyingModel ||
      this.isDisposed
    ) {
      return;
    }
    const text = serializeNotebook(this.notebook);
    if (text === this.context.model.toString()) return;
    this.applyingModel = true;
    this.context.model.fromString(text);
    this.applyingModel = false;
    void this.context.save().catch(error => {
      console.error(`Agent Workspace not saved: ${error}`);
    });
  }

  private refresh(): void {
    this.cellTypeSwitcher?.update();
    this.notebookView.render();
    if (this.notebook.empty) {
      this.status.setMessage('Click to add a cell.');
      return;
    }
    const kind =
      this.notebook.current.kind === 'ai' ? 'AI cell' : 'Command cell';
    const cwd = this.session.execCwd ? `  •  ${this.session.execCwd}` : '';
    this.status.setMessage(`${kind}${cwd}`);
  }
}

class NotebookView extends Widget {
  private readonly views = new Map<string, CellView>();

  constructor(
    private readonly notebook: WorkspaceNotebook,
    private readonly handlers: CellHandlers
  ) {
    super();
    this.addClass('jp-AgentWorkspace-notebook');
    const footer = document.createElement('button');
    footer.type = 'button';
    footer.className = 'jp-AgentWorkspace-footer jp-Notebook-footer';
    footer.textContent = 'Click to add a cell.';
    footer.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onAddCell();
    });
    this.node.append(footer);
    this.footer = footer;
  }

  private readonly footer: HTMLButtonElement;

  render(): void {
    const seen = new Set<string>();
    this.notebook.cells.forEach((cell, index) => {
      seen.add(cell.id);
      const view = this.views.get(cell.id) ?? this.createView(cell, index);
      view.sync(cell, index, this.notebook);
      if (view.node.parentElement !== this.node) {
        this.node.insertBefore(view.node, this.footer);
      } else if (this.node.children[index] !== view.node) {
        this.node.insertBefore(
          view.node,
          this.node.children[index] ?? this.footer
        );
      }
    });
    this.views.forEach((view, id) => {
      if (seen.has(id)) return;
      view.node.remove();
      this.views.delete(id);
    });
  }

  focusActive(options: { preventScroll?: boolean } = {}): void {
    if (this.notebook.empty) {
      this.footer.focus({ preventScroll: true });
      return;
    }
    const cell = this.notebook.current;
    this.views.get(cell.id)?.focus(options);
  }

  private createView(cell: WorkspaceCell, index: number): CellView {
    const view = new CellView(cell.id, this.handlers);
    this.views.set(cell.id, view);
    view.sync(cell, index, this.notebook);
    return view;
  }
}

class CellView {
  readonly node: HTMLDivElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly inputPrompt: HTMLDivElement;
  private readonly inputKind: HTMLSpanElement;
  private readonly inputCollapser: HTMLDivElement;
  private outputRow: HTMLDivElement | null = null;
  private outputPrompt: HTMLDivElement | null = null;
  private outputBody: HTMLDivElement | null = null;
  private outputCollapser: HTMLDivElement | null = null;
  private outputPlaceholder: OutputPlaceholder | null = null;
  private index = 0;
  private lastOutputKey = '';

  constructor(
    readonly id: string,
    private readonly handlers: CellHandlers
  ) {
    this.node = document.createElement('div');
    this.node.className = 'jp-AgentWorkspace-cell';
    this.node.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.editor.contains(target)) {
        this.handlers.onSelect(this.index);
        return;
      }
      if (this.isCollapser(target)) return;
      this.handlers.onSelect(this.index, { focusEditor: false });
    });

    const inputRow = document.createElement('div');
    inputRow.className = 'jp-AgentWorkspace-row is-input';
    this.inputCollapser = document.createElement('div');
    this.inputCollapser.className = 'jp-AgentWorkspace-collapser';
    this.inputPrompt = document.createElement('div');
    this.inputPrompt.className = 'jp-AgentWorkspace-prompt is-input';
    this.inputKind = document.createElement('span');
    this.inputKind.className = 'jp-AgentWorkspace-kind';
    // CellView has no translator; keep the Lab prompt tooltip as-is.
    this.inputPrompt.title = 'Double-click to switch AI / Command'; // eslint-disable-line jupyter/no-untranslated-string
    this.inputPrompt.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onToggleKind(this.index);
    });
    this.editor = document.createElement('textarea');
    this.editor.className = 'jp-AgentWorkspace-cellInput';
    this.editor.spellcheck = false;
    this.editor.addEventListener('input', () => {
      this.handlers.onSource(this.editor.value);
      this.editor.rows = Math.max(1, this.editor.value.split('\n').length);
    });
    this.editor.addEventListener('focus', () => {
      if (this.node.classList.contains('is-active') && !this.editor.readOnly) {
        return;
      }
      this.handlers.onSelect(this.index);
    });
    inputRow.append(this.inputCollapser, this.inputPrompt, this.editor);
    this.node.append(inputRow);
  }

  sync(cell: WorkspaceCell, index: number, notebook: WorkspaceNotebook): void {
    this.index = index;
    const active = index === notebook.active;
    const editing = active && notebook.mode === 'edit';
    this.node.classList.toggle('is-active', active);
    this.node.classList.toggle('is-edit', editing);
    this.node.classList.toggle('is-ai', cell.kind === 'ai');
    this.node.classList.toggle('is-command', cell.kind === 'command');
    this.node.classList.toggle('is-collapsed', cell.outputCollapsed);
    setPrompt(this.inputPrompt, this.inputKind, cell, 'input');
    if (document.activeElement !== this.editor) {
      this.editor.value = cell.source;
    }
    this.editor.rows = Math.max(1, this.editor.value.split('\n').length);
    this.editor.readOnly = !editing;
    this.syncOutput(cell);
  }

  focus(options: { preventScroll?: boolean } = {}): void {
    if (this.editor.readOnly) return;
    this.editor.focus({ preventScroll: true });
    if (!options.preventScroll) {
      this.editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private syncOutput(cell: WorkspaceCell): void {
    const hasOutput =
      Boolean(cell.output) ||
      cell.blocks.length > 0 ||
      cell.status === 'running';
    if (!hasOutput) {
      this.detachPlaceholder();
      this.outputRow?.remove();
      this.outputRow = null;
      this.outputPrompt = null;
      this.outputBody = null;
      this.outputCollapser = null;
      this.lastOutputKey = '';
      return;
    }
    if (!this.outputRow || !this.outputPrompt || !this.outputBody) {
      const row = document.createElement('div');
      row.className = 'jp-AgentWorkspace-row is-output jp-Cell-outputWrapper';
      const collapser = document.createElement('div');
      collapser.className =
        'jp-AgentWorkspace-collapser jp-Collapser jp-OutputCollapser jp-Cell-outputCollapser';
      this.bindCollapser(collapser);
      const prompt = document.createElement('div');
      prompt.className = 'jp-AgentWorkspace-prompt is-output';
      const body = document.createElement('div');
      body.className = 'jp-AgentWorkspace-cellOutput jp-Cell-outputArea';
      row.append(collapser, prompt, body);
      this.node.append(row);
      this.outputRow = row;
      this.outputPrompt = prompt;
      this.outputBody = body;
      this.outputCollapser = collapser;
    }
    this.outputRow.classList.toggle('is-collapsed', cell.outputCollapsed);
    setPrompt(this.outputPrompt, null, cell, 'output');
    if (cell.outputCollapsed) {
      this.showPlaceholder(cell);
      return;
    }
    this.hidePlaceholder();
    const key = outputKey(cell);
    if (key === this.lastOutputKey) return;
    this.lastOutputKey = key;
    this.outputBody.replaceChildren();
    if (cell.kind === 'ai') {
      if (!cell.blocks.length && cell.status === 'running') {
        this.outputBody.append(pendingNode());
      }
      cell.blocks.forEach(block =>
        this.outputBody!.append(renderBlock(block, this.handlers.rendermime))
      );
    } else if (cell.output) {
      const pre = document.createElement('pre');
      pre.textContent = cell.output;
      this.outputBody.append(pre);
    } else if (cell.status === 'running') {
      this.outputBody.append(pendingNode());
    }
  }

  private bindCollapser(node: HTMLElement): void {
    node.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onToggleCollapse(this.index);
    });
    node.addEventListener('mousedown', event => {
      event.stopPropagation();
    });
  }

  private isCollapser(target: Node): boolean {
    return (
      Boolean(this.outputCollapser?.contains(target)) ||
      Boolean(this.outputPlaceholder?.node.contains(target))
    );
  }

  private showPlaceholder(cell: WorkspaceCell): void {
    if (!this.outputRow || !this.outputBody || !this.outputPrompt) return;
    this.outputPrompt.hidden = true;
    this.outputBody.hidden = true;
    if (!this.outputPlaceholder) {
      this.outputPlaceholder = new OutputPlaceholder({
        callback: event => {
          event.preventDefault();
          event.stopPropagation();
          this.handlers.onToggleCollapse(this.index);
        },
        text: placeholderText(cell)
      });
    } else {
      this.outputPlaceholder.text = placeholderText(cell);
    }
    if (!this.outputPlaceholder.isAttached) {
      Widget.attach(this.outputPlaceholder, this.outputRow);
    }
  }

  private hidePlaceholder(): void {
    if (this.outputPrompt) this.outputPrompt.hidden = false;
    if (this.outputBody) this.outputBody.hidden = false;
    if (this.outputPlaceholder?.isAttached) {
      Widget.detach(this.outputPlaceholder);
    }
  }

  private detachPlaceholder(): void {
    if (this.outputPlaceholder?.isAttached) {
      Widget.detach(this.outputPlaceholder);
    }
    this.outputPlaceholder?.dispose();
    this.outputPlaceholder = null;
  }
}

class StatusBar extends Widget {
  constructor(message: string) {
    super();
    this.addClass('jp-AgentWorkspace-status');
    this.node.setAttribute('role', 'status');
    this.setMessage(message);
  }

  setMessage(message: string): void {
    this.node.textContent = message;
  }
}

function pendingNode(): HTMLElement {
  const pending = document.createElement('div');
  pending.className = 'jp-AgentWorkspace-empty';
  pending.textContent = 'Running…';
  return pending;
}

function setPrompt(
  prompt: HTMLElement,
  kind: HTMLSpanElement | null,
  cell: WorkspaceCell,
  row: 'input' | 'output'
): void {
  const count =
    cell.status === 'running'
      ? '*'
      : cell.executionCount !== null
        ? String(cell.executionCount)
        : ' ';
  prompt.textContent = `[${count}]:`;
  if (row !== 'input') return;
  const tag = kind ?? document.createElement('span');
  tag.className = 'jp-AgentWorkspace-kind';
  tag.textContent = cell.kind === 'ai' ? 'AI' : 'sh';
  prompt.append(tag);
}

function outputKey(cell: WorkspaceCell): string {
  return JSON.stringify({
    kind: cell.kind,
    status: cell.status,
    output: cell.output,
    blocks: cell.blocks
  });
}

function isEditorTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement;
}

function hasTextSelection(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  ) {
    return target.selectionStart !== target.selectionEnd;
  }
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

function placeholderText(cell: WorkspaceCell): string {
  if (cell.kind === 'command') {
    return cell.output.split('\n').find(line => line.trim()) ?? '';
  }
  const text = cell.blocks.find(
    (block): block is Extract<ChatBlock, { kind: 'text' }> =>
      block.kind === 'text' && Boolean(block.text.trim())
  );
  if (text) return text.text.split('\n').find(line => line.trim()) ?? '';
  const first = cell.blocks[0];
  if (!first) return '';
  if (first.kind === 'tool') {
    return formatToolInput(first.name, first.input) || first.name;
  }
  if (first.kind === 'error') return first.message;
  if (first.kind === 'denied') return first.command;
  if (first.kind === 'install') return first.command;
  return first.kind === 'user' ? first.text : '';
}

function blurEditor(): void {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    active.blur();
  }
}

export function renderBlock(
  block: ChatBlock,
  rendermime: IRenderMimeRegistry | null = null
): HTMLElement {
  const node = document.createElement('div');
  node.className = `jp-AgentWorkspace-block is-${block.kind}`;
  switch (block.kind) {
    case 'user':
      node.textContent = block.text;
      break;
    case 'text':
      renderMarkdownSource(node, block.text, rendermime);
      break;
    case 'tool': {
      const title = document.createElement('div');
      title.className = 'jp-AgentWorkspace-toolName';
      title.textContent = `${block.name}  •  ${block.status}`;
      node.append(title);
      const input = formatToolInput(block.name, block.input);
      if (input) {
        const command = document.createElement('pre');
        command.className = 'jp-AgentWorkspace-toolInput';
        command.textContent = input;
        node.append(command);
      }
      if (block.output) {
        const body = document.createElement('pre');
        body.className = 'jp-AgentWorkspace-toolOutput';
        body.textContent = block.output;
        node.append(body);
      }
      break;
    }
    case 'install':
      node.textContent = `install ${block.status}: ${block.command}${
        block.detail ? `\n${block.detail}` : ''
      }`;
      break;
    case 'denied':
      node.textContent = `denied: ${block.command}\n${block.reason}`;
      break;
    case 'error':
      node.textContent = block.message;
      break;
  }
  return node;
}
