import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Message } from '@lumino/messaging';
import { Panel, Widget } from '@lumino/widgets';

import { AGENT_PANEL_CLASS, ShutdownCoordinator } from '../theme';
import {
  normalizeAgentSessionId,
  restoreNotebook,
  serializeNotebook
} from './document';
import { WorkspaceInputHistory, type HistoryNavigation } from './history';
import {
  buildHistoryBridge,
  projectContextMembership,
  type HistoryBridgeCapsule
} from './history-bridge';
import { InputHistoryStorage } from './history-storage';
import { mapHistoryKey, mapWorkspaceKey, strokeFromEvent } from './keys';
import { renderMarkdownSource } from './markdown';
import { CellNavigatorView } from './navigator';
import {
  isShellEscapeSource,
  WorkspaceNotebook,
  type RunRequest,
  type WorkspaceCell
} from './notebook';
import { AgentSession } from './session';
import { WorkspaceSaveCoordinator } from './save-coordinator';
import { SelectionCopyButton } from './selectioncopy';
import { formatToolInput } from './tool';
import type { AgentToolbarHost } from './toolbar';
import type { ChatBlock } from './protocol';
import { renderTurn, type TurnRenderHandlers } from './turn-renderer';
import {
  createTurn,
  deriveTurn,
  revealFailedActivity,
  setTurnStatus,
  toggleActivity,
  toggleEvidence,
  toggleOutcome,
  toggleTrace,
  type ChatTurn
} from './turn';
import {
  INACTIVE_FOLLOW_STATE,
  detachFollow,
  navigationEntries,
  resumeFollow,
  shouldFollowUpdate,
  syncFollowRequest,
  workspaceUiState,
  workspaceUiStateKey,
  workspaceOverview,
  type FollowState,
  type WorkspaceOverview,
  type WorkspaceUiState
} from './workspace-interaction';

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
  onToggleTurnTrace?: (cellId: string, turnId: string) => void;
  onToggleTurnActivity?: (
    cellId: string,
    turnId: string,
    activityId: string
  ) => void;
  onToggleTurnEvidence?: (
    cellId: string,
    turnId: string,
    activityId: string
  ) => void;
  onToggleTurnOutcome?: (cellId: string, turnId: string) => void;
  onRevealTurnFailure?: (
    cellId: string,
    turnId: string,
    activityId: string
  ) => void;
  onRetryTurn?: (cellId: string, turnId: string) => void;
  rendermime: IRenderMimeRegistry | null;
}

interface PendingContextSubmission {
  cellId: string;
  source: string;
  advance: boolean;
}

type HistoryChoiceReason = 'uncovered' | 'unavailable';

export class AgentWorkspaceContent extends Panel implements AgentToolbarHost {
  readonly notebook = new WorkspaceNotebook();
  readonly session: AgentSession;
  readonly inputHistory = new WorkspaceInputHistory();
  private closing = false;
  private aiInterruptRequested = false;
  private readonly shutdown = new ShutdownCoordinator();
  private readonly notebookView: NotebookView;
  private readonly body: Panel;
  private readonly navigatorView: CellNavigatorView;
  private readonly status: StatusBar;
  private readonly returnLatestButton: HTMLButtonElement;
  private context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel> | null =
    null;
  private historyPath: string | null = null;
  private applyingModel = false;
  private deleteChordTimer = 0;
  private readonly copyButton: SelectionCopyButton;
  private followState: FollowState = INACTIVE_FOLLOW_STATE;
  private viewportCellId: string | null = null;
  private readonly uiListeners = new Set<(state: WorkspaceUiState) => void>();
  private lastUiStateKey = '';
  private viewportObserver: IntersectionObserver | null = null;
  private readonly observedCells = new Map<string, HTMLElement>();
  private readonly intersectingCells = new Set<string>();
  private viewportFrame = 0;
  private userScrollIntent = false;
  private pendingContextSubmission: PendingContextSubmission | null = null;
  private pendingContextAcceptance: Pick<RunRequest, 'id' | 'cellId'> | null =
    null;
  private readonly saveCoordinator: WorkspaceSaveCoordinator;

  constructor(
    private readonly rendermime: IRenderMimeRegistry | null = null,
    cwd?: string,
    private readonly historyStorage = new InputHistoryStorage()
  ) {
    super();
    this.session = new AgentSession(undefined, cwd);
    this.saveCoordinator = new WorkspaceSaveCoordinator({
      synchronize: () => this.synchronizeDocumentModel(),
      save: () => this.saveDocument(),
      onStateChange: () => this.onSaveStateChange()
    });
    this.addClass(AGENT_PANEL_CLASS);
    this.notebookView = new NotebookView(this.notebook, {
      onSource: (source, options) => {
        if (!options?.fromHistory) {
          this.inputHistory.resetNavigation();
        }
        this.notebook.setSource(source);
        const pending = this.pendingContextSubmission;
        if (
          pending?.cellId === this.notebook.current.id &&
          pending.source !== source.trim()
        ) {
          this.cancelContextChoice(false);
        }
        this.persistSoon();
      },
      onSelect: (index, options) => this.selectCell(index, options),
      onToggleCollapse: index => this.toggleOutputCollapsed(index),
      onAddCell: () => this.addCellFromFooter(),
      onHistoryPrevious: draft => this.inputHistory.previous(draft),
      onHistoryNext: () => this.inputHistory.next(),
      onHistoryReset: () => this.inputHistory.resetNavigation(),
      onToggleTurnTrace: (cellId, turnId) =>
        this.updateTurn(cellId, turnId, toggleTrace),
      onToggleTurnActivity: (cellId, turnId, activityId) =>
        this.updateTurn(cellId, turnId, turn =>
          toggleActivity(turn, activityId)
        ),
      onToggleTurnEvidence: (cellId, turnId, activityId) =>
        this.updateTurn(cellId, turnId, turn =>
          toggleEvidence(turn, activityId)
        ),
      onToggleTurnOutcome: (cellId, turnId) =>
        this.updateTurn(cellId, turnId, toggleOutcome),
      onRevealTurnFailure: (cellId, turnId, activityId) =>
        this.revealTurnFailure(cellId, turnId, activityId),
      onRetryTurn: (cellId, turnId) => this.prepareRetry(cellId, turnId),
      rendermime: this.rendermime
    });
    this.navigatorView = new CellNavigatorView({
      onActivate: cellId => this.navigateToCell(cellId)
    });
    this.body = new Panel();
    this.body.addClass('jp-AgentWorkspace-body');
    this.body.addWidget(this.notebookView);
    this.body.addWidget(this.navigatorView);
    this.returnLatestButton = document.createElement('button');
    this.returnLatestButton.type = 'button';
    this.returnLatestButton.className = 'jp-AgentWorkspace-returnLatest';
    this.returnLatestButton.textContent = 'Return to latest';
    this.returnLatestButton.hidden = true;
    this.returnLatestButton.addEventListener('click', () => {
      this.followState = resumeFollow(this.followState);
      const cellId = this.notebook.activeRun?.cellId;
      if (cellId) this.notebookView.revealOutputTail(cellId);
      this.refresh();
    });
    this.body.node.append(this.returnLatestButton);
    this.status = new StatusBar({
      onStartNewContext: () => this.startNewContext(),
      onContinueFromHistory: () => this.resolveContextChoice('bridge'),
      onStartEmptyContext: () => this.resolveContextChoice('empty'),
      onDismissContextChoice: () => this.cancelContextChoice(true),
      onRevealFailure: cellId => this.navigateToCell(cellId),
      onRevealInterrupted: cellId => this.navigateToCell(cellId),
      onOpenHistory: () => this.navigatorView.openHistory(),
      onRetrySave: () => {
        void this.saveCoordinator.retry().catch(() => undefined);
      }
    });
    this.addWidget(this.body);
    this.addWidget(this.status);
    this.node.tabIndex = -1;
    this.copyButton = new SelectionCopyButton(this.node);
    this.node.addEventListener('keydown', event => this.onKey(event), true);
    this.notebookView.node.addEventListener('scroll', this.onNotebookScroll, {
      passive: true
    });
    this.notebookView.node.addEventListener(
      'wheel',
      this.markUserScrollIntent,
      {
        passive: true
      }
    );
    this.notebookView.node.addEventListener(
      'touchstart',
      this.markUserScrollIntent,
      { passive: true }
    );
    this.notebookView.node.addEventListener(
      'pointerdown',
      this.markUserScrollIntent,
      { passive: true }
    );
    this.notebookView.node.addEventListener(
      'keydown',
      this.onNotebookScrollKey,
      true
    );
    this.createViewportObserver();
    this.session.subscribe(() => this.onSessionChange());
    this.refresh();
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

  get uiState(): WorkspaceUiState {
    const selectedCellId = this.notebook.empty
      ? null
      : this.notebook.current.id;
    const activeRun = this.notebook.activeRun;
    const membership = this.contextMembership();
    return workspaceUiState({
      connected: this.session.connected,
      error: this.session.error,
      cwd: this.session.execCwd,
      selectedCellId,
      activeRun: activeRun
        ? { id: activeRun.id, cellId: activeRun.cellId }
        : null,
      queueCount: this.notebook.queuedRuns.length,
      contextState: this.session.contextState,
      contextNativeCount: membership.nativeCount,
      contextBridgedCount: membership.bridgedCount,
      contextOutsideCount: membership.outsideCount,
      savePhase: this.saveCoordinator.state.phase
    });
  }

  subscribeUiState(listener: (state: WorkspaceUiState) => void): () => void {
    this.uiListeners.add(listener);
    listener(this.uiState);
    return () => this.uiListeners.delete(listener);
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
      this.session.configureContext(this.notebook.agentSessionId);
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
    if (this.pendingContextSubmission?.cellId === this.notebook.current.id) {
      this.cancelContextChoice(false);
    }
    if (this.pendingContextAcceptance?.cellId === this.notebook.current.id) {
      this.pendingContextAcceptance = null;
      this.status.closeHistoryChoice();
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
      try {
        await this.saveCoordinator.flush();
      } catch (error) {
        console.error(`Agent Workspace not saved during shutdown: ${error}`);
      } finally {
        this.session.close();
      }
    });
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.closing = true;
    this.clearDeleteChord();
    this.copyButton.dispose();
    this.inputHistory.resetNavigation();
    const hadPendingRuns =
      this.notebook.busy() || this.notebook.queuedRuns.length > 0;
    this.notebook.clearRuns();
    this.viewportObserver?.disconnect();
    this.viewportObserver = null;
    this.notebookView.node.removeEventListener('scroll', this.onNotebookScroll);
    this.notebookView.node.removeEventListener(
      'wheel',
      this.markUserScrollIntent
    );
    this.notebookView.node.removeEventListener(
      'touchstart',
      this.markUserScrollIntent
    );
    this.notebookView.node.removeEventListener(
      'pointerdown',
      this.markUserScrollIntent
    );
    this.notebookView.node.removeEventListener(
      'keydown',
      this.onNotebookScrollKey,
      true
    );
    if (this.viewportFrame) {
      window.cancelAnimationFrame(this.viewportFrame);
      this.viewportFrame = 0;
    }
    this.uiListeners.clear();
    if (hadPendingRuns) this.persistNow();
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
    const activeRunCellId = this.notebook.activeRun?.cellId;
    if (activeRunCellId && this.notebook.current.id !== activeRunCellId) {
      this.followState = detachFollow(this.followState);
    }
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

  private updateTurn(
    cellId: string,
    turnId: string,
    update: (turn: ChatTurn) => ChatTurn
  ): void {
    const cell = this.notebook.cells.find(candidate => candidate.id === cellId);
    if (!cell) return;
    const turn = cell.turn ?? turnForCell(cell);
    if (!turn || turn.id !== turnId) return;
    cell.turn = update(turn);
    this.refresh();
    this.persistSoon();
  }

  private revealTurnFailure(
    cellId: string,
    turnId: string,
    activityId: string
  ): void {
    const cell = this.notebook.cells.find(candidate => candidate.id === cellId);
    if (!cell) return;
    const turn = cell.turn ?? turnForCell(cell);
    if (!turn || turn.id !== turnId) return;
    cell.turn = revealFailedActivity(turn, activityId);
    this.refresh();
    this.persistSoon();
    this.notebookView.revealTurnActivity(cellId, activityId);
  }

  private prepareRetry(cellId: string, turnId: string): void {
    const index = this.notebook.cells.findIndex(cell => cell.id === cellId);
    if (index < 0) return;
    const source = this.notebook.cells[index];
    const turn = source.turn ?? turnForCell(source);
    if (!turn || turn.id !== turnId) return;
    const retry = this.notebook.prepareRetry(index);
    if (!retry) return;
    this.inputHistory.resetNavigation();
    this.refresh();
    this.persistNow();
    this.notebookView.focusActive();
  }

  private onKey(event: KeyboardEvent): void {
    if (
      event.target instanceof Node &&
      this.status.node.contains(event.target)
    ) {
      return;
    }
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
    const source = this.notebook.current.source.trim();
    if (source && !isShellEscapeSource(source)) {
      const membership = this.contextMembership();
      const visibleAiCount =
        membership.nativeCount +
        membership.bridgedCount +
        membership.outsideCount;
      const unavailable = this.session.contextState === 'unavailable';
      const choiceCount = unavailable
        ? visibleAiCount
        : membership.outsideCount;
      if (choiceCount > 0 && (unavailable || !membership.policyChosen)) {
        this.pendingContextSubmission = {
          cellId: this.notebook.current.id,
          source,
          advance
        };
        this.status.openHistoryChoice(
          choiceCount,
          unavailable ? 'unavailable' : 'uncovered'
        );
        return;
      }
      if (unavailable) {
        this.status.setMessage(
          'Start a new context before continuing with an AI request.'
        );
        return;
      }
    }
    this.acceptRun(this.notebook.active, advance);
  }

  private acceptRun(
    index: number,
    advance: boolean,
    historyBridge?: HistoryBridgeCapsule
  ): RunRequest | null {
    this.notebook.select(index);
    const request = this.notebook.enqueueRun(index, advance, historyBridge);
    if (!request) return null;
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
    return request;
  }

  private contextMembership() {
    return projectContextMembership(
      this.notebook.cells,
      this.notebook.agentContextGeneration,
      this.notebook.agentContextBridges
    );
  }

  private currentNavigationEntries() {
    const membership = this.contextMembership();
    const membershipByCellId = new Map(
      membership.entries.map(entry => [entry.cellId, entry.membership])
    );
    return navigationEntries(
      this.notebook.cells,
      this.notebook.active,
      membershipByCellId
    );
  }

  private resolveContextChoice(mode: 'bridge' | 'empty'): void {
    const pending = this.pendingContextSubmission;
    if (!pending) return;
    this.pendingContextSubmission = null;
    const index = this.notebook.cells.findIndex(
      cell => cell.id === pending.cellId
    );
    const cell = this.notebook.cells[index];
    if (
      index < 0 ||
      !cell ||
      cell.status === 'queued' ||
      cell.status === 'running' ||
      cell.source.trim() !== pending.source
    ) {
      this.status.closeHistoryChoice();
      return;
    }

    let historyBridge: HistoryBridgeCapsule | undefined;
    if (mode === 'bridge') {
      historyBridge =
        buildHistoryBridge(this.notebook.cells, pending.cellId) ?? undefined;
      if (this.session.contextState === 'unavailable') {
        this.notebook.startNewAgentContext(null);
        this.session.resetContext();
      }
    } else if (
      this.notebook.agentSessionId ||
      this.session.contextState === 'live' ||
      this.session.contextState === 'resumed' ||
      this.session.contextState === 'unavailable'
    ) {
      this.notebook.startNewAgentContext();
      this.session.resetContext();
    } else {
      this.notebook.setAgentContextBridge([]);
    }

    const request = this.acceptRun(index, pending.advance, historyBridge);
    if (!request) {
      this.status.closeHistoryChoice();
      return;
    }
    this.pendingContextAcceptance = {
      id: request.id,
      cellId: request.cellId
    };
  }

  private cancelContextChoice(focusDraft: boolean): void {
    if (this.pendingContextAcceptance) return;
    const pending = this.pendingContextSubmission;
    this.pendingContextSubmission = null;
    this.status.closeHistoryChoice();
    if (!focusDraft || !pending) return;
    const index = this.notebook.cells.findIndex(
      cell => cell.id === pending.cellId
    );
    if (index < 0) return;
    this.selectCell(index, { focusEditor: true });
  }

  private drainQueue(): void {
    const request = this.notebook.promoteNextRun();
    if (!request) {
      this.followState = syncFollowRequest(this.followState, null);
      this.refresh();
      return;
    }
    this.followState = syncFollowRequest(this.followState, request.id);
    this.refresh();
    if (request.kind === 'ai') {
      if (request.historyBridge) {
        this.session.sendUser(
          request.source,
          request.id,
          request.historyBridge
        );
      } else {
        this.session.sendUser(request.source, request.id);
      }
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
    this.followState = syncFollowRequest(this.followState, null);
    this.refresh();
    this.persistNow();
    this.drainQueue();
  }

  private onSessionChange(): void {
    const request = this.notebook.activeRun;
    const requestAccepted = Boolean(
      request && this.session.acceptedTurnId === request.id
    );
    const confirmedSessionId =
      this.session.contextState === 'live' || requestAccepted
        ? normalizeAgentSessionId(this.session.sessionId)
        : null;
    if (
      confirmedSessionId &&
      confirmedSessionId !== this.notebook.agentSessionId
    ) {
      this.notebook.agentSessionId = confirmedSessionId;
      this.persistSoon();
    }
    if (request && requestAccepted) {
      if (this.notebook.commitRunContext(request.id)) {
        this.persistSoon();
      }
      if (this.pendingContextAcceptance?.id === request.id) {
        this.finishContextAcceptance(request);
      }
    }
    const followOutput = request
      ? shouldFollowUpdate(
          this.followState,
          request.id,
          this.notebookView.isOutputTailNearViewport(request.cellId),
          this.notebookView.isEditingAnotherCell(request.cellId)
        )
      : false;
    if (request) {
      const index = this.notebook.cells.findIndex(
        cell => cell.id === request.cellId
      );
      if (index >= 0) {
        const cell = this.notebook.cells[index];
        if (request.kind === 'ai') {
          cell.blocks = this.session.blocks;
          cell.turn =
            this.session.turn ??
            deriveTurn(createTurn(request.id), this.session.blocks);
          if (!this.session.running) {
            if (this.pendingContextAcceptance?.id === request.id) {
              this.finishContextAcceptance(request);
            }
            cell.status =
              this.session.error ||
              this.aiInterruptRequested ||
              !this.session.connected
                ? 'interrupted'
                : 'done';
            cell.turn = setTurnStatus(
              cell.turn,
              cell.status === 'interrupted' ? 'interrupted' : 'done',
              cell.blocks
            );
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
    if (followOutput && request) {
      queueMicrotask(() => this.notebookView.revealOutputTail(request.cellId));
    }
    if (this.notebook.activeRun) {
      this.persistSoon();
    }
  }

  private finishContextAcceptance(
    request: Pick<RunRequest, 'id' | 'cellId'>
  ): void {
    const restoreFocus = this.status.containsFocus();
    this.pendingContextAcceptance = null;
    this.status.closeHistoryChoice();
    if (!restoreFocus || this.notebook.current.id !== request.cellId) return;
    queueMicrotask(() => {
      if (this.isDisposed || this.notebook.current.id !== request.cellId)
        return;
      this.notebookView.focusActive({ preventScroll: true });
    });
  }

  private applyModel(): void {
    if (!this.context) return;
    const text = this.context.model.toString();
    if (text === serializeNotebook(this.notebook)) {
      this.saveCoordinator.acceptExternalSavedState();
      return;
    }
    if (!this.saveCoordinator.acceptExternalSavedState()) return;
    this.inputHistory.resetNavigation();
    this.applyingModel = true;
    restoreNotebook(this.notebook, text);
    this.applyingModel = false;
    this.refresh();
  }

  private persistSoon(): void {
    if (!this.context || this.applyingModel || this.closing) return;
    this.saveCoordinator.markDirty();
  }

  private saveInputHistory(): void {
    if (!this.historyPath) return;
    this.historyStorage.save(this.historyPath, this.inputHistory.values);
  }

  private persistNow(): void {
    if (
      !this.context ||
      !this.context.isReady ||
      this.applyingModel ||
      this.isDisposed
    ) {
      return;
    }
    this.saveCoordinator.markDirty({ immediate: true });
  }

  private synchronizeDocumentModel(): void {
    const context = this.context;
    if (!context || !context.isReady) {
      throw new Error('Workspace document is not ready to save.');
    }
    const text = serializeNotebook(this.notebook);
    if (text === context.model.toString()) return;
    this.applyingModel = true;
    try {
      context.model.fromString(text);
    } finally {
      this.applyingModel = false;
    }
  }

  private async saveDocument(): Promise<void> {
    const context = this.context;
    if (!context || !context.isReady) {
      throw new Error('Workspace document is not ready to save.');
    }
    await context.save();
  }

  private onSaveStateChange(): void {
    if (this.isDisposed) return;
    this.syncWorkspaceChrome();
  }

  private refresh(): void {
    this.notebookView.render();
    if (!this.viewportCellId && !this.notebook.empty) {
      this.viewportCellId = this.notebook.current.id;
    }
    this.navigatorView.render(
      this.currentNavigationEntries(),
      this.viewportCellId
    );
    this.syncViewportObservation();
    this.returnLatestButton.hidden =
      this.followState.mode !== 'detached' || !this.notebook.activeRun;
    this.syncWorkspaceChrome();
  }

  private syncWorkspaceChrome(): void {
    const state = this.uiState;
    this.status.sync(state, workspaceOverview(this.notebook.cells));
    this.notifyUiState(state);
  }

  private notifyUiState(state: WorkspaceUiState): void {
    const key = workspaceUiStateKey(state);
    if (key === this.lastUiStateKey) return;
    this.lastUiStateKey = key;
    this.uiListeners.forEach(listener => listener(state));
  }

  private startNewContext(): void {
    if (this.notebook.activeRun) return;
    this.notebook.startNewAgentContext();
    this.session.resetContext();
    this.persistNow();
    this.refresh();
  }

  private navigateToCell(cellId: string): void {
    const index = this.notebook.cells.findIndex(cell => cell.id === cellId);
    if (index < 0) return;
    this.selectCell(index, { focusEditor: false });
    this.notebookView.revealCell(cellId, {
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
  }

  private createViewportObserver(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    this.viewportObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const cellId = (entry.target as HTMLElement).dataset.cellId;
          if (!cellId) return;
          if (entry.isIntersecting) {
            this.intersectingCells.add(cellId);
          } else {
            this.intersectingCells.delete(cellId);
          }
        });
        this.updateViewportCell(this.intersectingCells);
      },
      {
        root: this.notebookView.node,
        threshold: [0, 0.25, 0.5, 0.75, 1]
      }
    );
  }

  private syncViewportObservation(): void {
    if (!this.viewportObserver) return;
    const cells = new Map(
      this.notebookView
        .cellElements()
        .map(node => [node.dataset.cellId as string, node])
    );
    this.observedCells.forEach((node, id) => {
      if (cells.get(id) === node) return;
      this.viewportObserver?.unobserve(node);
      this.observedCells.delete(id);
      this.intersectingCells.delete(id);
    });
    cells.forEach((node, id) => {
      if (this.observedCells.get(id) === node) return;
      this.observedCells.set(id, node);
      this.viewportObserver?.observe(node);
    });
  }

  private readonly onNotebookScroll = (): void => {
    const request = this.notebook.activeRun;
    if (
      request &&
      this.followState.mode === 'following' &&
      this.userScrollIntent &&
      !this.notebookView.isOutputTailNearViewport(request.cellId)
    ) {
      this.followState = detachFollow(this.followState);
      this.returnLatestButton.hidden = false;
    }
    this.userScrollIntent = false;
    if (this.viewportObserver || this.viewportFrame) return;
    this.viewportFrame = window.requestAnimationFrame(() => {
      this.viewportFrame = 0;
      this.updateViewportCell(
        new Set(
          this.notebookView
            .cellElements()
            .map(node => node.dataset.cellId ?? '')
        )
      );
    });
  };

  private readonly markUserScrollIntent = (): void => {
    this.userScrollIntent = true;
  };

  private readonly onNotebookScrollKey = (event: KeyboardEvent): void => {
    if (
      event.key === 'PageUp' ||
      event.key === 'PageDown' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      this.markUserScrollIntent();
    }
  };

  private updateViewportCell(candidateIds: ReadonlySet<string>): void {
    const root = this.notebookView.node.getBoundingClientRect();
    const center = root.top + root.height / 2;
    let next: string | null = null;
    let nextDistance = Number.POSITIVE_INFINITY;
    candidateIds.forEach(id => {
      if (!id) return;
      const node = this.notebookView.cellElement(id);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const visible = rect.bottom > root.top && rect.top < root.bottom;
      if (!visible) return;
      const distance = Math.abs(rect.top + rect.height / 2 - center);
      if (distance >= nextDistance) return;
      next = id;
      nextDistance = distance;
    });
    if (!next || next === this.viewportCellId) return;
    this.viewportCellId = next;
    this.navigatorView.render(
      this.currentNavigationEntries(),
      this.viewportCellId
    );
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

  revealTurnActivity(cellId: string, activityId: string): void {
    this.views.get(cellId)?.revealActivity(activityId);
  }

  cellElements(): HTMLElement[] {
    return Array.from(this.views.values(), view => view.node);
  }

  cellElement(cellId: string): HTMLElement | null {
    return this.views.get(cellId)?.node ?? null;
  }

  revealCell(
    cellId: string,
    options: { behavior?: ScrollBehavior } = {}
  ): void {
    const node = this.cellElement(cellId);
    if (!node || this.isSufficientlyVisible(node)) return;
    node.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: options.behavior ?? 'smooth'
    });
  }

  isOutputTailNearViewport(cellId: string, threshold = 80): boolean {
    const tail = this.views.get(cellId)?.outputTail();
    if (!tail) return false;
    const root = this.node.getBoundingClientRect();
    const rect = tail.getBoundingClientRect();
    return rect.bottom >= root.top && rect.bottom <= root.bottom + threshold;
  }

  isEditingAnotherCell(cellId: string): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) return false;
    return !this.views.get(cellId)?.node.contains(active);
  }

  revealOutputTail(cellId: string): void {
    this.views.get(cellId)?.revealOutputTail();
  }

  private isSufficientlyVisible(node: HTMLElement): boolean {
    const root = this.node.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const visible = Math.max(
      0,
      Math.min(rect.bottom, root.bottom) - Math.max(rect.top, root.top)
    );
    return visible >= Math.min(80, rect.height * 0.4);
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
    this.node.dataset.cellId = this.id;
    this.node.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.editor.contains(target)) {
        this.handlers.onSelect(this.index);
        return;
      }
      if (this.isCollapser(target)) return;
      if (this.isTurnDisclosure(target)) return;
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

  revealActivity(activityId: string): void {
    if (!this.outputBody) return;
    const target = Array.from(
      this.outputBody.querySelectorAll<HTMLElement>('[data-turn-activity-id]')
    ).find(node => node.dataset.turnActivityId === activityId);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
  }

  outputTail(): HTMLElement | null {
    if (!this.outputBody) return null;
    return this.outputBody.lastElementChild as HTMLElement | null;
  }

  revealOutputTail(): void {
    const tail = this.outputTail();
    tail?.scrollIntoView({
      block: 'end',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
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
      this.handlers.rendermime,
      this.turnRenderHandlers()
    );
  }

  private turnRenderHandlers(): TurnRenderHandlers {
    return {
      onToggleTrace: turnId =>
        this.handlers.onToggleTurnTrace?.(this.id, turnId),
      onToggleActivity: (turnId, activityId) =>
        this.handlers.onToggleTurnActivity?.(this.id, turnId, activityId),
      onToggleEvidence: (turnId, activityId) =>
        this.handlers.onToggleTurnEvidence?.(this.id, turnId, activityId),
      onToggleOutcome: turnId =>
        this.handlers.onToggleTurnOutcome?.(this.id, turnId),
      onRevealFailure: (turnId, activityId) =>
        this.handlers.onRevealTurnFailure?.(this.id, turnId, activityId),
      onRetry: turnId => this.handlers.onRetryTurn?.(this.id, turnId)
    };
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

  private isTurnDisclosure(target: Node): boolean {
    const element = target instanceof Element ? target : target.parentElement;
    return Boolean(element?.closest('.jp-AgentWorkspace-disclosure'));
  }
}

export interface StatusBarHandlers {
  onStartNewContext: () => void;
  onContinueFromHistory: () => void;
  onStartEmptyContext: () => void;
  onDismissContextChoice: () => void;
  onRevealFailure: (cellId: string) => void;
  onRevealInterrupted: (cellId: string) => void;
  onOpenHistory: () => void;
  onRetrySave: () => void;
}

export class StatusBar extends Widget {
  private readonly connection: HTMLSpanElement;
  private readonly contextButton: HTMLButtonElement;
  private readonly cwd: HTMLSpanElement;
  private readonly overviewButton: HTMLButtonElement;
  private readonly failureButton: HTMLButtonElement;
  private readonly interruptedButton: HTMLButtonElement;
  private readonly execution: HTMLSpanElement;
  private readonly saveGroup: HTMLDivElement;
  private readonly saveStatus: HTMLSpanElement;
  private readonly retrySaveButton: HTMLButtonElement;
  private readonly contextPopover: HTMLDivElement;
  private readonly contextDescription: HTMLDivElement;
  private readonly resetContextButton: HTMLButtonElement;
  private readonly historyChoice: HTMLDivElement;
  private readonly historyChoiceDescription: HTMLDivElement;
  private readonly continueHistoryButton: HTMLButtonElement;
  private readonly emptyContextButton: HTMLButtonElement;
  private historyChoiceBusy = false;
  private overview: WorkspaceOverview = workspaceOverview([]);
  private lastSyncKey = '';

  constructor(
    private readonly handlers: StatusBarHandlers = {
      onStartNewContext: () => undefined,
      onContinueFromHistory: () => undefined,
      onStartEmptyContext: () => undefined,
      onDismissContextChoice: () => undefined,
      onRevealFailure: () => undefined,
      onRevealInterrupted: () => undefined,
      onOpenHistory: () => undefined,
      onRetrySave: () => undefined
    }
  ) {
    super();
    this.addClass('jp-AgentWorkspace-status');
    this.node.setAttribute('role', 'group');
    this.node.ariaLabel = ['Workspace', 'overview'].join(' ');
    this.connection = document.createElement('span');
    this.connection.className = 'jp-AgentWorkspace-statusConnection';
    this.connection.setAttribute('role', 'status');
    this.contextButton = document.createElement('button');
    this.contextButton.type = 'button';
    this.contextButton.className = 'jp-AgentWorkspace-statusContext';
    this.contextButton.setAttribute('aria-haspopup', 'true');
    this.contextButton.setAttribute('aria-expanded', 'false');
    this.contextButton.addEventListener('click', () => {
      if (!this.contextPopover.hidden && !this.historyChoice.hidden) {
        if (this.historyChoiceBusy) return;
        this.handlers.onDismissContextChoice();
        return;
      }
      this.setContextOpen(this.contextPopover.hidden);
    });
    this.cwd = document.createElement('span');
    this.cwd.className = 'jp-AgentWorkspace-statusCwd';
    this.overviewButton = document.createElement('button');
    this.overviewButton.type = 'button';
    this.overviewButton.className = 'jp-AgentWorkspace-statusOverview';
    this.overviewButton.addEventListener('click', () => {
      this.handlers.onOpenHistory();
    });
    this.failureButton = this.createOverviewIssueButton('failed', () => {
      const cellId = this.overview.firstFailureCellId;
      if (cellId) this.handlers.onRevealFailure(cellId);
    });
    this.interruptedButton = this.createOverviewIssueButton(
      'interrupted',
      () => {
        const cellId = this.overview.firstInterruptedCellId;
        if (cellId) this.handlers.onRevealInterrupted(cellId);
      }
    );
    this.execution = document.createElement('span');
    this.execution.className = 'jp-AgentWorkspace-statusExecution';
    this.execution.setAttribute('role', 'status');
    this.saveGroup = document.createElement('div');
    this.saveGroup.className = 'jp-AgentWorkspace-statusSave';
    this.saveStatus = document.createElement('span');
    this.saveStatus.className = 'jp-AgentWorkspace-statusSaveText';
    this.saveStatus.setAttribute('role', 'status');
    this.saveStatus.setAttribute('aria-live', 'polite');
    this.saveStatus.setAttribute('aria-atomic', 'true');
    this.retrySaveButton = document.createElement('button');
    this.retrySaveButton.type = 'button';
    this.retrySaveButton.className = 'jp-AgentWorkspace-retrySave';
    this.retrySaveButton.textContent = 'Retry';
    this.retrySaveButton.setAttribute(
      'aria-label',
      ['Retry', 'saving', 'workspace'].join(' ')
    );
    this.retrySaveButton.hidden = true;
    this.retrySaveButton.addEventListener('click', () => {
      if (this.retrySaveButton.disabled) return;
      this.retrySaveButton.disabled = true;
      this.handlers.onRetrySave();
    });
    this.saveGroup.append(this.saveStatus, this.retrySaveButton);

    this.contextPopover = document.createElement('div');
    this.contextPopover.className = 'jp-AgentWorkspace-contextPopover';
    this.contextPopover.hidden = true;
    this.contextDescription = document.createElement('div');
    this.contextDescription.className = 'jp-AgentWorkspace-contextDescription';
    this.resetContextButton = document.createElement('button');
    this.resetContextButton.type = 'button';
    this.resetContextButton.className = 'jp-AgentWorkspace-resetContext';
    this.resetContextButton.textContent = 'Start new context';
    this.resetContextButton.addEventListener('click', () => {
      this.setContextOpen(false);
      this.handlers.onStartNewContext();
    });
    this.historyChoice = document.createElement('div');
    this.historyChoice.className = 'jp-AgentWorkspace-historyChoice';
    this.historyChoice.setAttribute('role', 'group');
    this.historyChoice.ariaLabel = ['Choose', 'Agent', 'context'].join(' ');
    this.historyChoice.hidden = true;
    this.historyChoiceDescription = document.createElement('div');
    this.historyChoiceDescription.className =
      'jp-AgentWorkspace-historyChoiceDescription';
    this.historyChoiceDescription.setAttribute('role', 'status');
    this.historyChoiceDescription.setAttribute('aria-live', 'polite');
    const choiceActions = document.createElement('div');
    choiceActions.className = 'jp-AgentWorkspace-historyChoiceActions';
    this.continueHistoryButton = document.createElement('button');
    this.continueHistoryButton.type = 'button';
    this.continueHistoryButton.className =
      'jp-AgentWorkspace-contextChoice is-primary';
    this.continueHistoryButton.textContent = 'Continue from visible history';
    this.continueHistoryButton.addEventListener('click', () => {
      if (this.continueHistoryButton.disabled) return;
      this.setHistoryChoiceBusy(true, 'bridge');
      this.handlers.onContinueFromHistory();
    });
    this.emptyContextButton = document.createElement('button');
    this.emptyContextButton.type = 'button';
    this.emptyContextButton.className =
      'jp-AgentWorkspace-contextChoice is-secondary';
    this.emptyContextButton.textContent = 'Start empty context';
    this.emptyContextButton.addEventListener('click', () => {
      if (this.emptyContextButton.disabled) return;
      this.setHistoryChoiceBusy(true, 'empty');
      this.handlers.onStartEmptyContext();
    });
    choiceActions.append(this.continueHistoryButton, this.emptyContextButton);
    this.historyChoice.append(this.historyChoiceDescription, choiceActions);
    this.contextPopover.append(
      this.contextDescription,
      this.resetContextButton,
      this.historyChoice
    );
    this.node.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || this.contextPopover.hidden) return;
      if (this.historyChoiceBusy) return;
      event.preventDefault();
      if (!this.historyChoice.hidden) {
        this.handlers.onDismissContextChoice();
        return;
      }
      this.setContextOpen(false);
      this.contextButton.focus({ preventScroll: true });
    });
    this.node.append(
      this.connection,
      this.contextButton,
      this.cwd,
      this.overviewButton,
      this.interruptedButton,
      this.failureButton,
      this.saveGroup,
      this.execution,
      this.contextPopover
    );
  }

  sync(state: WorkspaceUiState, overview = workspaceOverview([])): void {
    const key = `${workspaceUiStateKey(state)}|${JSON.stringify(overview)}`;
    if (key === this.lastSyncKey) return;
    this.lastSyncKey = key;
    this.overview = overview;
    this.connection.textContent = state.connectionLabel;
    this.connection.classList.toggle('is-error', Boolean(state.error));
    this.connection.classList.toggle('is-connected', state.connected);
    this.cwd.textContent = state.cwd ?? 'Local tools';
    this.cwd.title = state.cwd ?? '';
    this.contextButton.textContent = state.contextLabel;
    this.contextButton.classList.toggle(
      'is-unavailable',
      state.contextState === 'unavailable'
    );
    this.contextDescription.textContent = contextDescription(state);
    this.resetContextButton.disabled = state.activeRun !== null;
    this.overviewButton.textContent = overview.summaryLabel;
    this.interruptedButton.hidden = overview.interruptedCount === 0;
    this.interruptedButton.textContent = `${overview.interruptedCount} interrupted`;
    this.failureButton.hidden = overview.failureCount === 0;
    this.failureButton.textContent = `${overview.failureCount} failed`;
    this.saveStatus.textContent = state.saveLabel;
    this.saveGroup.classList.toggle('is-error', state.savePhase === 'error');
    this.saveGroup.classList.toggle(
      'is-saving',
      state.savePhase === 'pending' || state.savePhase === 'saving'
    );
    this.retrySaveButton.hidden = !state.saveRetryAvailable;
    this.retrySaveButton.disabled = !state.saveRetryAvailable;
    this.execution.textContent = state.executionLabel;
  }

  setMessage(message: string): void {
    this.lastSyncKey = '';
    this.execution.textContent = message;
  }

  containsFocus(): boolean {
    const active = document.activeElement;
    return active instanceof Node && this.node.contains(active);
  }

  openHistoryChoice(
    visibleCount: number,
    reason: HistoryChoiceReason = 'uncovered'
  ): void {
    const turns = visibleCount === 1 ? 'turn' : 'turns';
    this.historyChoiceDescription.textContent =
      reason === 'unavailable'
        ? `The saved Agent context could not be resumed. ${visibleCount} visible ${turns} can be used as a bounded read-only recovery bridge, or you can start an empty context.`
        : `${visibleCount} visible ${turns} ${
            visibleCount === 1 ? 'is' : 'are'
          } outside the current Agent context. Continue with a bounded read-only history bridge, or start without that history.`;
    this.resetContextButton.hidden = true;
    this.historyChoice.hidden = false;
    this.setHistoryChoiceBusy(false);
    this.setContextOpen(true);
    queueMicrotask(() => {
      this.continueHistoryButton.focus({ preventScroll: true });
    });
  }

  closeHistoryChoice(): void {
    this.historyChoice.hidden = true;
    this.resetContextButton.hidden = false;
    this.setHistoryChoiceBusy(false);
    this.setContextOpen(false);
  }

  private setHistoryChoiceBusy(busy: boolean, mode?: 'bridge' | 'empty'): void {
    this.historyChoiceBusy = busy;
    this.historyChoice.setAttribute('aria-busy', String(busy));
    this.continueHistoryButton.disabled = busy;
    this.emptyContextButton.disabled = busy;
    this.continueHistoryButton.textContent =
      busy && mode === 'bridge'
        ? 'Continuing…'
        : 'Continue from visible history';
    this.emptyContextButton.textContent =
      busy && mode === 'empty' ? 'Starting…' : 'Start empty context';
  }

  private createOverviewIssueButton(
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `jp-AgentWorkspace-statusIssue is-${label}`;
    button.hidden = true;
    button.addEventListener('click', onClick);
    return button;
  }

  private setContextOpen(open: boolean): void {
    this.contextPopover.hidden = !open;
    this.contextButton.setAttribute('aria-expanded', String(open));
  }
}

function contextDescription(state: WorkspaceUiState): string {
  let description: string;
  switch (state.contextState) {
    case 'connecting':
      description = 'Agent context is connecting.';
      break;
    case 'new':
      description =
        'Historical Cells are visible, but this is a new Agent context.';
      break;
    case 'live':
      description =
        'The current Agent context is live and linked to this workspace.';
      break;
    case 'resumed':
      description = 'The saved Agent context was resumed for this workspace.';
      break;
    case 'unavailable':
      description =
        'Visible history is preserved, but its Agent context is unavailable on this server.';
      break;
    case 'reset':
      description =
        'The previous context link was cleared. The next AI turn starts fresh.';
      break;
  }
  const nativeCount = state.contextNativeCount ?? 0;
  const bridgedCount = state.contextBridgedCount ?? 0;
  const outsideCount = state.contextOutsideCount ?? 0;
  if (!nativeCount && !bridgedCount && !outsideCount) return description;
  return `${description} Coverage: ${nativeCount} native, ${bridgedCount} bridged, ${outsideCount} outside.`;
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
  rendermime: IRenderMimeRegistry | null = null,
  turnHandlers?: TurnRenderHandlers
): void {
  body.replaceChildren();
  if (cell.kind === 'ai') {
    const turn = turnForCell(cell);
    if (turn) {
      body.append(
        renderTurn(turn, {
          rendermime,
          handlers: turnHandlers ?? noopTurnHandlers()
        })
      );
    } else {
      cell.blocks.forEach(block => body.append(renderBlock(block, rendermime)));
    }
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
  rendermime: IRenderMimeRegistry | null = null,
  turnHandlers?: TurnRenderHandlers
): void {
  const state = captureOutputRenderState(body);
  renderCellOutput(body, cell, rendermime, turnHandlers);
  restoreOutputRenderState(body, state);
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
  const turn = cell.kind === 'ai' ? turnForCell(cell) : null;
  return JSON.stringify({
    kind: cell.kind,
    status: cell.status,
    output: cell.output,
    turn: turn
      ? {
          id: turn.id,
          status: turn.status,
          outcome: turn.outcome,
          metrics: turn.metrics,
          presentation: turn.presentation,
          revision: turn.revision
        }
      : null,
    blocks: cell.turn ? [] : cell.blocks
  });
}

export function turnForCell(cell: WorkspaceCell): ChatTurn | null {
  if (cell.kind !== 'ai') return null;
  if (cell.turn) return cell.turn;
  if (!cell.blocks.length && cell.status !== 'running') return null;
  const status =
    cell.status === 'running'
      ? 'running'
      : cell.status === 'interrupted'
        ? 'interrupted'
        : 'done';
  return setTurnStatus(createTurn(`legacy-${cell.id}`), status, cell.blocks);
}

interface OutputRenderState {
  scrollTop: number;
  focusKey: string | null;
  scrollPositions: Map<string, number>;
}

function captureOutputRenderState(body: HTMLElement): OutputRenderState {
  const active = document.activeElement;
  const focusKey =
    active instanceof HTMLElement && body.contains(active)
      ? (active.dataset.turnFocusKey ?? null)
      : null;
  const scrollPositions = new Map<string, number>();
  body.querySelectorAll<HTMLElement>('[data-turn-scroll-key]').forEach(node => {
    const key = node.dataset.turnScrollKey;
    if (key) scrollPositions.set(key, node.scrollTop);
  });
  return {
    scrollTop: body.scrollTop,
    focusKey,
    scrollPositions
  };
}

function restoreOutputRenderState(
  body: HTMLElement,
  state: OutputRenderState
): void {
  body.scrollTop = state.scrollTop;
  body.querySelectorAll<HTMLElement>('[data-turn-scroll-key]').forEach(node => {
    const key = node.dataset.turnScrollKey;
    if (!key || !state.scrollPositions.has(key)) return;
    node.scrollTop = state.scrollPositions.get(key) ?? 0;
  });
  if (!state.focusKey) return;
  const focusTarget = Array.from(
    body.querySelectorAll<HTMLElement>('[data-turn-focus-key]')
  ).find(node => node.dataset.turnFocusKey === state.focusKey);
  focusTarget?.focus({ preventScroll: true });
}

function noopTurnHandlers(): TurnRenderHandlers {
  return {
    onToggleTrace: () => undefined,
    onToggleActivity: () => undefined,
    onToggleEvidence: () => undefined,
    onToggleOutcome: () => undefined,
    onRevealFailure: () => undefined,
    onRetry: () => undefined
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
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
