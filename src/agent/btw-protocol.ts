import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * The BTW wire contract. These values mirror `protocol/btw-protocol.json`, the
 * Python `btw_protocol` module, and are asserted against that JSON by
 * `btw-protocol.spec.ts`.
 */
export const BTW_BASE_PATH = 'aiterminal/btw';

export const BTW_ROUTES = {
  thread: 'thread',
  message: 'message',
  cancel: 'cancel',
  queue: 'queue',
  queueClaim: 'queue/claim',
  queueAck: 'queue/ack',
  queueCancel: 'queue/cancel'
} as const;

export const BTW_MESSAGE_ROLES = ['user', 'assistant'] as const;
export const BTW_MESSAGE_STATUSES = ['done', 'cancelled', 'failed'] as const;
export const BTW_QUEUE_STATUSES = [
  'queued',
  'delivering',
  'delivered',
  'cancelled',
  'failed',
  'unknown'
] as const;
export const BTW_SNAPSHOT_FIELDS = [
  'capturedAt',
  'answerNumber',
  'omittedPairs',
  'truncated',
  'sourceChars'
] as const;

export type BtwQueueStatus = (typeof BTW_QUEUE_STATUSES)[number];
export type BtwMessageStatus = (typeof BTW_MESSAGE_STATUSES)[number];

export interface BtwSnapshotInfo {
  capturedAt: string;
  answerNumber: number;
  omittedPairs: number;
  truncated: boolean;
  sourceChars: number;
  terminalStatus: string;
}

export interface BtwMessage {
  id: string;
  role: (typeof BTW_MESSAGE_ROLES)[number];
  text: string;
  status: BtwMessageStatus;
  at: string;
}

export interface BtwQueueEntry {
  requestId: string;
  text: string;
  status: BtwQueueStatus;
  /** Present only while this delivery is claimed; required to acknowledge. */
  claimId?: string;
  updatedAt?: string;
  note?: string;
}

export interface BtwThread {
  threadId: string;
  cellId: string;
  answerNumber: number;
  notebook: string;
  snapshot: BtwSnapshotInfo;
  messages: BtwMessage[];
  messagesOmitted: number;
  queue: BtwQueueEntry[];
  busy: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface BtwStatus {
  running: boolean;
  tools: string;
  threadsBusy: number;
}

export class BtwRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'BtwRequestError';
  }
}

function endpoint(route: string, settings: ServerConnection.ISettings): string {
  return URLExt.join(settings.baseUrl, BTW_BASE_PATH, route);
}

async function toError(response: Response): Promise<BtwRequestError> {
  let message = 'BTW request failed.';
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === 'string' && payload.message) {
      message = payload.message;
    }
  } catch {
    // A non-JSON error body keeps the fixed fallback message.
  }
  return new BtwRequestError(message, response.status);
}

async function requestJson<T>(
  route: string,
  init: RequestInit,
  settings: ServerConnection.ISettings
): Promise<T> {
  const response = await ServerConnection.makeRequest(
    endpoint(route, settings),
    init,
    settings
  );
  if (!response.ok) {
    throw await toError(response);
  }
  return (await response.json()) as T;
}

function post<T>(
  route: string,
  body: Record<string, unknown>,
  settings: ServerConnection.ISettings
): Promise<T> {
  return requestJson<T>(
    route,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    },
    settings
  );
}

export function btwRestoreThread(
  notebook: string,
  cellId: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ thread: BtwThread | null }> {
  const query = URLExt.objectToQueryString({ notebook, cellId });
  return requestJson<{ thread: BtwThread | null }>(
    `${BTW_ROUTES.thread}?${query}`,
    { method: 'GET' },
    settings
  );
}

export function btwOpenThread(
  notebook: string,
  cellId: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ thread: BtwThread }> {
  return post<{ thread: BtwThread }>(
    BTW_ROUTES.thread,
    { notebook, cellId },
    settings
  );
}

export function btwSend(
  notebook: string,
  threadId: string,
  text: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ thread: BtwThread }> {
  return post<{ thread: BtwThread }>(
    BTW_ROUTES.message,
    { notebook, threadId, text },
    settings
  );
}

export function btwCancel(
  notebook: string,
  threadId: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ thread: BtwThread }> {
  return post<{ thread: BtwThread }>(
    BTW_ROUTES.cancel,
    { notebook, threadId },
    settings
  );
}

export function btwEnqueue(
  notebook: string,
  threadId: string,
  requestId: string,
  text: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ entry: BtwQueueEntry & { created?: boolean } }> {
  return post<{ entry: BtwQueueEntry & { created?: boolean } }>(
    BTW_ROUTES.queue,
    { notebook, threadId, requestId, text },
    settings
  );
}

export function btwListQueue(
  notebook: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ entries: Array<BtwQueueEntry & { threadId: string }> }> {
  const query = URLExt.objectToQueryString({ notebook });
  return requestJson<{ entries: Array<BtwQueueEntry & { threadId: string }> }>(
    `${BTW_ROUTES.queue}?${query}`,
    { method: 'GET' },
    settings
  );
}

export function btwClaim(
  notebook: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{
  entry: (BtwQueueEntry & { threadId: string }) | null;
  inFlight?: boolean;
}> {
  return post<{
    entry: (BtwQueueEntry & { threadId: string }) | null;
    inFlight?: boolean;
  }>(BTW_ROUTES.queueClaim, { notebook }, settings);
}

export function btwAck(
  notebook: string,
  requestId: string,
  claimId: string,
  outcome: 'delivered' | 'failed' | 'unknown',
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ entry: BtwQueueEntry }> {
  return post<{ entry: BtwQueueEntry }>(
    BTW_ROUTES.queueAck,
    { notebook, requestId, claimId, outcome },
    settings
  );
}

export function btwCancelQueued(
  notebook: string,
  requestId: string,
  claimId?: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<{ entry: BtwQueueEntry }> {
  const body: Record<string, unknown> = { notebook, requestId };
  if (claimId) body.claimId = claimId;
  return post<{ entry: BtwQueueEntry }>(BTW_ROUTES.queueCancel, body, settings);
}

/** One cell as the answer-card rules need to see it. */
export interface AnswerCellLike {
  id: string;
  kind: string;
  turn: { status?: string; resultText?: string } | null;
  blocks?: ReadonlyArray<{ kind?: string; text?: string }>;
}

const TERMINAL_TURN_STATUSES = ['done', 'interrupted', 'error'];

/**
 * The committed answer text of a cell, mirroring the server's
 * `btw_snapshot._answer_text`: the persisted turn's `resultText` when it has
 * one, otherwise the concatenated committed text blocks.
 */
export function answerTextOf(cell: AnswerCellLike): string {
  const result = (cell.turn?.resultText ?? '').trim();
  if (result) return result;
  return (cell.blocks ?? [])
    .filter(block => block.kind === 'text')
    .map(block => (block.text ?? '').trim())
    .filter(text => text.length > 0)
    .join('\n\n');
}

/**
 * Whether a cell is a BTW answer card.
 *
 * This mirrors the server's `btw_snapshot.answer_cards` exactly: an ``ai`` cell
 * with a persisted turn in a terminal state and committed answer text. Cells
 * without a persisted turn (legacy cells whose text only lives in blocks) are
 * not answer cards, so they never show a BTW button the server would refuse.
 */
export function isAnswerCard(cell: AnswerCellLike): boolean {
  if (cell.kind !== 'ai') return false;
  const turn = cell.turn;
  if (!turn) return false;
  if (!TERMINAL_TURN_STATUSES.includes(turn.status ?? '')) return false;
  return answerTextOf(cell) !== '';
}

/** The 1-based answer-card number of a cell, or null when it is not a card. */
export function answerNumberForCell(
  cells: ReadonlyArray<AnswerCellLike>,
  cellId: string
): number | null {
  let count = 0;
  for (const cell of cells) {
    if (!isAnswerCard(cell)) continue;
    count += 1;
    if (cell.id === cellId) return count;
  }
  return null;
}
