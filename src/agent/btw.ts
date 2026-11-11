import { Widget } from '@lumino/widgets';

import {
  btwAck,
  btwCancel,
  btwCancelQueued,
  btwClaim,
  btwEnqueue,
  btwOpenThread,
  btwRestoreThread,
  btwSend,
  type BtwQueueEntry,
  type BtwThread
} from './btw-protocol';
import { writeClipboardText } from './selectioncopy';

/** Outcome of inserting send-back text into the main notebook. */
export type BtwSendBackOutcome =
  | { status: 'sent'; runId: string }
  | { status: 'inserted' }
  | { status: 'blocked'; message: string };

export interface BtwPanelOptions {
  /** Notebook path relative to the Jupyter server root, or null when unsaved. */
  notebook: () => string | null;
  /** Whether the main agent is currently running a turn. */
  isMainBusy: () => boolean;
  /**
   * Whether the main session can accept a run right now. When this is false
   * the panel leaves the queued entry alone instead of claiming it.
   */
  canSend: () => boolean;
  /**
   * Insert the text into a new main input cell and submit it. Only a ``sent``
   * result means the main run was accepted by the notebook queue.
   */
  sendBack: (text: string) => BtwSendBackOutcome;
  /** Resolve once the main session accepted the run, or false on timeout. */
  awaitAccepted: (runId: string) => Promise<boolean>;
  /** Flush the notebook document so the delivered cell is on disk. */
  flush: () => Promise<void>;
  /** Answer cards in document order, used for the local source label. */
  answerNumber: (cellId: string) => number | null;
  requestId?: () => string;
}

const BTW_TITLE_PREFIX = 'BTW';

function newRequestId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Right-side BTW panel for one answer card.
 *
 * Opening the panel never calls the model: the thread (and its fixed snapshot)
 * is created on the first sent message. Closing only hides the widget; the
 * thread and its stored messages stay on the server. Stop cancels only this BTW
 * thread and never touches the main session.
 */
export class BtwPanel extends Widget {
  private readonly titleNode: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly messages: HTMLOListElement;
  private readonly composer: HTMLFormElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly queueSection: HTMLElement;
  private readonly queueList: HTMLUListElement;
  private readonly preview: HTMLElement;
  private readonly previewInput: HTMLTextAreaElement;
  private readonly previewConfirm: HTMLButtonElement;
  private readonly previewCancel: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  private cellId: string | null = null;
  /**
   * Bumped by every ``open``. Async results captured for an older generation
   * are dropped so a slow restore/send for card A can never paint card B or
   * send with A's thread id.
   */
  private generation = 0;
  private thread: BtwThread | null = null;
  private notStarted = true;
  private busy = false;
  private delivering = false;
  private pendingPreview: string | null = null;
  private previewRequestId: string | null = null;
  private readonly requestId: () => string;

  constructor(private readonly options: BtwPanelOptions) {
    super();
    this.addClass('jp-BtwPanel');
    this.node.setAttribute('role', 'complementary');
    this.node.setAttribute('aria-label', 'BTW side chat'); // eslint-disable-line jupyter/no-untranslated-string
    this.node.tabIndex = -1;
    this.requestId = options.requestId ?? newRequestId;

    const header = document.createElement('header');
    header.className = 'jp-BtwPanel-header';
    this.titleNode = document.createElement('h2');
    this.titleNode.className = 'jp-BtwPanel-title';
    this.titleNode.textContent = BTW_TITLE_PREFIX;
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'jp-BtwPanel-close';
    this.closeButton.setAttribute('aria-label', 'Close BTW panel'); // eslint-disable-line jupyter/no-untranslated-string
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', event => {
      event.preventDefault();
      this.hidePanel();
    });
    header.append(this.titleNode, this.closeButton);

    this.meta = document.createElement('div');
    this.meta.className = 'jp-BtwPanel-meta';
    this.meta.setAttribute('role', 'status');
    this.meta.setAttribute('aria-live', 'polite');

    this.errorBox = document.createElement('div');
    this.errorBox.className = 'jp-BtwPanel-error';
    this.errorBox.setAttribute('role', 'alert');
    this.errorBox.hidden = true;

    this.messages = document.createElement('ol');
    this.messages.className = 'jp-BtwPanel-messages';
    this.messages.setAttribute('role', 'log');
    this.messages.setAttribute('aria-live', 'polite');
    this.messages.setAttribute('aria-relevant', 'additions text');

    this.queueSection = document.createElement('section');
    this.queueSection.className = 'jp-BtwPanel-queue';
    const queueHeading = document.createElement('h3');
    queueHeading.className = 'jp-BtwPanel-queueHeading';
    queueHeading.textContent = 'Send to main session';
    this.queueList = document.createElement('ul');
    this.queueList.className = 'jp-BtwPanel-queueList';
    this.queueSection.append(queueHeading, this.queueList);
    this.queueSection.hidden = true;

    this.preview = document.createElement('div');
    this.preview.className = 'jp-BtwPanel-preview';
    this.preview.hidden = true;
    const previewLabel = document.createElement('label');
    previewLabel.className = 'jp-BtwPanel-previewLabel';
    previewLabel.textContent = 'Preview the text to send back';
    this.previewInput = document.createElement('textarea');
    this.previewInput.className = 'jp-BtwPanel-previewInput';
    this.previewInput.rows = 6;
    this.previewInput.setAttribute('aria-label', 'Send-back preview'); // eslint-disable-line jupyter/no-untranslated-string
    previewLabel.append(this.previewInput);
    this.previewConfirm = document.createElement('button');
    this.previewConfirm.type = 'button';
    this.previewConfirm.className = 'jp-BtwPanel-button is-primary';
    this.previewConfirm.textContent = 'Queue for main session';
    this.previewConfirm.addEventListener('click', event => {
      event.preventDefault();
      void this.confirmPreview();
    });
    this.previewCancel = document.createElement('button');
    this.previewCancel.type = 'button';
    this.previewCancel.className = 'jp-BtwPanel-button';
    this.previewCancel.textContent = 'Cancel';
    this.previewCancel.addEventListener('click', event => {
      event.preventDefault();
      this.closePreview();
    });
    const previewActions = document.createElement('div');
    previewActions.className = 'jp-BtwPanel-previewActions';
    previewActions.append(this.previewConfirm, this.previewCancel);
    this.preview.append(previewLabel, previewActions);

    this.composer = document.createElement('form');
    this.composer.className = 'jp-BtwPanel-composer';
    this.input = document.createElement('textarea');
    this.input.className = 'jp-BtwPanel-input';
    this.input.rows = 3;
    this.input.setAttribute('aria-label', 'BTW message'); // eslint-disable-line jupyter/no-untranslated-string
    this.input.placeholder = 'Ask a side question about this answer…';
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'submit';
    this.sendButton.className = 'jp-BtwPanel-button is-primary';
    this.sendButton.textContent = 'Send';
    this.stopButton = document.createElement('button');
    this.stopButton.type = 'button';
    this.stopButton.className = 'jp-BtwPanel-button';
    this.stopButton.textContent = 'Stop';
    this.stopButton.disabled = true;
    this.stopButton.addEventListener('click', event => {
      event.preventDefault();
      void this.stop();
    });
    const composerActions = document.createElement('div');
    composerActions.className = 'jp-BtwPanel-composerActions';
    composerActions.append(this.stopButton, this.sendButton);
    this.composer.append(this.input, composerActions);
    this.composer.addEventListener('submit', event => {
      event.preventDefault();
      void this.send();
    });
    this.input.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void this.send();
      }
    });
    this.node.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hidePanel();
      }
    });

    this.node.append(
      header,
      this.meta,
      this.errorBox,
      this.messages,
      this.queueSection,
      this.preview,
      this.composer
    );
    this.hide();
    this.render();
  }

  get activeCellId(): string | null {
    return this.cellId;
  }

  get visible(): boolean {
    return !this.isHidden;
  }

  /** Show the panel for one answer card; never starts a model call. */
  async open(cellId: string): Promise<void> {
    const generation = ++this.generation;
    this.cellId = cellId;
    this.thread = null;
    this.busy = false;
    this.notStarted = true;
    this.closePreview();
    this.showError(null);
    this.setTitle(this.options.answerNumber(cellId));
    this.show();
    this.render();
    await this.restore();
    if (generation !== this.generation) return;
    this.input.focus({ preventScroll: true });
  }

  /** Hide the panel. The thread and its messages stay on the server. */
  hidePanel(): void {
    this.closePreview();
    this.hide();
  }

  /** Recover a stored thread for a cell, if one exists. */
  async restore(): Promise<void> {
    const generation = this.generation;
    const notebook = this.options.notebook();
    const cellId = this.cellId;
    if (!notebook || !cellId) {
      this.showError('Save this workspace as a notebook before using BTW.');
      return;
    }
    try {
      const { thread } = await btwRestoreThread(notebook, cellId);
      if (generation !== this.generation) return;
      this.thread = thread;
      this.notStarted = thread === null;
      if (thread) {
        this.setTitle(thread.answerNumber);
      }
      this.render();
      if (thread) {
        void this.deliverPending();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleError(error);
    }
  }

  /**
   * Deliver the oldest queued send-back once the main session can accept it.
   *
   * The claim is single-flight on both sides: the server refuses a second
   * claim while any entry is ``delivering``, and this panel never overlaps two
   * claims. ``delivered`` is only sent after the main session reports the run
   * as accepted *and* the notebook document has been flushed, so the stored
   * outcome cannot claim delivery that is not on disk.
   */
  async deliverPending(): Promise<void> {
    const notebook = this.options.notebook();
    if (!notebook) return;
    if (this.delivering || this.pendingPreview !== null) return;
    if (
      !this.thread ||
      !this.thread.queue.some(entry => entry.status === 'queued')
    ) {
      return;
    }
    if (!this.options.canSend()) {
      this.renderMeta();
      return;
    }
    this.delivering = true;
    let claimed: (BtwQueueEntry & { threadId: string }) | null = null;
    try {
      try {
        claimed = (await btwClaim(notebook)).entry;
      } catch (error) {
        this.handleError(error);
        return;
      }
      if (!claimed) return;
      const outcome = this.options.sendBack(claimed.text);
      if (outcome.status === 'blocked') {
        // Show why this answer can never be delivered automatically instead of
        // a generic failure; the entry itself is marked failed, not retried.
        this.showError(outcome.message);
        await this.settle(notebook, claimed, 'failed');
        return;
      }
      if (outcome.status === 'inserted') {
        // Inserted but not accepted (the main session became busy in between).
        // Nothing can prove it was delivered, so the entry needs an explicit
        // user decision instead of an automatic retry.
        await this.settle(notebook, claimed, 'unknown');
        return;
      }
      const accepted = await this.options.awaitAccepted(outcome.runId);
      if (!accepted) {
        await this.settle(notebook, claimed, 'unknown');
        return;
      }
      try {
        await this.options.flush();
      } catch {
        // The run was accepted but the document did not flush: the cell is not
        // proven on disk, so do not report it as delivered.
        await this.settle(notebook, claimed, 'unknown');
        return;
      }
      await this.settle(notebook, claimed, 'delivered');
    } finally {
      this.delivering = false;
      await this.refreshQueue();
    }
  }

  /** Acknowledge one claimed entry, tolerating an already-terminal outcome. */
  private async settle(
    notebook: string,
    claimed: BtwQueueEntry,
    outcome: 'delivered' | 'failed' | 'unknown'
  ): Promise<void> {
    const claimId = claimed.claimId;
    if (!claimId) {
      this.showError(
        'The send-back claim was lost; reload the panel before retrying.'
      );
      return;
    }
    try {
      await btwAck(notebook, claimed.requestId, claimId, outcome);
    } catch (error) {
      this.handleError(error);
    }
  }

  private setTitle(answerNumber: number | null): void {
    this.titleNode.textContent =
      answerNumber === null
        ? BTW_TITLE_PREFIX
        : `${BTW_TITLE_PREFIX} · source answer #${answerNumber}`;
  }

  private async send(): Promise<void> {
    if (this.busy || !this.cellId) return;
    const text = this.input.value.trim();
    if (!text) return;
    const notebook = this.options.notebook();
    if (!notebook) {
      this.showError('Save this workspace as a notebook before using BTW.');
      return;
    }
    const generation = this.generation;
    const cellId = this.cellId;
    this.busy = true;
    this.showError(null);
    this.input.value = '';
    this.render();
    try {
      if (!this.thread) {
        const opened = await btwOpenThread(notebook, cellId);
        if (generation !== this.generation) return;
        this.thread = opened.thread;
        this.notStarted = false;
        this.setTitle(opened.thread.answerNumber);
        this.render();
      }
      const thread = this.thread;
      if (!thread) return;
      const result = await btwSend(notebook, thread.threadId, text);
      if (generation !== this.generation) return;
      this.thread = result.thread;
      if (result.thread.error) {
        this.showError(result.thread.error);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleError(error);
    } finally {
      // A stale response must not clear the busy flag of the card now shown.
      if (generation === this.generation) {
        this.busy = false;
        this.render();
        await this.refreshQueue();
      }
    }
  }

  private async stop(): Promise<void> {
    const generation = this.generation;
    const notebook = this.options.notebook();
    const thread = this.thread;
    if (!notebook || !thread) return;
    try {
      const result = await btwCancel(notebook, thread.threadId);
      if (generation !== this.generation) return;
      this.thread = result.thread;
      this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleError(error);
    }
  }

  private openPreview(text: string): void {
    this.pendingPreview = text;
    // One preview owns one request id; a failed enqueue retries with the same
    // id so the server can keep the queue deduplicated.
    this.previewRequestId = this.requestId();
    this.previewInput.value = text;
    this.preview.hidden = false;
    this.previewInput.focus({ preventScroll: true });
  }

  private closePreview(): void {
    this.pendingPreview = null;
    this.previewRequestId = null;
    this.preview.hidden = true;
    this.previewInput.value = '';
  }

  private async confirmPreview(): Promise<void> {
    const notebook = this.options.notebook();
    const thread = this.thread;
    const text = this.previewInput.value.trim();
    if (!notebook || !thread) return;
    if (!text) {
      this.showError('The send-back text is empty.');
      return;
    }
    const generation = this.generation;
    const requestId = this.previewRequestId ?? this.requestId();
    this.previewRequestId = requestId;
    try {
      await btwEnqueue(notebook, thread.threadId, requestId, text);
      if (generation !== this.generation) return;
      // Only a successful enqueue consumes the id.
      this.closePreview();
      await this.refreshQueue();
      await this.deliverPending();
    } catch (error) {
      this.handleError(error);
    }
  }

  private async resendUnknown(entry: BtwQueueEntry): Promise<void> {
    const notebook = this.options.notebook();
    const thread = this.thread;
    if (!notebook || !thread) return;
    try {
      // A new request id is a new user confirmation; the unknown entry is
      // never replayed under its original id.
      const generation = this.generation;
      await btwEnqueue(notebook, thread.threadId, this.requestId(), entry.text);
      if (generation !== this.generation) return;
      await this.refreshQueue();
      await this.deliverPending();
    } catch (error) {
      this.handleError(error);
    }
  }

  private async cancelQueued(entry: BtwQueueEntry): Promise<void> {
    const notebook = this.options.notebook();
    if (!notebook) return;
    try {
      await btwCancelQueued(notebook, entry.requestId, entry.claimId);
      await this.refreshQueue();
    } catch (error) {
      this.handleError(error);
    }
  }

  private async refreshQueue(): Promise<void> {
    const generation = this.generation;
    const notebook = this.options.notebook();
    const thread = this.thread;
    if (!notebook || !thread) {
      this.renderQueue();
      return;
    }
    try {
      const { thread: restored } = await btwRestoreThread(
        notebook,
        thread.cellId
      );
      if (generation !== this.generation) return;
      if (restored) {
        this.thread = restored;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleError(error);
    }
    this.renderQueue();
  }

  private handleError(error: unknown): void {
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'BTW request failed.';
    this.showError(message);
  }

  private showError(message: string | null): void {
    this.errorBox.hidden = message === null;
    this.errorBox.textContent = message ?? '';
  }

  private render(): void {
    this.renderMeta();
    this.renderMessages();
    this.renderQueue();
    this.sendButton.disabled = this.busy;
    // Stop stays available for a thread the server reports as busy, so a page
    // reload during a BTW answer can still cancel it.
    this.stopButton.disabled = !(this.busy || Boolean(this.thread?.busy));
    this.input.setAttribute('aria-busy', this.busy ? 'true' : 'false');
  }

  private renderMeta(): void {
    const thread = this.thread;
    if (!thread) {
      this.meta.textContent = this.notStarted
        ? 'Not started. Sending the first message creates this side chat.'
        : '';
      return;
    }
    const snapshot = thread.snapshot;
    const notes: string[] = [
      `Snapshot captured ${snapshot.capturedAt || 'unknown'} · source answer #${
        thread.answerNumber
      } · status ${snapshot.terminalStatus}`
    ];
    if (snapshot.omittedPairs > 0) {
      notes.push(
        `${snapshot.omittedPairs} earlier question/answer pair(s) omitted from the snapshot.`
      );
    }
    if (snapshot.truncated) {
      notes.push('The source answer was truncated in the snapshot.');
    }
    if (thread.messagesOmitted > 0) {
      notes.push(
        `${thread.messagesOmitted} earlier BTW message(s) are no longer shown.`
      );
    }
    if (this.busy) {
      notes.push('BTW is answering…');
    } else if (this.options.isMainBusy()) {
      notes.push('The main session is busy; send-back waits for it to finish.');
    }
    this.meta.textContent = notes.join(' ');
  }

  private renderMessages(): void {
    this.messages.replaceChildren();
    const thread = this.thread;
    if (!thread) return;
    for (const message of thread.messages) {
      const item = document.createElement('li');
      item.className = `jp-BtwPanel-message is-${message.role} is-${message.status}`;
      item.dataset.messageId = message.id;
      const body = document.createElement('div');
      body.className = 'jp-BtwPanel-messageBody';
      body.textContent = message.text;
      item.append(body);
      const actions = document.createElement('div');
      actions.className = 'jp-BtwPanel-messageActions';
      if (message.role === 'assistant') {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'jp-BtwPanel-button';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', 'Copy BTW answer'); // eslint-disable-line jupyter/no-untranslated-string
        copy.addEventListener('click', event => {
          event.preventDefault();
          void writeClipboardText(message.text).then(copied => {
            copy.textContent = copied ? 'Copied' : 'Copy failed';
            window.setTimeout(() => {
              copy.textContent = 'Copy';
            }, 2000);
          });
        });
        const sendBack = document.createElement('button');
        sendBack.type = 'button';
        sendBack.className = 'jp-BtwPanel-button';
        sendBack.textContent = 'Send to main session';
        sendBack.addEventListener('click', event => {
          event.preventDefault();
          this.openPreview(message.text);
        });
        actions.append(copy, sendBack);
      }
      if (message.status !== 'done') {
        const status = document.createElement('span');
        status.className = 'jp-BtwPanel-messageStatus';
        status.textContent = message.status;
        actions.append(status);
      }
      if (actions.childElementCount) item.append(actions);
      this.messages.append(item);
    }
  }

  private renderQueue(): void {
    this.queueList.replaceChildren();
    const thread = this.thread;
    const entries = thread ? thread.queue : [];
    this.queueSection.hidden = entries.length === 0;
    for (const entry of entries) {
      const item = document.createElement('li');
      item.className = 'jp-BtwPanel-queueItem';
      item.dataset.requestId = entry.requestId;
      item.dataset.status = entry.status;
      const label = document.createElement('span');
      label.className = 'jp-BtwPanel-queueStatus';
      label.textContent = this.queueLabel(entry);
      item.append(label);
      if (entry.note) {
        const note = document.createElement('span');
        note.className = 'jp-BtwPanel-queueNote';
        note.textContent = entry.note;
        item.append(note);
      }
      if (entry.status === 'queued') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'jp-BtwPanel-button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', event => {
          event.preventDefault();
          void this.cancelQueued(entry);
        });
        item.append(cancel);
      }
      if (entry.status === 'unknown') {
        const resend = document.createElement('button');
        resend.type = 'button';
        resend.className = 'jp-BtwPanel-button';
        resend.textContent = 'Confirm and queue again';
        resend.addEventListener('click', event => {
          event.preventDefault();
          void this.resendUnknown(entry);
        });
        item.append(resend);
      }
      this.queueList.append(item);
    }
  }

  private queueLabel(entry: BtwQueueEntry): string {
    switch (entry.status) {
      case 'queued':
        return 'Queued for the main session.';
      case 'delivering':
        return 'Delivering into a new input cell…';
      case 'delivered':
        return 'Delivered into a new main input cell.';
      case 'cancelled':
        return 'Cancelled before delivery.';
      case 'failed':
        return 'Delivery failed; nothing was inserted.';
      case 'unknown':
        return 'Delivery could not be confirmed.';
      default:
        return entry.status;
    }
  }
}
