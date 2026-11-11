import { BtwPanel, type BtwPanelOptions } from './btw';
import type { BtwQueueEntry, BtwThread } from './btw-protocol';

jest.mock('./selectioncopy', () => ({
  writeClipboardText: jest.fn().mockResolvedValue(true)
}));

jest.mock('./btw-protocol', () => {
  const actual = jest.requireActual('./btw-protocol');
  return {
    ...actual,
    btwRestoreThread: jest.fn(),
    btwOpenThread: jest.fn(),
    btwSend: jest.fn(),
    btwCancel: jest.fn(),
    btwEnqueue: jest.fn(),
    btwListQueue: jest.fn(),
    btwClaim: jest.fn(),
    btwAck: jest.fn(),
    btwCancelQueued: jest.fn()
  };
});

import {
  btwAck,
  btwCancel,
  btwCancelQueued,
  btwClaim,
  btwEnqueue,
  btwOpenThread,
  btwRestoreThread,
  btwSend
} from './btw-protocol';

const restore = btwRestoreThread as jest.Mock;
const open = btwOpenThread as jest.Mock;
const send = btwSend as jest.Mock;
const cancel = btwCancel as jest.Mock;
const enqueue = btwEnqueue as jest.Mock;
const claim = btwClaim as jest.Mock;
const ack = btwAck as jest.Mock;
const cancelQueued = btwCancelQueued as jest.Mock;

function thread(overrides: Partial<BtwThread> = {}): BtwThread {
  return {
    threadId: 'thread-1',
    cellId: 'cell-2',
    answerNumber: 2,
    notebook: 'note.agentnb',
    snapshot: {
      capturedAt: '2026-01-01T00:00:00Z',
      answerNumber: 2,
      omittedPairs: 1,
      truncated: false,
      sourceChars: 120,
      terminalStatus: 'completed'
    },
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        text: 'why?',
        status: 'done',
        at: '2026-01-01T00:00:00Z'
      },
      {
        id: 'msg-2',
        role: 'assistant',
        text: 'because',
        status: 'done',
        at: '2026-01-01T00:00:01Z'
      }
    ],
    messagesOmitted: 0,
    queue: [],
    busy: false,
    ...overrides
  };
}

function queueEntry(overrides: Partial<BtwQueueEntry> = {}): BtwQueueEntry {
  return {
    requestId: 'req-1',
    text: 'send me back',
    status: 'queued',
    ...overrides
  };
}

function claimedEntry(
  overrides: Partial<BtwQueueEntry> = {}
): BtwQueueEntry & { threadId: string } {
  return {
    ...queueEntry({ status: 'delivering', claimId: 'claim-1', ...overrides }),
    threadId: 'thread-1'
  };
}

function createPanel(overrides: Partial<BtwPanelOptions> = {}) {
  const options: BtwPanelOptions = {
    notebook: () => 'note.agentnb',
    isMainBusy: () => false,
    canSend: () => true,
    sendBack: jest.fn().mockReturnValue({ status: 'sent', runId: 'run-1' }),
    awaitAccepted: jest.fn().mockResolvedValue(true),
    flush: jest.fn().mockResolvedValue(undefined),
    answerNumber: () => 2,
    requestId: () => 'req-generated',
    ...overrides
  };
  const panel = new BtwPanel(options);
  return { panel, options };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  restore.mockResolvedValue({ thread: null });
  open.mockResolvedValue({ thread: thread() });
  send.mockResolvedValue({ thread: thread() });
  cancel.mockResolvedValue({ thread: thread() });
  enqueue.mockResolvedValue({ entry: { ...queueEntry(), created: true } });
  claim.mockResolvedValue({ entry: null, inFlight: false });
  ack.mockResolvedValue({ entry: queueEntry() });
  cancelQueued.mockResolvedValue({
    entry: queueEntry({ status: 'cancelled' })
  });
});

describe('BtwPanel', () => {
  it('opens without starting a model call and labels the source answer', async () => {
    const { panel } = createPanel();
    expect(panel.visible).toBe(false);
    await panel.open('cell-2');
    expect(panel.visible).toBe(true);
    expect(panel.node.textContent).toContain('source answer #2');
    expect(open).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('restores an existing thread when the same card is opened again', async () => {
    restore.mockResolvedValue({ thread: thread() });
    const { panel } = createPanel();
    await panel.open('cell-2');
    expect(open).not.toHaveBeenCalled();
    expect(panel.node.textContent).toContain('why?');
    expect(panel.node.textContent).toContain('because');
    expect(panel.node.textContent).toContain('1 earlier question/answer pair');
  });

  it('creates the thread and sends only after the user submits a message', async () => {
    const { panel } = createPanel();
    await panel.open('cell-2');
    const input = panel.node.querySelector(
      '.jp-BtwPanel-input'
    ) as HTMLTextAreaElement;
    input.value = 'what about this?';
    const form = panel.node.querySelector(
      '.jp-BtwPanel-composer'
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(open).toHaveBeenCalledWith('note.agentnb', 'cell-2');
    expect(send).toHaveBeenCalledWith(
      'note.agentnb',
      'thread-1',
      'what about this?'
    );
    expect(panel.node.textContent).toContain('because');
  });

  it('keeps important errors visible', async () => {
    send.mockRejectedValue(new Error('BTW is not available on this server.'));
    const { panel } = createPanel();
    await panel.open('cell-2');
    const input = panel.node.querySelector(
      '.jp-BtwPanel-input'
    ) as HTMLTextAreaElement;
    input.value = 'hello';
    (
      panel.node.querySelector('.jp-BtwPanel-composer') as HTMLFormElement
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const errorBox = panel.node.querySelector(
      '.jp-BtwPanel-error'
    ) as HTMLElement;
    expect(errorBox.hidden).toBe(false);
    expect(errorBox.textContent).toContain('BTW is not available');
  });

  it('stops only the BTW thread and hides without cancelling on close', async () => {
    restore.mockResolvedValue({ thread: thread({ busy: true }) });
    const { panel } = createPanel();
    await panel.open('cell-2');
    const stop = Array.from(
      panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
    ).find(button => button.textContent === 'Stop');
    expect(stop).toBeDefined();
    stop?.click();
    await flush();
    expect(cancel).toHaveBeenCalledWith('note.agentnb', 'thread-1');

    cancel.mockClear();
    panel.hidePanel();
    expect(panel.visible).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('previews send-back text before queueing it', async () => {
    restore.mockResolvedValue({ thread: thread() });
    const { panel } = createPanel();
    await panel.open('cell-2');
    const sendBack = Array.from(
      panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
    ).find(button => button.textContent === 'Send to main session');
    sendBack?.click();
    const preview = panel.node.querySelector(
      '.jp-BtwPanel-preview'
    ) as HTMLElement;
    expect(preview.hidden).toBe(false);
    const previewInput = panel.node.querySelector(
      '.jp-BtwPanel-previewInput'
    ) as HTMLTextAreaElement;
    expect(previewInput.value).toBe('because');
    expect(enqueue).not.toHaveBeenCalled();

    previewInput.value = 'edited before sending';
    const confirm = Array.from(
      panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
    ).find(button => button.textContent === 'Queue for main session');
    confirm?.click();
    await flush();
    expect(enqueue).toHaveBeenCalledWith(
      'note.agentnb',
      'thread-1',
      'req-generated',
      'edited before sending'
    );
  });

  it('waits while the main session is busy and never claims or acknowledges', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    const { panel, options } = createPanel({
      isMainBusy: () => true,
      canSend: () => false
    });
    await panel.open('cell-2');
    await flush();
    expect(claim).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(panel.node.textContent).toContain('main session is busy');
    expect(options.sendBack).not.toHaveBeenCalled();
  });

  it('acknowledges delivered only after acceptance and a successful flush', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    claim.mockResolvedValue({ entry: claimedEntry() });
    const { panel, options } = createPanel();
    await panel.open('cell-2');
    await flush();
    expect(claim).toHaveBeenCalledWith('note.agentnb');
    expect(options.sendBack).toHaveBeenCalledWith('send me back');
    expect(options.awaitAccepted).toHaveBeenCalledWith('run-1');
    expect(options.flush).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(
      'note.agentnb',
      'req-1',
      'claim-1',
      'delivered'
    );
    // The flush must happen before the delivered acknowledgement.
    const flushOrder = (options.flush as jest.Mock).mock.invocationCallOrder[0];
    const ackOrder = (ack as jest.Mock).mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(ackOrder);
  });

  it('reports unknown when the run is never accepted', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    claim.mockResolvedValue({ entry: claimedEntry() });
    const { panel } = createPanel({
      awaitAccepted: jest.fn().mockResolvedValue(false)
    });
    await panel.open('cell-2');
    await flush();
    expect(ack).toHaveBeenCalledWith(
      'note.agentnb',
      'req-1',
      'claim-1',
      'unknown'
    );
  });

  it('reports unknown when the document flush fails after acceptance', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    claim.mockResolvedValue({ entry: claimedEntry() });
    const { panel } = createPanel({
      flush: jest.fn().mockRejectedValue(new Error('save failed'))
    });
    await panel.open('cell-2');
    await flush();
    expect(ack).toHaveBeenCalledWith(
      'note.agentnb',
      'req-1',
      'claim-1',
      'unknown'
    );
  });

  it('shows the specific reason when delivery is blocked', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    claim.mockResolvedValue({ entry: claimedEntry() });
    const { panel } = createPanel({
      sendBack: jest.fn().mockReturnValue({
        status: 'blocked',
        message:
          'This answer starts with "!", which the notebook would run as a shell command.'
      })
    });
    await panel.open('cell-2');
    await flush();
    const errorBox = panel.node.querySelector(
      '.jp-BtwPanel-error'
    ) as HTMLElement;
    expect(errorBox.hidden).toBe(false);
    expect(errorBox.textContent).toContain('shell command');
    expect(ack).toHaveBeenCalledWith(
      'note.agentnb',
      'req-1',
      'claim-1',
      'failed'
    );
  });

  it('claims at most once for repeated deliverPending calls', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    const gate: { release?: () => void } = {};
    claim.mockImplementation(
      () =>
        new Promise(resolve => {
          gate.release = () =>
            resolve({ entry: claimedEntry(), inFlight: false });
        })
    );
    const { panel } = createPanel();
    await panel.open('cell-2');
    await Promise.resolve();
    void panel.deliverPending();
    void panel.deliverPending();
    await Promise.resolve();
    expect(claim).toHaveBeenCalledTimes(1);
    gate.release?.();
    await flush();
  });

  it('requires confirmation before resending an unknown delivery', async () => {
    restore.mockResolvedValue({
      thread: thread({
        queue: [
          queueEntry({
            status: 'unknown',
            note: 'Delivery could not be confirmed.'
          })
        ]
      })
    });
    const { panel } = createPanel();
    await panel.open('cell-2');
    expect(panel.node.textContent).toContain('could not be confirmed');
    const resend = Array.from(
      panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
    ).find(button => button.textContent === 'Confirm and queue again');
    resend?.click();
    await flush();
    // A new request id is a new user confirmation, never a replay.
    expect(enqueue).toHaveBeenCalledWith(
      'note.agentnb',
      'thread-1',
      'req-generated',
      'send me back'
    );
  });

  it('retries a failed confirmation with the same request id', async () => {
    restore.mockResolvedValue({ thread: thread() });
    const { panel } = createPanel();
    await panel.open('cell-2');
    const sendBack = Array.from(
      panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
    ).find(button => button.textContent === 'Send to main session');
    sendBack?.click();
    enqueue.mockRejectedValueOnce(new Error('network down'));
    const confirm = () =>
      Array.from(
        panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
      )
        .find(button => button.textContent === 'Queue for main session')
        ?.click();
    confirm();
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    confirm();
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][2]).toBe(enqueue.mock.calls[1][2]);
    expect(enqueue.mock.calls[1][2]).toBe('req-generated');
  });

  it('cancels a still-queued send-back', async () => {
    restore.mockResolvedValue({
      thread: thread({ queue: [queueEntry()] })
    });
    const { panel } = createPanel({ isMainBusy: () => true });
    await panel.open('cell-2');
    const cancelButton = Array.from(
      panel.node.querySelectorAll<HTMLButtonElement>('.jp-BtwPanel-button')
    ).find(button => button.textContent === 'Cancel');
    cancelButton?.click();
    await flush();
    expect(cancelQueued).toHaveBeenCalledWith(
      'note.agentnb',
      'req-1',
      undefined
    );
  });

  it('exposes accessible roles and closes on Escape', async () => {
    const { panel } = createPanel();
    await panel.open('cell-2');
    expect(panel.node.getAttribute('role')).toBe('complementary');
    expect(panel.node.getAttribute('aria-label')).toBe('BTW side chat');
    expect(
      panel.node.querySelector('.jp-BtwPanel-messages')?.getAttribute('role')
    ).toBe('log');
    panel.node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(panel.visible).toBe(false);
  });

  it('drops an in-flight restore when the panel switched cards', async () => {
    const pending: { resolve?: (value: unknown) => void } = {};
    restore.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          pending.resolve = resolve;
        })
    );
    const second = thread({
      threadId: 'thread-b',
      cellId: 'cell-9',
      messages: [
        {
          id: 'msg-b',
          role: 'assistant',
          text: 'thread B answer',
          status: 'done',
          at: '2026-01-01T00:00:02Z'
        }
      ],
      queue: []
    });
    restore.mockResolvedValueOnce({ thread: second });
    const { panel, options } = createPanel();
    const firstOpen = panel.open('cell-1');
    await Promise.resolve();
    await panel.open('cell-9');
    expect(panel.activeCellId).toBe('cell-9');
    expect(panel.node.textContent).toContain('thread B answer');

    // The late response for card 1 must not repaint the panel or be reused.
    pending.resolve?.({
      thread: thread({
        threadId: 'thread-a',
        cellId: 'cell-1',
        messages: [
          {
            id: 'msg-a',
            role: 'assistant',
            text: 'thread A answer',
            status: 'done',
            at: '2026-01-01T00:00:03Z'
          }
        ]
      })
    });
    await firstOpen;
    expect(panel.activeCellId).toBe('cell-9');
    expect(panel.node.textContent).not.toContain('thread A answer');
    expect(panel.node.textContent).toContain('thread B answer');

    const input = panel.node.querySelector(
      '.jp-BtwPanel-input'
    ) as HTMLTextAreaElement;
    input.value = 'follow up';
    (
      panel.node.querySelector('.jp-BtwPanel-composer') as HTMLFormElement
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // The message goes to card 9's thread, never to the stale thread A.
    expect(send).toHaveBeenCalledWith('note.agentnb', 'thread-b', 'follow up');
    expect(options.answerNumber).toBeDefined();
  });

  it('reports a failed restore without pretending the thread is new', async () => {
    restore.mockRejectedValue(
      new Error('The saved BTW thread could not be restored.')
    );
    const { panel } = createPanel();
    await panel.open('cell-2');
    expect(panel.node.textContent).toContain('could not be restored');
    expect(open).not.toHaveBeenCalled();
  });
});
