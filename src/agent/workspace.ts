import { Notification } from '@jupyterlab/apputils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Message } from '@lumino/messaging';
import { BoxPanel, Panel, Widget } from '@lumino/widgets';

import { AGENT_PANEL_CLASS, ShutdownCoordinator } from '../theme';
import { BtwPanel, type BtwSendBackOutcome } from './btw';
import { answerNumberForCell, isAnswerCard } from './btw-protocol';
import {
  getResumableDshSessionReference,
  normalizeAgentSessionId,
  parseWorkspaceSnapshot,
  restoreNotebook,
  serializeNotebook,
  setAgentSessionReference,
  UnsupportedWorkspaceVersionError
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
  resolveRunExecution,
  WorkspaceNotebook,
  type RunRequest,
  type WorkspaceCell
} from './notebook';
import { AgentSession } from './session';
import { WorkspaceSaveCoordinator } from './save-coordinator';
import { SelectionCopyButton } from './selectioncopy';
import { formatToolInput } from './tool';
import type { AgentToolbarHost } from './toolbar';
import type {
  AgentModelOption,
  BudgetFieldName,
  BudgetProvenanceEntry,
  BudgetSnapshot,
  ChatBlock,
  ConfigurationDifferenceValue,
  ConfigurationReport,
  DshProductEvent
} from './protocol';
import { renderTurn, type TurnRenderHandlers } from './turn-renderer';
import {
  createTurn,
  deriveTurn,
  preserveTurnPresentation,
  revealFailedActivity,
  setTurnStatus,
  toggleActivity,
  toggleEvidence,
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
  type WorkspaceUiState
} from './workspace-interaction';

export interface SourceChangeOptions {
  fromHistory?: boolean;
}

/**
 * Explicit state for a document that could not be loaded safely. While set, the
 * workspace is read-only: it never starts a fresh session, never serializes the
 * in-memory model back into the document, and refuses new runs. The kind keeps
 * a newer-format rejection distinct from an unexpected failure for diagnostics.
 */
export interface DocumentLoadError {
  kind: 'unsupported-version' | 'unknown' | 'session-mismatch';
  message: string;
  foundVersion?: number;
  supportedVersion?: number;
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
  onRevealTurnFailure?: (
    cellId: string,
    turnId: string,
    activityId: string
  ) => void;
  onRetryTurn?: (cellId: string, turnId: string) => void;
  onBtwTurn?: (cellId: string, turnId: string) => void;
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
  private readonly split: BoxPanel;
  private readonly btwPanel: BtwPanel;
  private readonly navigatorView: CellNavigatorView;
  private readonly status: StatusBar;
  private readonly returnLatestButton: HTMLButtonElement;
  private context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel> | null =
    null;
  private historyPath: string | null = null;
  private applyingModel = false;
  private documentLoadErrorState: DocumentLoadError | null = null;
  private sessionStarted = false;
  private deleteChordTimer = 0;
  private composing = false;
  private compositionEndTimer = 0;
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
  private unsubscribeDsh: (() => void) | null = null;
  private dshOwnedSession: string | null = null;
  private documentActivator: (() => void) | null = null;
  private readonly sendBackWaiters = new Map<
    string,
    (accepted: boolean) => void
  >();
  /**
   * Send-back cells that were inserted but not submitted, keyed by their text.
   * A repeated delivery of the same text reuses that cell instead of inserting
   * a second copy.
   */
  private readonly pendingSendBackCells = new Map<string, string>();

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
        if (this.documentLoadErrorState) {
          // The open document could not be loaded safely, so cell edits must
          // not change the model; refresh so the editor shows the kept text.
          this.reportDocumentLoadError();
          this.refresh();
          return;
        }
        if (!options?.fromHistory) {
          this.inputHistory.resetNavigation();
        }
        this.notebook.setSource(source);
        const pending = this.pendingContextSubmission;
        if (
          pending?.cellId === this.notebook.current.id &&
          pending.source !== source.trim()
        ) {
          // Editing the pending cell's source cancels the context choice but
          // must keep the cell and its just-edited content.
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
      onRevealTurnFailure: (cellId, turnId, activityId) =>
        this.revealTurnFailure(cellId, turnId, activityId),
      onRetryTurn: (cellId, turnId) => this.prepareRetry(cellId, turnId),
      onBtwTurn: (cellId, turnId) => this.openBtwTurn(cellId, turnId),
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
      onOpenHistory: () => this.navigatorView.openHistory(),
      onRefreshConfiguration: () => this.requestConfigurationRefresh(),
      onRetrySave: () => {
        void this.saveCoordinator.retry().catch(() => undefined);
      },
      onSelectModel: value => this.selectModel(value),
      onCompact: () => this.runCompact()
    });
    this.btwPanel = new BtwPanel({
      notebook: () => this.notebookPath(),
      isMainBusy: () => this.session.running || this.notebook.busy(),
      canSend: () => this.canSendBack(),
      sendBack: text => this.insertSendBackCell(text),
      awaitAccepted: runId => this.awaitSendBackAccepted(runId),
      flush: () => this.flushSave(),
      answerNumber: cellId =>
        answerNumberForCell(
          this.notebook.cells.map(cell => ({
            id: cell.id,
            kind: cell.kind,
            turn: cell.turn,
            blocks: cell.blocks
          })),
          cellId
        )
    });
    this.btwPanel.hide();
    this.split = new BoxPanel({ direction: 'left-to-right' });
    this.split.addClass('jp-AgentWorkspace-split');
    this.split.addWidget(this.body);
    this.split.addWidget(this.btwPanel);
    BoxPanel.setStretch(this.body, 1);
    BoxPanel.setStretch(this.btwPanel, 0);
    this.addWidget(this.split);
    this.addWidget(this.status);
    this.node.tabIndex = -1;
    this.copyButton = new SelectionCopyButton(this.node);
    this.node.addEventListener('keydown', event => this.onKey(event), true);
    this.node.addEventListener(
      'compositionstart',
      () => {
        this.composing = true;
      },
      true
    );
    this.node.addEventListener(
      'compositionend',
      () => {
        // Some IMEs dispatch the committing keydown right after compositionend
        // with isComposing already false. Keep the guard one macrotask longer
        // so that key cannot submit the cell it just committed.
        this.composing = true;
        window.clearTimeout(this.compositionEndTimer);
        this.compositionEndTimer = window.setTimeout(() => {
          this.compositionEndTimer = 0;
          this.composing = false;
        }, 0);
      },
      true
    );
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
    this.unsubscribeDsh = this.session.subscribeDsh(event =>
      this.onDshEvent(event)
    );
    this.refresh();
  }

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus({ preventScroll: true });
  }

  start(): void {
    if (this.closing || this.isDisposed || this.sessionStarted) return;
    this.sessionStarted = true;
    this.session.connect();
    this.refresh();
    queueMicrotask(() => {
      if (this.closing || this.isDisposed) return;
      // Only seed focus when nothing meaningful is focused yet; an existing
      // cell editor focus must survive activation.
      const active = document.activeElement;
      if (active && active !== document.body) return;
      this.notebookView.focusActive();
    });
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

  /**
   * Install the callback that raises this document's JupyterLab tab. The
   * widget factory owns the widget id, so the content cannot activate itself.
   */
  setDocumentActivator(activate: (() => void) | null): void {
    this.documentActivator = activate;
  }

  /**
   * The current load-protection state, or null when the document loaded cleanly.
   * A non-null value means the workspace is read-only for the open document.
   */
  get documentLoadError(): DocumentLoadError | null {
    return this.documentLoadErrorState;
  }

  attachContext(
    context: DocumentRegistry.IContext<DocumentRegistry.ICodeModel>
  ): void {
    this.context = context;
    void context.ready
      .then(() => {
        if (this.isDisposed || this.closing) return;
        this.historyPath = context.path;
        this.inputHistory.restore(this.historyStorage.load(context.path));
        this.applyModel();
        if (!this.documentLoadErrorState) {
          this.session.configureWorkspacePath(context.path);
          this.session.configureContext(this.notebook.agentSessionId);
          this.configureDshSessionFromDocument();
          if (!context.model.toString().trim()) {
            this.persistNow();
          }
          this.start();
        }
        context.model.contentChanged.connect(this.onModelContentChanged, this);
      })
      .catch(error => {
        if (this.isDisposed || this.closing) return;
        this.enterDocumentLoadError(error);
        this.refresh();
      });
  }

  private onModelContentChanged(): void {
    if (this.applyingModel) return;
    this.applyModel();
  }

  insertAbove(): void {
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    this.inputHistory.resetNavigation();
    this.notebook.insertAbove();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  insertBelow(): void {
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    this.inputHistory.resetNavigation();
    this.notebook.insertBelow();
    this.refresh();
    this.persistSoon();
    this.notebookView.focusActive();
  }

  addCellFromFooter(): void {
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
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
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    this.clearDeleteChord();
    this.inputHistory.resetNavigation();
    if (this.notebook.empty) {
      return;
    }
    if (
      this.notebook.current.status === 'running' ||
      this.notebook.current.status === 'pending'
    ) {
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
    window.clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = 0;
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
    this.unsubscribeDsh?.();
    this.unsubscribeDsh = null;
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
    // Rebuilding the output changes its height, so keep the disclosure the
    // user just activated anchored at the same viewport position instead of
    // letting the list jump under the pointer.
    const scrollNode = this.notebookView.node;
    const focusKey = this.notebookView.takeToggleFocusKey();
    const anchor = focusKey ? this.notebookView.toggleElement(focusKey) : null;
    const anchorTop = anchor?.getBoundingClientRect().top ?? null;
    const scrollTop = scrollNode.scrollTop;
    cell.turn = update(turn);
    // Mirror the user's presentation choice into the session turn so later
    // events derive from it instead of falling back to the collapsed default.
    if (
      this.session.turn &&
      (this.session.turn.id === turnId ||
        this.notebook.activeRun?.cellId === cellId)
    ) {
      this.session.turn = update(this.session.turn);
    }
    this.refresh();
    if (focusKey !== null && anchorTop !== null) {
      const next = this.notebookView.toggleElement(focusKey);
      if (next) {
        scrollNode.scrollTop =
          scrollTop + (next.getBoundingClientRect().top - anchorTop);
      }
    }
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

  private notebookPath(): string | null {
    const path = this.context?.path;
    if (!path) return null;
    return path.endsWith('.agentnb') ? path : null;
  }

  private openBtwTurn(cellId: string, turnId: string): void {
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    const cell = this.notebook.cells.find(item => item.id === cellId);
    // Only a persisted answer card may open BTW. This uses the same rule as
    // the server snapshot builder, so a legacy cell (no persisted turn) never
    // opens a panel that cannot snapshot anything.
    const turn = cell?.turn ?? null;
    if (!cell || !turn || turn.id !== turnId) return;
    if (
      !isAnswerCard({
        id: cell.id,
        kind: cell.kind,
        turn,
        blocks: cell.blocks
      })
    ) {
      return;
    }
    // Opening the panel never starts a model call; the BTW thread and its
    // fixed snapshot are created on the first sent message.
    void this.btwPanel.open(cellId).catch(() => undefined);
  }

  /** Whether a new send-back run can be submitted right now. */
  private canSendBack(): boolean {
    return (
      !this.closing &&
      !this.documentLoadErrorState &&
      this.context !== null &&
      this.pendingContextSubmission === null &&
      !this.session.running &&
      !this.notebook.busy()
    );
  }

  /** The still-unsubmitted send-back cell holding exactly this text, if any. */
  private findPendingSendBackCell(text: string): WorkspaceCell | null {
    const cellId = this.pendingSendBackCells.get(text);
    if (!cellId) return null;
    const cell = this.notebook.cells.find(item => item.id === cellId);
    if (!cell) {
      this.pendingSendBackCells.delete(text);
      return null;
    }
    if (
      cell.turn !== null ||
      cell.status !== 'idle' ||
      cell.executionCount !== null
    ) {
      // The user already ran or edited it into a real turn: stop reusing it.
      this.pendingSendBackCells.delete(text);
      return null;
    }
    return cell;
  }

  /**
   * Insert send-back text into a new main input cell and submit it when the
   * session is idle. Existing cells and their history are never modified.
   *
   * ``sent`` means the notebook accepted the run (and will send it), so only
   * that outcome may be acknowledged as delivered. ``inserted`` means nothing
   * was inserted because the main session cannot take a run right now; the
   * queued entry stays queued and is retried when the session is idle.
   * ``blocked`` means the text can never be delivered automatically and says
   * why.
   *
   * The busy check runs *before* any cell is created, so a busy session never
   * leaves an unsubmitted cell behind. If an earlier attempt did leave one, a
   * repeat delivery of the same text reuses that cell instead of inserting a
   * second copy.
   */
  private insertSendBackCell(text: string): BtwSendBackOutcome {
    if (this.closing) {
      return {
        status: 'blocked',
        message:
          'This workspace is closing, so the BTW answer was not sent back.'
      };
    }
    if (this.documentLoadErrorState || !this.context) {
      return {
        status: 'blocked',
        message:
          'Save this workspace as a notebook before sending a BTW answer back.'
      };
    }
    // A leading ``!`` would be resolved as a shell command by the notebook's
    // own execution resolver. Auto-running a side-chat answer as a command is
    // not what "send to main session" means, so refuse instead of guessing.
    if (isShellEscapeSource(text)) {
      return {
        status: 'blocked',
        message:
          'This answer starts with "!", which the notebook would run as a ' +
          'shell command. Sending it back was blocked; copy it instead if you ' +
          'want a command.'
      };
    }
    if (!this.canSendBack()) {
      // Nothing is inserted while the main session is busy, so a later retry
      // cannot duplicate a cell.
      return { status: 'inserted' };
    }
    const pending = this.findPendingSendBackCell(text);
    let index: number;
    if (pending) {
      // Reuse the cell an earlier attempt inserted; never a second copy.
      index = this.notebook.cells.findIndex(item => item.id === pending.id);
      this.notebook.select(index);
    } else {
      const cell = this.notebook.createCell('ai', text);
      this.notebook.cells.push(cell);
      index = this.notebook.cells.length - 1;
      this.notebook.select(index);
      this.persistSoon();
    }
    this.inputHistory.resetNavigation();
    this.refresh();
    const request = this.acceptRun(index, true);
    if (!request) {
      this.pendingSendBackCells.set(text, this.notebook.cells[index].id);
      return { status: 'inserted' };
    }
    this.pendingSendBackCells.delete(text);
    return { status: 'sent', runId: request.id };
  }

  /**
   * Resolve once the main session accepts ``runId``. Bounded so a dead socket
   * leaves the delivery unproven (``unknown``) instead of hanging the panel.
   */
  private awaitSendBackAccepted(runId: string): Promise<boolean> {
    if (this.session.acceptedTurnId === runId) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const timer = window.setTimeout(() => {
        this.sendBackWaiters.delete(runId);
        resolve(false);
      }, SEND_BACK_ACCEPT_TIMEOUT_MS);
      this.sendBackWaiters.set(runId, accepted => {
        window.clearTimeout(timer);
        this.sendBackWaiters.delete(runId);
        resolve(accepted);
      });
    });
  }

  /** Flush the document so a delivered send-back cell is on disk. */
  async flushSave(): Promise<void> {
    await this.saveCoordinator.flush();
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
    // Never translate shortcut keys while an IME composition is active (or
    // just ended); the editor must own the committing keydown.
    if (event.isComposing || this.composing) return;
    if (event.key === 'Escape' && this.pendingContextSubmission) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelContextChoice(true);
      return;
    }
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
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    if (this.notebook.empty) return;
    const source = this.notebook.current.source.trim();
    // Shell commands are resolved from the cell kind plus the `!` escape, the
    // same way `enqueueRun` resolves them, so a command cell is never treated
    // as an AI request and a `!` prefix is never treated as one either.
    if (
      resolveRunExecution(source, this.notebook.current.kind)?.kind === 'ai'
    ) {
      const membership = this.contextMembership();
      const visibleAiCount =
        membership.nativeCount +
        membership.bridgedCount +
        membership.outsideCount;
      const unavailable = this.session.contextState === 'unavailable';
      const choiceCount = unavailable
        ? visibleAiCount
        : membership.outsideCount;
      if (this.pendingContextSubmission) {
        // A repeated submit while a choice is pending must never look like a
        // dead editor: reopen the choice panel and put focus back on it.
        this.promptContextChoice(
          choiceCount,
          unavailable ? 'unavailable' : 'uncovered',
          unavailable
            ? 'The saved Agent context is unavailable. Resolve the pending context choice before submitting again.'
            : 'Resolve the pending context choice before submitting again.'
        );
        return;
      }
      if (choiceCount > 0 && (unavailable || !membership.policyChosen)) {
        this.pendingContextSubmission = {
          cellId: this.notebook.current.id,
          source,
          advance
        };
        this.promptContextChoice(
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

  private promptContextChoice(
    choiceCount: number,
    reason: HistoryChoiceReason,
    message?: string
  ): void {
    if (message) {
      this.status.setMessage(message);
    }
    if (choiceCount > 0) {
      this.status.openHistoryChoice(choiceCount, reason);
    }
  }

  private acceptRun(
    index: number,
    advance: boolean,
    historyBridge?: HistoryBridgeCapsule,
    ensureTrailing = true
  ): RunRequest | null {
    this.notebook.select(index);
    const request = this.notebook.enqueueRun(index, advance, historyBridge);
    if (!request) return null;
    if (this.inputHistory.add(request.source)) {
      this.saveInputHistory();
    }
    if (ensureTrailing) {
      this.notebook.ensureTrailingInput();
    }
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
        this.clearDshSessionBinding();
      }
    } else if (
      this.notebook.agentSessionId ||
      getResumableDshSessionReference(this.notebook) !== null ||
      this.session.contextState === 'live' ||
      this.session.contextState === 'resumed' ||
      this.session.contextState === 'unavailable'
    ) {
      this.notebook.startNewAgentContext();
      this.session.resetContext();
      this.clearDshSessionBinding();
    } else {
      this.notebook.setAgentContextBridge([]);
    }

    const request = this.acceptRun(
      index,
      pending.advance,
      historyBridge,
      false
    );
    if (!request) {
      this.status.closeHistoryChoice();
      return;
    }
    this.pendingContextAcceptance = {
      id: request.id,
      cellId: request.cellId
    };
  }

  private cancelContextChoice(focusEditor = true): void {
    if (this.pendingContextAcceptance) return;
    const pending = this.pendingContextSubmission;
    this.pendingContextSubmission = null;
    this.status.closeHistoryChoice();
    if (!pending || !focusEditor) return;
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
    if (!this.session.connected) {
      // A drained run must not look frozen when no socket exists: reconnect
      // explicitly and state the transport wait in the status bar.
      this.session.connect();
      this.status.setMessage(
        'Connecting to the Agent server before sending the queued run…'
      );
    }
    if (request.kind === 'ai') {
      this.session.activeCellId = request.cellId;
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
    const request = this.notebook.activeRun;
    if (
      !request ||
      request.id !== requestId ||
      !this.notebook.finishRun(requestId, output, status)
    ) {
      return;
    }
    const cell = this.notebook.cells.find(
      candidate => candidate.id === request.cellId
    );
    this.aiInterruptRequested = false;
    this.followState = syncFollowRequest(this.followState, null);
    this.refresh();
    this.persistNow();
    if (cell) this.notifyCellCompletion(cell);
    this.drainQueue();
  }

  /**
   * Announce a finished cell through JupyterLab's notification center. The
   * action raises this document's tab and selects the exact Cell, so a
   * notification from a background workspace is still actionable.
   */
  private notifyCellCompletion(cell: WorkspaceCell): void {
    const outcome = cellCompletionOutcome(cell);
    const position = cell.executionCount ?? '?';
    const kind = cell.kind === 'ai' ? 'Agent cell' : 'Command cell';
    const fileName = this.notebookPath()?.split('/').pop() ?? '';
    const message = `${fileName ? `${fileName} · ` : ''}${kind} [${position}] ${
      outcome.label
    }`;
    const cellId = cell.id;
    Notification.emit(message, outcome.type, {
      autoClose: 5000,
      actions: [
        {
          label: 'Open cell',
          caption: 'Show this cell in its workspace tab',
          callback: () => this.revealCellFromNotification(cellId)
        }
      ]
    });
  }

  private revealCellFromNotification(cellId: string): void {
    if (this.isDisposed) return;
    this.documentActivator?.();
    this.navigateToCell(cellId);
  }

  private onSessionChange(): void {
    this.adoptServerTurn();
    this.settleUnclaimedPendingCells();
    // Deliver a queued send-back as soon as the main session is idle again;
    // the panel only claims when its stored queue actually holds an entry.
    if (!this.session.running) {
      void this.btwPanel.deliverPending().catch(() => undefined);
    }
    const acceptedId = this.session.acceptedTurnId;
    if (acceptedId) {
      this.sendBackWaiters.get(acceptedId)?.(true);
    }
    const request = this.notebook.activeRun;
    const requestAccepted = Boolean(
      request && this.session.acceptedTurnId === request.id
    );
    const confirmedSessionId =
      this.session.contextState === 'live' || requestAccepted
        ? normalizeAgentSessionId(this.session.sessionId)
        : null;
    if (
      !this.documentLoadErrorState &&
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
          // A transport close is not a user interrupt and does not prove the
          // server stopped. Keep the last known turn and evidence untouched
          // until the reconnect handshake or a terminal event settles it.
          if (!this.session.connected) {
            this.refresh();
            this.status.setMessage(
              'Disconnected from the Agent server; the server may still be executing this turn.'
            );
            return;
          }
          const previousTurn = cell.turn;
          // Replayed attach events can begin with an accepted event and an
          // empty block list. Do not erase evidence already on disk.
          if (this.session.blocks.length || !cell.blocks.length) {
            cell.blocks = this.session.blocks;
          }
          const incomingTurn =
            this.session.turn ??
            deriveTurn(createTurn(request.id), this.session.blocks);
          if (
            !cell.turn ||
            incomingTurn.timeline.length > 0 ||
            incomingTurn.revision > 0 ||
            incomingTurn.status !== 'running'
          ) {
            cell.turn = preserveTurnPresentation(incomingTurn, previousTurn);
          }
          if (!this.session.running) {
            if (this.pendingContextAcceptance?.id === request.id) {
              this.finishContextAcceptance(request);
            }
            cell.status =
              this.session.error || this.aiInterruptRequested
                ? 'interrupted'
                : 'done';
            cell.turn = preserveTurnPresentation(
              setTurnStatus(
                cell.turn,
                cell.status === 'interrupted' ? 'interrupted' : 'done',
                cell.blocks
              ),
              previousTurn
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

  /**
   * Claim a turn that the server reports as still executing after a refresh or
   * socket reconnect. The document is the only identity available before the
   * first replayed event, so match the server's cell/turn pair against it.
   */
  private adoptServerTurn(): void {
    if (this.notebook.activeRun || !this.session.serverStateKnown) return;
    const activeTurnId = this.session.serverActiveTurnId;
    // A turn that finished while the page was away has no active id, but its
    // replayed terminal events still carry the identity needed to settle it.
    const turnId = activeTurnId ?? this.session.turn?.id ?? null;
    if (!turnId) return;
    const cellId = this.session.serverActiveCellId ?? this.session.activeCellId;
    let index = cellId
      ? this.notebook.cells.findIndex(cell => cell.id === cellId)
      : -1;
    if (index < 0) {
      index = this.notebook.cells.findIndex(cell => cell.turn?.id === turnId);
    }
    if (index < 0) return;
    const cell = this.notebook.cells[index];
    if (cell.kind !== 'ai') return;
    const persistedTurnId = cell.turn?.id ?? null;
    const adoptable =
      Boolean(activeTurnId) ||
      cell.status === 'pending' ||
      cell.status === 'running';
    if (!adoptable) return;
    if (persistedTurnId && persistedTurnId !== turnId) {
      // Never hijack a different persisted turn on the same cell.
      return;
    }
    if (this.notebook.adoptRun(cell.id, turnId)) {
      if (!this.session.activeCellId) this.session.activeCellId = cell.id;
      this.persistSoon();
    }
  }

  /**
   * A ready handshake with no active server turn is proof that a restored
   * pending cell is no longer executing. Settle it without touching blocks.
   */
  private settleUnclaimedPendingCells(): void {
    if (
      !this.session.serverStateKnown ||
      !this.session.connected ||
      this.session.running ||
      this.session.serverActiveTurnId
    ) {
      return;
    }
    let changed = false;
    this.notebook.cells.forEach(cell => {
      if (cell.status !== 'pending') return;
      cell.status = 'interrupted';
      if (cell.turn && cell.turn.status === 'pending') {
        cell.turn = setTurnStatus(cell.turn, 'interrupted', cell.blocks);
      }
      changed = true;
    });
    if (changed) {
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
    const recovering = this.documentLoadErrorState !== null;
    if (text === serializeNotebook(this.notebook)) {
      // The open document already matches memory: a previously blocked load is
      // now consistent, so safe to release the read-only protection.
      this.documentLoadErrorState = null;
      this.saveCoordinator.acceptExternalSavedState();
      this.finishDocumentRecovery(recovering);
      this.refresh();
      return;
    }
    // Check the format before the dirty-state guard so a newer document is
    // never ignored while local edits are pending; otherwise the next save
    // would serialize the older in-memory model over it.
    try {
      parseWorkspaceSnapshot(text);
    } catch (error) {
      this.enterDocumentLoadError(error);
      this.refresh();
      return;
    }
    // While protected, an external supported replacement is authoritative even
    // if the coordinator still holds pre-error edits; accepting the reset is
    // what clears the protection and lets the document load again.
    if (!recovering && !this.saveCoordinator.acceptExternalSavedState()) return;
    this.inputHistory.resetNavigation();
    this.applyingModel = true;
    try {
      restoreNotebook(this.notebook, text);
      this.documentLoadErrorState = null;
    } catch (error) {
      this.enterDocumentLoadError(error);
    } finally {
      this.applyingModel = false;
    }
    this.finishDocumentRecovery(recovering);
    this.refresh();
  }

  private finishDocumentRecovery(recovering: boolean): void {
    if (!recovering || this.documentLoadErrorState) return;
    if (this.sessionStarted) {
      const legacyMatches =
        normalizeAgentSessionId(this.session.sessionId) ===
        normalizeAgentSessionId(this.notebook.agentSessionId);
      const liveDsh = this.session.dshSessionId;
      const documentDsh =
        getResumableDshSessionReference(this.notebook)?.sessionId ?? null;
      if (legacyMatches && liveDsh === documentDsh) {
        return;
      }
      // The open socket is already bound to the previous document's session and
      // cannot be reconfigured in place. Refuse the recovered session instead
      // of letting the old connection write its id into the new document.
      // DSH documents have no legacy UUID, so their identity must be compared
      // too or two `null` legacy ids would silently look like a match.
      this.documentLoadErrorState = {
        kind: 'session-mismatch',
        message:
          'This workspace was recovered, but the open agent session belongs to a different document. Reopen the workspace to attach the recovered session; the file is left unchanged to protect it.'
      };
      return;
    }
    this.session.configureContext(this.notebook.agentSessionId);
    this.configureDshSessionFromDocument();
    this.start();
  }

  /**
   * Binds the durable DSH session persisted in the document before the socket
   * connects. `AgentSession.configureDshSession` sends it as the independent
   * `dshSessionId` query parameter and refuses to run on an open socket, so this
   * only ever applies while the workspace is still starting.
   */
  private configureDshSessionFromDocument(): void {
    const reference = getResumableDshSessionReference(this.notebook);
    this.session.configureDshSession(reference?.sessionId ?? null);
  }

  /**
   * Drops the durable DSH binding so a new context cannot resume the previous
   * session: memory, the document reference, and the session URL all forget it.
   */
  private clearDshSessionBinding(): void {
    this.dshOwnedSession = null;
    setAgentSessionReference(this.notebook, null);
  }

  private enterDocumentLoadError(error: unknown): void {
    if (error instanceof UnsupportedWorkspaceVersionError) {
      this.documentLoadErrorState = {
        kind: 'unsupported-version',
        message: `This workspace uses a newer format (v${error.foundVersion}); this build supports v${error.supportedVersion}. Editing and saving are disabled to protect the file.`,
        foundVersion: error.foundVersion,
        supportedVersion: error.supportedVersion
      };
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    this.documentLoadErrorState = {
      kind: 'unknown',
      message: `This workspace could not be loaded; editing and saving are disabled to protect the file. (${detail})`
    };
  }

  private reportDocumentLoadError(): void {
    if (!this.documentLoadErrorState) return;
    this.status.setMessage(this.documentLoadErrorState.message);
  }

  private persistSoon(): void {
    if (
      !this.context ||
      this.applyingModel ||
      this.closing ||
      this.documentLoadErrorState
    ) {
      return;
    }
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
      this.isDisposed ||
      this.documentLoadErrorState
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
    if (this.documentLoadErrorState) {
      throw new Error(
        'Workspace document is protected because it could not be loaded safely.'
      );
    }
    const current = context.model.toString();
    const text = serializeNotebook(this.notebook);
    if (text === current) return;
    // Last line of defense: never overwrite a newer document with the current
    // in-memory model, even if a save was queued before the change was seen.
    try {
      parseWorkspaceSnapshot(current);
    } catch (error) {
      this.enterDocumentLoadError(error);
      this.reportDocumentLoadError();
      throw error;
    }
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
    if (this.documentLoadErrorState) {
      throw new Error(
        'Workspace document is protected because it could not be loaded safely.'
      );
    }
    await context.save();
  }

  private onSaveStateChange(): void {
    if (this.isDisposed) return;
    this.syncWorkspaceChrome();
  }

  private refresh(): void {
    this.notebookView.render(this.documentLoadErrorState !== null);
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
    this.status.sync(
      state,
      workspaceOverview(this.notebook.cells),
      this.session.configurationReport,
      this.session.configurationError,
      {
        usage: this.session.usage,
        models: this.session.models,
        currentModel: this.session.currentModel,
        commands: this.session.commands
      }
    );
    if (this.documentLoadErrorState) {
      // A load protection notice must stay visible across refreshes, unlike a
      // transient status message that the next sync would replace.
      this.status.setMessage(this.documentLoadErrorState.message);
    }
    this.notifyUiState(state);
  }

  /**
   * DSH product events only bind durable identity here: the engine-issued
   * session id is persisted so a reopened document can resume that session.
   * Activity already reaches the Cell through the legacy tool blocks the
   * backend mirrors, the current runtime produces no artifact record, and
   * interactions are resolved by the runtime itself, so none of those records
   * get a second workspace surface.
   */
  private onDshEvent(event: DshProductEvent): void {
    if (this.isDisposed) return;
    switch (event.type) {
      case 'dsh/v1/session':
      case 'dsh/v1/run.started':
        this.adoptDshSession(event.sessionId);
        return;
      default:
        return;
    }
  }

  private adoptDshSession(sessionId: string): void {
    if (this.dshOwnedSession === sessionId) return;
    this.dshOwnedSession = sessionId;
    if (this.documentLoadErrorState) return;
    // A reopened document already carries this exact reference. Re-writing it
    // would dirty an otherwise clean file and race a concurrent writer, which
    // surfaces as Jupyter's "changed on disk" conflict. Persist only when the
    // engine-issued id actually changed.
    const existing = getResumableDshSessionReference(this.notebook);
    if (existing?.sessionId === sessionId) return;
    // Persist only the engine-issued session id, never the runtime or any live
    // state, so reopening the document can resume this exact session.
    setAgentSessionReference(this.notebook, { engine: 'dsh', sessionId });
    this.persistSoon();
  }

  private notifyUiState(state: WorkspaceUiState): void {
    const key = workspaceUiStateKey(state);
    if (key === this.lastUiStateKey) return;
    this.lastUiStateKey = key;
    this.uiListeners.forEach(listener => listener(state));
  }

  /**
   * Configuration refresh is best effort and never opens a connection. A
   * dropped request is reported explicitly so the button cannot look like a
   * success when nothing was sent.
   */
  private requestConfigurationRefresh(): void {
    if (this.session.requestConfiguration() === false) {
      this.status.setMessage(
        'The Agent server is not connected, so configuration cannot be refreshed. Refreshing never opens a connection.'
      );
    }
  }

  /**
   * Switch the session's model through the runtime's ACP config option. The
   * runtime applies a selection from its next model step, so this is allowed
   * while a turn is running instead of silently dropping the click. It never
   * restarts the runtime: a rejected switch surfaces as an error event.
   */
  private selectModel(value: string): void {
    if (!value) return;
    if (this.session.setModel(value) === false) {
      this.status.setMessage(
        'The Agent server is not connected, so the model was not changed.'
      );
    }
  }

  /**
   * Manual compaction: submit the runtime's own `/compact` slash command in a
   * fresh cell so its output uses the normal streaming turn UI.
   */
  private runCompact(): void {
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    if (this.session.running || this.notebook.busy()) {
      this.status.setMessage(
        'Wait for the running turn to finish before compacting.'
      );
      return;
    }
    this.addCellFromFooter();
    this.notebook.setSource('/compact');
    this.refresh();
    this.runCell(false);
  }

  private startNewContext(): void {
    if (this.documentLoadErrorState) {
      this.reportDocumentLoadError();
      return;
    }
    if (this.notebook.activeRun) return;
    this.notebook.startNewAgentContext();
    this.session.resetContext();
    this.clearDshSessionBinding();
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
    this.node.addEventListener(
      'click',
      event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        this.toggleFocusKey =
          target.closest<HTMLElement>('[data-turn-focus-key]')?.dataset
            .turnFocusKey ?? null;
      },
      true
    );
  }

  private readonly footer: HTMLButtonElement;
  private toggleFocusKey: string | null = null;

  /**
   * Consume the focus key of the disclosure control in the click that is
   * currently being handled. The capture-phase listener above observes the
   * click before the control's own handler rebuilds the output.
   */
  takeToggleFocusKey(): string | null {
    const key = this.toggleFocusKey;
    this.toggleFocusKey = null;
    return key;
  }

  toggleElement(focusKey: string): HTMLElement | null {
    return (
      Array.from(
        this.node.querySelectorAll<HTMLElement>('[data-turn-focus-key]')
      ).find(node => node.dataset.turnFocusKey === focusKey) ?? null
    );
  }

  render(readOnly = false): void {
    const seen = new Set<string>();
    this.notebook.cells.forEach((cell, index) => {
      seen.add(cell.id);
      const view =
        this.views.get(cell.id) ?? this.createView(cell, index, readOnly);
      view.sync(cell, index, this.notebook, readOnly);
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
      view.dispose();
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

  private createView(
    cell: WorkspaceCell,
    index: number,
    readOnly: boolean
  ): CellView {
    const view = new CellView(cell.id, this.handlers);
    this.views.set(cell.id, view);
    view.sync(cell, index, this.notebook, readOnly);
    return view;
  }
}

const CELL_INPUT_MAX_HEIGHT = 320;

// A send-back run is acknowledged as delivered only after the main session
// accepts it. If no acceptance arrives in this window the delivery stays
// unproven and the panel asks the user to confirm instead of retrying.
const SEND_BACK_ACCEPT_TIMEOUT_MS = 15000;

function editorLineHeight(editor: HTMLTextAreaElement): number {
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 0;
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) +
    (Number.parseFloat(style.paddingBottom) || 0);
  const border =
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0);
  return lineHeight + padding + border;
}

function editorMaxHeight(editor: HTMLTextAreaElement): number {
  const declared = Number.parseFloat(getComputedStyle(editor).maxHeight);
  return Number.isFinite(declared) && declared > 0
    ? declared
    : CELL_INPUT_MAX_HEIGHT;
}

export class CellView {
  readonly node: HTMLDivElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly inputPrompt: HTMLDivElement;
  private readonly inputCollapser: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver | null;
  private outputRow: HTMLDivElement | null = null;
  private outputPrompt: HTMLDivElement | null = null;
  private outputBody: HTMLDivElement | null = null;
  private outputCollapser: HTMLDivElement | null = null;
  private index = 0;
  private lastOutputKey = '';
  private lastSizedValue: string | null = null;

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
      this.autoSizeEditor();
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
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.autoSizeEditor(true));
    this.resizeObserver?.observe(inputRow);
    this.autoSizeEditor();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
  }

  sync(
    cell: WorkspaceCell,
    index: number,
    notebook: WorkspaceNotebook,
    readOnly = false
  ): void {
    this.index = index;
    const active = index === notebook.active;
    const editing = !readOnly && active && notebook.mode === 'edit';
    this.node.classList.toggle('is-active', active);
    this.node.classList.toggle('is-edit', editing);
    this.node.classList.toggle('is-collapsed', cell.outputCollapsed);
    setPrompt(this.inputPrompt, cell);
    if (
      readOnly ||
      this.editor.readOnly ||
      document.activeElement !== this.editor
    ) {
      this.editor.value = cell.source;
    }
    this.autoSizeEditor();
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

  /**
   * Fits the editor to its wrapped content height so soft-wrapped lines grow
   * the row too; past the maximum the editor scrolls internally instead.
   * Repeated syncs of unchanged text skip re-measuring to avoid layout churn
   * that would move the caret or scroll position.
   */
  private autoSizeEditor(force = false): void {
    const editor = this.editor;
    if (
      !force &&
      editor.style.height !== '' &&
      this.lastSizedValue === editor.value
    ) {
      return;
    }
    const previousHeight = editor.style.height;
    const previousOverflowY = editor.style.overflowY;
    const previousScrollTop = editor.scrollTop;
    editor.style.height = 'auto';
    const scrollHeight = editor.scrollHeight;
    if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) {
      // No layout yet (detached node or jsdom): keep the previous height
      // instead of collapsing the editor to zero.
      editor.style.height = previousHeight;
      editor.style.overflowY = previousOverflowY;
      return;
    }
    const maxHeight = editorMaxHeight(editor);
    const style = getComputedStyle(editor);
    const borderBox =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    const contentHeight = scrollHeight + borderBox;
    const overflow = contentHeight > maxHeight;
    editor.style.height = `${Math.max(
      editorLineHeight(editor),
      Math.min(contentHeight, maxHeight)
    )}px`;
    editor.style.overflowY = overflow ? 'auto' : 'hidden';
    this.lastSizedValue = editor.value;
    if (overflow && previousScrollTop > 0) {
      editor.scrollTop = Math.min(
        previousScrollTop,
        Math.max(0, scrollHeight - editor.clientHeight)
      );
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
    this.autoSizeEditor();
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
      cell.status === 'running' ||
      cell.status === 'pending';
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
      this.turnRenderHandlers(cell)
    );
  }

  private turnRenderHandlers(cell: WorkspaceCell): TurnRenderHandlers {
    // The BTW entry point mirrors the server's answer-card eligibility: a
    // persisted turn with persisted answer text. Legacy cells (blocks only)
    // keep Copy but must not offer a BTW panel that cannot be created.
    const btwEligible = isAnswerCard({
      id: cell.id,
      kind: cell.kind,
      turn: cell.turn,
      blocks: cell.blocks
    });
    return {
      onToggleTrace: turnId =>
        this.handlers.onToggleTurnTrace?.(this.id, turnId),
      onToggleActivity: (turnId, activityId) =>
        this.handlers.onToggleTurnActivity?.(this.id, turnId, activityId),
      onToggleEvidence: (turnId, activityId) =>
        this.handlers.onToggleTurnEvidence?.(this.id, turnId, activityId),
      onRevealFailure: (turnId, activityId) =>
        this.handlers.onRevealTurnFailure?.(this.id, turnId, activityId),
      onRetry: turnId => this.handlers.onRetryTurn?.(this.id, turnId),
      onBtw: btwEligible
        ? turnId => this.handlers.onBtwTurn?.(this.id, turnId)
        : undefined
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

function cellCompletionOutcome(cell: WorkspaceCell): {
  type: 'success' | 'warning' | 'error';
  label: string;
} {
  const turn = cell.turn;
  if (turn?.status === 'error' || turn?.resultIsError) {
    return { type: 'error', label: 'failed' };
  }
  if (cell.status === 'interrupted' || turn?.status === 'interrupted') {
    return { type: 'warning', label: 'interrupted' };
  }
  return { type: 'success', label: 'completed' };
}

export interface StatusBarSessionMeta {
  usage: { used: number; size: number } | null;
  models: AgentModelOption[];
  currentModel: string | null;
  commands: string[];
}

export const EMPTY_STATUS_META: StatusBarSessionMeta = {
  usage: null,
  models: [],
  currentModel: null,
  commands: []
};

/** Compact token counts for the dense status bar (1.2k, 8.0k, 1.3m). */
function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}m`;
}

export interface StatusBarHandlers {
  onStartNewContext: () => void;
  onContinueFromHistory: () => void;
  onStartEmptyContext: () => void;
  onDismissContextChoice: () => void;
  onOpenHistory: () => void;
  onRefreshConfiguration: () => void;
  onRetrySave: () => void;
  onSelectModel?: (value: string) => void;
  onCompact?: () => void;
}

export class StatusBar extends Widget {
  private readonly connection: HTMLSpanElement;
  /**
   * Kept for internal state/tests but never shown: the bottom context dropdown
   * was removed in favor of the right-side session navigation.
   */
  private readonly contextButton: HTMLButtonElement;
  private readonly cwd: HTMLSpanElement;
  private readonly overviewButton: HTMLButtonElement;
  private readonly execution: HTMLSpanElement;
  private readonly saveGroup: HTMLDivElement;
  private readonly saveStatus: HTMLSpanElement;
  private readonly retrySaveButton: HTMLButtonElement;
  private readonly contextDescription: HTMLDivElement;
  /** Hidden popover host; the history-choice prompt still renders inside it. */
  private readonly contextPopover: HTMLDivElement;
  private readonly resetContextButton: HTMLButtonElement;
  private readonly configurationDetails: HTMLDetailsElement;
  private readonly configurationContent: HTMLDivElement;
  private readonly configurationError: HTMLDivElement;
  private lastConfigurationKey = '';
  private readonly historyChoice: HTMLDivElement;
  private readonly historyChoiceDescription: HTMLDivElement;
  private readonly continueHistoryButton: HTMLButtonElement;
  private readonly emptyContextButton: HTMLButtonElement;
  private historyChoiceBusy = false;
  private lastSyncKey = '';
  private readonly modelGroup: HTMLLabelElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly usage: HTMLSpanElement;
  private readonly compactButton: HTMLButtonElement;

  constructor(
    private readonly handlers: StatusBarHandlers = {
      onStartNewContext: () => undefined,
      onContinueFromHistory: () => undefined,
      onStartEmptyContext: () => undefined,
      onDismissContextChoice: () => undefined,
      onOpenHistory: () => undefined,
      onRefreshConfiguration: () => undefined,
      onRetrySave: () => undefined,
      onSelectModel: () => undefined,
      onCompact: () => undefined
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
    // The visible trigger is removed; the element stays hidden so the
    // workspace's automatic history-choice prompt can still render.
    this.contextButton.hidden = true;
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
    this.configurationDetails = document.createElement('details');
    this.configurationDetails.className = 'jp-AgentWorkspace-configuration';
    const configurationSummary = document.createElement('summary');
    configurationSummary.textContent = 'Effective configuration';
    const refreshConfigurationButton = document.createElement('button');
    refreshConfigurationButton.type = 'button';
    refreshConfigurationButton.className =
      'jp-AgentWorkspace-refreshConfiguration';
    refreshConfigurationButton.textContent = 'Refresh configuration';
    refreshConfigurationButton.addEventListener('click', () => {
      this.handlers.onRefreshConfiguration();
    });
    this.configurationContent = document.createElement('div');
    this.configurationContent.className =
      'jp-AgentWorkspace-configurationContent';
    this.configurationError = document.createElement('div');
    this.configurationError.className = 'jp-AgentWorkspace-configurationError';
    this.configurationError.setAttribute('role', 'status');
    this.configurationError.setAttribute('aria-live', 'polite');
    this.configurationError.setAttribute('aria-atomic', 'true');
    this.configurationError.hidden = true;
    this.configurationDetails.append(
      configurationSummary,
      refreshConfigurationButton,
      this.configurationContent
    );
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
    this.historyChoice.hidden = true;
    this.contextPopover.append(
      this.contextDescription,
      this.resetContextButton,
      this.configurationDetails,
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
    });
    this.modelGroup = document.createElement('label');
    this.modelGroup.className = 'jp-AgentWorkspace-statusModel';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'jp-AgentWorkspace-statusModelLabel';
    modelLabel.textContent = 'Model';
    this.modelSelect = document.createElement('select');
    this.modelSelect.className = 'jp-AgentWorkspace-statusModelSelect';
    this.modelSelect.setAttribute('aria-label', 'Model'); // eslint-disable-line jupyter/no-untranslated-string
    this.modelSelect.addEventListener('change', () => {
      const value = this.modelSelect.value;
      if (!value) return;
      this.handlers.onSelectModel?.(value);
    });
    this.modelGroup.append(modelLabel, this.modelSelect);

    this.usage = document.createElement('span');
    this.usage.className = 'jp-AgentWorkspace-statusUsage';
    this.usage.setAttribute('role', 'status');
    this.usage.hidden = true;

    this.compactButton = document.createElement('button');
    this.compactButton.type = 'button';
    this.compactButton.className = 'jp-AgentWorkspace-statusCompact';
    this.compactButton.textContent = 'Compact';
    this.compactButton.title = 'Compact the current context now'; // eslint-disable-line jupyter/no-untranslated-string
    this.compactButton.hidden = true;
    this.compactButton.addEventListener('click', () => {
      if (this.compactButton.disabled) return;
      this.handlers.onCompact?.();
    });

    this.node.append(
      this.connection,
      this.contextButton,
      this.cwd,
      this.saveGroup,
      this.execution,
      this.usage,
      this.compactButton,
      this.modelGroup,
      this.contextPopover
    );
  }

  sync(
    state: WorkspaceUiState,
    overview = workspaceOverview([]),
    configuration: ConfigurationReport | null = null,
    configurationError: string | null = null,
    meta: StatusBarSessionMeta = EMPTY_STATUS_META
  ): void {
    this.syncConfiguration(configuration, configurationError);
    this.syncSessionMeta(state, meta);
    const key = `${workspaceUiStateKey(state)}|${JSON.stringify(overview)}`;
    if (key === this.lastSyncKey) return;
    this.lastSyncKey = key;
    this.connection.textContent = state.connectionLabel;
    this.connection.classList.toggle('is-error', Boolean(state.error));
    this.connection.classList.toggle('is-connected', state.connected);
    this.cwd.textContent = state.cwd ?? 'Local tools';
    this.cwd.title = state.cwd ?? '';
    // Kept for the hidden trigger's state and the history-choice description.
    this.contextButton.textContent = state.contextLabel;
    this.contextButton.classList.toggle(
      'is-unavailable',
      state.contextState === 'unavailable'
    );
    this.contextDescription.textContent = contextDescription(state);
    this.resetContextButton.disabled = state.activeRun !== null;
    this.overviewButton.textContent = overview.summaryLabel;
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

  /**
   * Session-scoped controls (model, context usage, manual compaction). These
   * are rendered even while the workspace is idle and never change turn state.
   */
  private syncSessionMeta(
    state: WorkspaceUiState,
    meta: StatusBarSessionMeta
  ): void {
    this.syncModel(meta);
    this.syncUsage(meta.usage);
    // The runtime does not advertise slash commands consistently across DSH
    // versions, but manual compaction is still a product action. Keep the
    // control available whenever this page owns a connected context.
    const compactAvailable =
      state.connected &&
      state.contextState !== 'unavailable' &&
      state.contextState !== 'connecting';
    this.compactButton.hidden = !compactAvailable;
    this.compactButton.disabled = !compactAvailable || state.activeRun !== null;
  }

  private syncModel(meta: StatusBarSessionMeta): void {
    const models = meta.models;
    const key = `${models.map(model => `${model.id}\u0000${model.name}`).join('\u0001')}|${
      meta.currentModel ?? ''
    }`;
    this.modelGroup.hidden = models.length === 0;
    if (models.length === 0) return;
    if (this.modelSelect.dataset.key !== key) {
      this.modelSelect.dataset.key = key;
      this.modelSelect.replaceChildren(
        ...models.map(model => {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.name;
          return option;
        })
      );
    }
    const current = meta.currentModel ?? models[0]?.id ?? '';
    if (current && this.modelSelect.value !== current) {
      this.modelSelect.value = current;
    }
    this.modelSelect.disabled = models.length <= 1;
    this.modelSelect.title = current
      ? `Current model: ${models.find(model => model.id === current)?.name ?? current}`
      : 'Select a model';
  }

  private syncUsage(usage: { used: number; size: number } | null): void {
    if (!usage || usage.size <= 0) {
      this.usage.hidden = true;
      this.usage.textContent = '';
      this.usage.title = '';
      return;
    }
    const used = Math.max(0, Math.min(usage.used, usage.size));
    const percent = Math.min(100, Math.round((used / usage.size) * 100));
    this.usage.hidden = false;
    this.usage.textContent = `${formatTokenCount(used)} / ${formatTokenCount(
      usage.size
    )} · ${percent}%`;
    this.usage.title = `Context used ${used} of ${usage.size} tokens (${percent}%)`;
    this.usage.classList.toggle('is-warning', percent >= 80);
    this.usage.classList.toggle('is-critical', percent >= 95);
  }

  setMessage(message: string): void {
    this.lastSyncKey = '';
    this.execution.textContent = message;
  }

  private syncConfiguration(
    configuration: ConfigurationReport | null,
    error: string | null
  ): void {
    const key = `${
      configuration ? JSON.stringify(configuration) : 'unavailable'
    }|${error ?? ''}`;
    if (key === this.lastConfigurationKey) return;
    this.lastConfigurationKey = key;
    // The failure notice is its own persistent row: the last validated report
    // (if any) stays rendered instead of being replaced by the error, and only
    // the frontend message reaches the DOM, never raw server text.
    this.configurationError.textContent = error ?? '';
    this.configurationError.hidden = error === null;
    this.configurationContent.replaceChildren(
      this.configurationError,
      ...renderConfigurationReport(configuration)
    );
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
    if (!this.contextPopover.contains(this.historyChoice)) {
      this.contextPopover.append(this.historyChoice);
    }
    this.setHistoryChoiceBusy(false);
    this.setContextOpen(true);
    queueMicrotask(() => {
      this.continueHistoryButton.focus({ preventScroll: true });
    });
  }

  closeHistoryChoice(): void {
    this.historyChoice.hidden = true;
    // Detach so a cancelled choice leaves no stale buttons in the popover.
    this.historyChoice.remove();
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

function configurationLine(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'jp-AgentWorkspace-configurationLine';
  const labelNode = document.createElement('span');
  labelNode.className = 'jp-AgentWorkspace-configurationLabel';
  labelNode.textContent = label;
  const valueNode = document.createElement('span');
  valueNode.className = 'jp-AgentWorkspace-configurationValue';
  valueNode.textContent = value;
  row.append(labelNode, valueNode);
  return row;
}

function configurationHeading(text: string): HTMLElement {
  const heading = document.createElement('div');
  heading.className = 'jp-AgentWorkspace-configurationHeading';
  heading.textContent = text;
  return heading;
}

function configurationStateLabel(state: ConfigurationReport['state']): string {
  switch (state) {
    case 'active':
      return 'Active: these values are applied to the currently running runtime.';
    case 'pending-next-runtime':
      return 'Pending next runtime: saved changes are not active now. They apply only when the runtime next starts normally, for example after an administrator explicitly restarts Jupyter. A new session does not activate them, and this panel never restarts or interrupts the runtime.';
    case 'not-started':
      return 'Not started: the runtime has not started, so no active configuration is applied yet.';
    case 'snapshot-unavailable':
      return 'Snapshot unavailable: the runtime did not report effective values, so active and desired values cannot be shown.';
  }
}

function configurationCompactionLabel(
  compaction: ConfigurationReport['compaction']
): string {
  return compaction === 'disabled'
    ? 'Compaction: disabled was reported for this runtime.'
    : 'Compaction: not observable. The runtime did not prove whether compaction is active.';
}

function formatDifferenceValue(value: ConfigurationDifferenceValue): string {
  if (value === null) return 'none';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, leaf]) => `${key}: ${formatDifferenceValue(leaf)}`)
      .join(', ');
  }
  return String(value);
}

function appendBudgetSnapshot(
  parent: HTMLElement,
  title: string,
  snapshot: BudgetSnapshot | null
): void {
  parent.append(configurationHeading(title));
  if (!snapshot) {
    parent.append(configurationLine('Values', 'Not reported by the runtime.'));
    return;
  }
  if (snapshot.contextWindow !== undefined) {
    parent.append(
      configurationLine(
        'Context window',
        `${snapshot.contextWindow} tokens (declared metadata, not measured capacity)`
      )
    );
  }
  if (snapshot.maxOutputTokens !== undefined) {
    parent.append(
      configurationLine('Max output tokens', String(snapshot.maxOutputTokens))
    );
  }
  const compaction = snapshot.compaction;
  if (compaction) {
    if (compaction.enabled !== undefined) {
      parent.append(
        configurationLine(
          'Compaction enabled',
          compaction.enabled ? 'yes' : 'no'
        )
      );
    }
    if (compaction.thresholdRatio !== undefined) {
      parent.append(
        configurationLine(
          'Compaction threshold ratio',
          String(compaction.thresholdRatio)
        )
      );
    }
    if (compaction.headroom !== undefined) {
      parent.append(
        configurationLine('Compaction headroom', String(compaction.headroom))
      );
    }
    if (compaction.retainRatio !== undefined) {
      parent.append(
        configurationLine(
          'Compaction retain ratio',
          String(compaction.retainRatio)
        )
      );
    }
    if (compaction.summaryMaxTokens !== undefined) {
      parent.append(
        configurationLine(
          'Compaction summary max tokens',
          String(compaction.summaryMaxTokens)
        )
      );
    }
  }
  const computed = snapshot.computed;
  if (computed) {
    if (computed.messageBudget !== undefined) {
      parent.append(
        configurationLine(
          'Computed message budget',
          String(computed.messageBudget)
        )
      );
    }
    if (computed.pressure !== undefined) {
      parent.append(
        configurationLine('Computed pressure', String(computed.pressure))
      );
    }
    if (computed.threshold !== undefined) {
      parent.append(
        configurationLine('Computed threshold', String(computed.threshold))
      );
    }
    if (computed.retain !== undefined) {
      parent.append(
        configurationLine('Computed retain', String(computed.retain))
      );
    }
  }
  const provenance = snapshot.provenance;
  if (provenance) {
    const entries = Object.entries(provenance) as [
      BudgetFieldName,
      BudgetProvenanceEntry
    ][];
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([field, entry]) => {
        const derived = entry.derivedFrom?.length
          ? ` (derived from ${entry.derivedFrom.join(', ')})`
          : '';
        parent.append(
          configurationLine(`Provenance ${field}`, `${entry.source}${derived}`)
        );
      });
  }
}

/**
 * Render only validated, presentation-safe report fields with textContent.
 * No raw settings, tokens, or unknown keys can reach the DOM: the report was
 * already projected onto the protocol whitelist before it arrived here.
 */
function renderConfigurationReport(
  report: ConfigurationReport | null
): HTMLElement[] {
  if (!report) {
    const unavailable = document.createElement('div');
    unavailable.className = 'jp-AgentWorkspace-configurationUnavailable';
    unavailable.textContent =
      'Effective configuration is unavailable until the runtime reports it. No values are inferred.';
    return [unavailable];
  }
  const nodes: HTMLElement[] = [];
  const stateNode = document.createElement('div');
  stateNode.className = 'jp-AgentWorkspace-configurationState';
  stateNode.textContent = configurationStateLabel(report.state);
  nodes.push(
    configurationLine('Runtime lifetime', report.runtimeLifetime),
    configurationLine('Configuration generation', String(report.generation)),
    stateNode,
    configurationLine(
      'Preflight applied',
      report.preflightApplied ? 'yes' : 'no'
    )
  );

  const activeSection = document.createElement('div');
  activeSection.className = 'jp-AgentWorkspace-configurationSnapshot';
  appendBudgetSnapshot(
    activeSection,
    'Active (current runtime)',
    report.active
  );
  nodes.push(activeSection);

  const desiredSection = document.createElement('div');
  desiredSection.className = 'jp-AgentWorkspace-configurationSnapshot';
  appendBudgetSnapshot(
    desiredSection,
    'Desired (saved settings)',
    report.desired
  );
  nodes.push(desiredSection);

  nodes.push(
    configurationLine(
      'Compaction observation',
      configurationCompactionLabel(report.compaction)
    )
  );

  const differencePaths = Object.keys(report.differences)
    // An empty path is a valid report key but renders as a blank label, so it
    // is skipped instead of producing an unlabeled difference row.
    .filter(path => path.trim() !== '')
    .sort();
  nodes.push(configurationHeading('Differences'));
  if (!differencePaths.length) {
    nodes.push(configurationLine('Reported', 'No differences.'));
  } else {
    differencePaths.forEach(path => {
      const difference = report.differences[path];
      nodes.push(
        configurationLine(
          path,
          `${formatDifferenceValue(
            difference.active
          )} → ${formatDifferenceValue(difference.desired)}`
        )
      );
    });
  }

  const capacityNote = document.createElement('div');
  capacityNote.className = 'jp-AgentWorkspace-configurationNote';
  capacityNote.textContent =
    'Context window is declared metadata, not measured capacity. A larger budget does not repair gateway or provider truncation.';
  nodes.push(capacityNote);
  return nodes;
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
    cell.status === 'queued' ||
    cell.status === 'running' ||
    cell.status === 'pending'
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
  if (
    !cell.blocks.length &&
    cell.status !== 'running' &&
    cell.status !== 'pending'
  ) {
    return null;
  }
  const status =
    cell.status === 'running'
      ? 'running'
      : cell.status === 'pending'
        ? 'pending'
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
