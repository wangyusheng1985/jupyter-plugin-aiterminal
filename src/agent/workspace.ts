import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Message } from '@lumino/messaging';
import { Panel, Widget } from '@lumino/widgets';

import { AGENT_PANEL_CLASS, ShutdownCoordinator } from '../theme';
import { restoreNotebook, serializeNotebook } from './document';
import { WorkspaceInputHistory, type HistoryNavigation } from './history';
import { InputHistoryStorage } from './history-storage';
import { mapHistoryKey, mapWorkspaceKey, strokeFromEvent } from './keys';
import { renderMarkdownSource } from './markdown';
import { WorkspaceNotebook, type WorkspaceCell } from './notebook';
import { AgentSession } from './session';
import { SelectionCopyButton } from './selectioncopy';
import { formatToolInput } from './tool';
import type { AgentToolbarHost } from './toolbar';
import type { ChatBlock } from './protocol';

export interface SourceChangeOptions {
  fromHistory?: boolean;
}

export interface CellHandlers {
  onSource: (source: string, options?: SourceChangeOptions) => void;
  onSelect: (index: number, options?: { focusEditor?: boolean }) => void;
  onToggleCollapse: (index: number) => void;
  onAddCell: () => void;
  onHistoryPrevious: (draft: string) => HistoryNavigation | null;
  onHistoryNext: () => HistoryNavigation | null;
  onHistoryReset: () => void;
  rendermime: IRenderMimeRegistry | null;
}

export class AgentWorkspaceContent extends Panel implements AgentToolbarHost {
  readonly notebook = new WorkspaceNotebook();
  readonly session: AgentSession;
  readonly inputHistory = new WorkspaceInputHistory();
  private closing = false;
  private aiInterruptRequested = false;
  private readonly shutdown = new ShutdownCoordinator();
  private readonly notebookView: NotebookView;
  private readonly status: StatusBar;
  private context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel> | null =
    null;
  private historyPath: string | null = null;
  private applyingModel = false;
  private persistTimer = 0;
  private deleteChordTimer = 0;
  private readonly copyButton: SelectionCopyButton;

  constructor(
    private readonly rendermime: IRenderMimeRegistry | null = null,
    cwd?: string,
    private readonly historyStorage = new InputHistoryStorage()
  ) {
    super();
    this.session = new AgentSession(undefined, cwd);
    this.addClass(AGENT_PANEL_CLASS);
    this.notebookView = new NotebookView(this.notebook, {
      onSource: (source, options) => {
        if (!options?.fromHistory) {
          this.inputHistory.resetNavigation();
        }
        this.notebook.setSource(source);
        this.persistSoon();
      },
      onSelect: (index, options) => this.selectCell(index, options),
      onToggleCollapse: index => this.toggleOutputCollapsed(index),
      onAddCell: () => this.addCellFromFooter(),
      onHistoryPrevious: draft => this.inputHistory.previous(draft),
      onHistoryNext: () => this.inputHistory.next(),
      onHistoryReset: () => this.inputHistory.resetNavigation(),
      rendermime: this.rendermime
    });
    this.status = new StatusBar('Local tools');
    this.addWidget(this.notebookView);
    this.addWidget(this.status);
    this.node.tabIndex = -1;
    this.copyButton = new SelectionCopyButton(this.node);
    this.node.addEventListener('keydown', event => this.onKey(event), true);
    this.session.subscribe(() => this.onSessionChange());
    this.refresh();
    this.start();
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
      this.historyPath = context.path;
      this.inputHistory.restore(this.historyStorage.load(context.path));
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

  insertAbove(): void {
    this.inputHistory.resetNavigation();
    this.notebook.insertAbove();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  insertBelow(): void {
    this.inputHistory.resetNavigation();
    this.notebook.insertBelow();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  addCellFromFooter(): void {
    this.clearDeleteChord();
    this.inputHistory.resetNavigation();
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
    this.inputHistory.resetNavigation();
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
    this.runCell(true);
  }

  interrupt(): void {
    const request = this.notebook.activeRun;
    if (request?.kind === 'ai') {
      this.aiInterruptRequested = true;
      this.session.interrupt();
      return;
    }
    if (request?.kind === 'command') {
      this.session.interruptExec();
    }
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
    this.inputHistory.resetNavigation();
    this.notebook.clearRuns();
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
    this.inputHistory.resetNavigation();
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
        this.runCell(true);
        break;
      case 'run-stay':
        this.clearDeleteChord();
        this.runCell(false);
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

  private runCell(advance: boolean): void {
    if (this.notebook.empty) return;
    const request = this.notebook.enqueueRun(this.notebook.active, advance);
    if (!request) return;
    if (this.inputHistory.add(request.source)) {
      this.saveInputHistory();
    }
    this.notebook.ensureTrailingInput();
    this.refresh();
    this.persistSoon();
    if (advance) {
      this.notebook.advanceAfterRun();
      this.refresh();
      this.notebookView.focusActive();
    }
    this.drainQueue();
  }

  private drainQueue(): void {
    const request = this.notebook.promoteNextRun();
    if (!request) {
      this.refresh();
      return;
    }
    this.refresh();
    if (request.kind === 'ai') {
      this.session.sendUser(request.source);
      return;
    }
    void this.session
      .exec(request.executionSource)
      .then(result => {
        this.finishRun(
          request.id,
          result.output,
          result.returncode === 0 ? 'done' : 'interrupted'
        );
      })
      .catch(error => {
        this.finishRun(request.id, String(error), 'interrupted');
      });
  }

  private finishRun(
    requestId: string,
    output: string,
    status: 'done' | 'interrupted'
  ): void {
    if (!this.notebook.finishRun(requestId, output, status)) return;
    this.aiInterruptRequested = false;
    this.refresh();
    this.persistNow();
    this.drainQueue();
  }

  private onSessionChange(): void {
    const request = this.notebook.activeRun;
    if (request) {
      const index = this.notebook.cells.findIndex(
        cell => cell.id === request.cellId
      );
      if (index >= 0) {
        const cell = this.notebook.cells[index];
        if (request.kind === 'ai') {
          cell.blocks = this.session.blocks;
          if (!this.session.running) {
            cell.status =
              this.session.error ||
              this.aiInterruptRequested ||
              !this.session.connected
                ? 'interrupted'
                : 'done';
            this.finishRun(
              request.id,
              '',
              cell.status === 'interrupted' ? 'interrupted' : 'done'
            );
            return;
          }
        } else if (cell.status === 'running') {
          cell.output = this.session.execOutput;
        }
      }
    }
    this.refresh();
    if (this.notebook.activeRun) {
      this.persistSoon();
    }
  }

  private applyModel(): void {
    if (!this.context) return;
    const text = this.context.model.toString();
    if (text === serializeNotebook(this.notebook)) return;
    this.inputHistory.resetNavigation();
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

  private saveInputHistory(): void {
    if (!this.historyPath) return;
    this.historyStorage.save(this.historyPath, this.inputHistory.values);
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
    this.notebookView.render();
    if (this.notebook.empty) {
      this.status.setMessage('Click to add a cell.');
      return;
    }
    const cwd = this.session.execCwd;
    this.status.setMessage(cwd ? `Local tools  •  ${cwd}` : 'Local tools');
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

export class CellView {
  readonly node: HTMLDivElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly inputPrompt: HTMLDivElement;
  private readonly inputCollapser: HTMLDivElement;
  private outputRow: HTMLDivElement | null = null;
  private outputPrompt: HTMLDivElement | null = null;
  private outputBody: HTMLDivElement | null = null;
  private outputCollapser: HTMLDivElement | null = null;
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
      if (
        this.outputBody?.contains(target) &&
        this.outputRow?.classList.contains('is-collapsed')
      ) {
        return;
      }
      this.handlers.onSelect(this.index, { focusEditor: false });
    });

    const inputRow = document.createElement('div');
    inputRow.className = 'jp-AgentWorkspace-row is-input';
    this.inputCollapser = document.createElement('div');
    this.inputCollapser.className = 'jp-AgentWorkspace-collapser';
    this.inputPrompt = document.createElement('div');
    this.inputPrompt.className = 'jp-AgentWorkspace-prompt is-input';
    this.editor = document.createElement('textarea');
    this.editor.className = 'jp-AgentWorkspace-cellInput';
    this.editor.spellcheck = false;
    this.editor.addEventListener('input', () => {
      this.handlers.onSource(this.editor.value);
      this.editor.rows = Math.max(1, this.editor.value.split('\n').length);
    });
    this.editor.addEventListener('keydown', event => this.onEditorKey(event));
    this.editor.addEventListener('blur', () => {
      this.handlers.onHistoryReset();
    });
    this.editor.addEventListener('select', () => {
      if (this.editor.selectionStart !== this.editor.selectionEnd) {
        this.handlers.onHistoryReset();
      }
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
    this.node.classList.toggle('is-collapsed', cell.outputCollapsed);
    setPrompt(this.inputPrompt, cell);
    if (document.activeElement !== this.editor) {
      this.editor.value = cell.source;
    }
    this.editor.rows = Math.max(1, this.editor.value.split('\n').length);
    this.editor.readOnly = !editing;
    if (!editing) {
      this.handlers.onHistoryReset();
    }
    this.syncOutput(cell);
  }

  focus(options: { preventScroll?: boolean } = {}): void {
    if (this.editor.readOnly) return;
    this.editor.focus({ preventScroll: true });
    if (!options.preventScroll) {
      this.editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private onEditorKey(event: KeyboardEvent): void {
    const action = mapHistoryKey(strokeFromEvent(event), {
      editable: !this.editor.readOnly,
      value: this.editor.value,
      selectionStart: this.editor.selectionStart,
      selectionEnd: this.editor.selectionEnd
    });
    if (!action) return;
    const navigation =
      action.type === 'history-previous'
        ? this.handlers.onHistoryPrevious(this.editor.value)
        : this.handlers.onHistoryNext();
    if (!navigation) return;
    event.preventDefault();
    event.stopPropagation();
    this.editor.value = navigation.source;
    this.editor.rows = Math.max(1, navigation.source.split('\n').length);
    this.handlers.onSource(navigation.source, { fromHistory: true });
    this.editor.setSelectionRange(
      navigation.source.length,
      navigation.source.length
    );
  }

  private syncOutput(cell: WorkspaceCell): void {
    const hasOutput =
      Boolean(cell.output) ||
      cell.blocks.length > 0 ||
      cell.status === 'queued' ||
      cell.status === 'running';
    if (!hasOutput) {
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
      body.tabIndex = -1;
      row.append(collapser, prompt, body);
      this.node.append(row);
      this.outputRow = row;
      this.outputPrompt = prompt;
      this.outputBody = body;
      this.outputCollapser = collapser;
    }
    this.outputRow.classList.toggle('is-collapsed', cell.outputCollapsed);
    this.outputBody.tabIndex = cell.outputCollapsed ? 0 : -1;
    setPrompt(this.outputPrompt, cell);
    const key = outputKey(cell);
    if (key === this.lastOutputKey) return;
    this.lastOutputKey = key;
    renderCellOutputPreservingScroll(
      this.outputBody,
      cell,
      this.handlers.rendermime
    );
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
    return Boolean(this.outputCollapser?.contains(target));
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

export function runningIndicatorNode(): HTMLElement {
  const indicator = document.createElement('span');
  indicator.className = 'jp-AgentWorkspace-runningIndicator';
  indicator.textContent = '...';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.setAttribute('role', 'presentation');
  return indicator;
}

export function renderCellOutput(
  body: HTMLElement,
  cell: WorkspaceCell,
  rendermime: IRenderMimeRegistry | null = null
): void {
  body.replaceChildren();
  if (cell.kind === 'ai') {
    cell.blocks.forEach(block => body.append(renderBlock(block, rendermime)));
  } else if (cell.output) {
    const pre = document.createElement('pre');
    pre.textContent = cell.output;
    body.append(pre);
  }
  if (cell.status === 'running') {
    body.append(runningIndicatorNode());
  }
}

export function renderCellOutputPreservingScroll(
  body: HTMLElement,
  cell: WorkspaceCell,
  rendermime: IRenderMimeRegistry | null = null
): void {
  const scrollTop = body.scrollTop;
  renderCellOutput(body, cell, rendermime);
  body.scrollTop = scrollTop;
}

function setPrompt(prompt: HTMLElement, cell: WorkspaceCell): void {
  const count =
    cell.status === 'queued' || cell.status === 'running'
      ? '*'
      : cell.executionCount !== null
        ? String(cell.executionCount)
        : ' ';
  prompt.textContent = `[${count}]:`;
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
      if (block.code === 'config') {
        node.classList.add('is-config');
      }
      node.textContent = block.message;
      break;
  }
  return node;
}
