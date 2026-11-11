import {
  BTW_BASE_PATH,
  BTW_MESSAGE_ROLES,
  BTW_MESSAGE_STATUSES,
  BTW_QUEUE_STATUSES,
  BTW_ROUTES,
  BTW_SNAPSHOT_FIELDS,
  answerNumberForCell,
  answerTextOf,
  isAnswerCard
} from './btw-protocol';

interface ProtocolDocument {
  version: number;
  basePath: string;
  routes: Record<string, string>;
  messageRoles: string[];
  messageStatuses: string[];
  queueStatuses: string[];
  snapshotFields: string[];
}

function sharedDocument(): ProtocolDocument {
  // Jest loads JSON natively, so the test reads the same shared document the
  // Python suite reads without needing Node typings in this project.
  return jest.requireActual(
    '../../protocol/btw-protocol.json'
  ) as ProtocolDocument;
}

describe('BTW protocol contract', () => {
  it('matches the shared protocol document', () => {
    const document = sharedDocument();
    expect(document.version).toBe(1);
    expect(document.basePath).toBe(BTW_BASE_PATH);
    expect(document.routes).toEqual({ ...BTW_ROUTES });
    expect(document.messageRoles).toEqual([...BTW_MESSAGE_ROLES]);
    expect(document.messageStatuses).toEqual([...BTW_MESSAGE_STATUSES]);
    expect(document.queueStatuses).toEqual([...BTW_QUEUE_STATUSES]);
    expect(document.snapshotFields).toEqual([...BTW_SNAPSHOT_FIELDS]);
  });

  it('keeps every route relative and unique', () => {
    const routes = Object.values(BTW_ROUTES);
    expect(new Set(routes).size).toBe(routes.length);
    routes.forEach(route => {
      expect(route.startsWith('/')).toBe(false);
      expect(route).not.toContain('..');
    });
  });
});

function textBlock(text: string) {
  return { kind: 'text', id: `text-${text.length}`, text };
}

describe('answer cards (server parity)', () => {
  // Mirrors `btw_snapshot.answer_cards`: a persisted turn in a terminal state
  // with committed answer text (resultText, else committed text blocks).
  const cells = [
    {
      id: 'cell-1',
      kind: 'ai',
      turn: { status: 'done', resultText: 'answer one' },
      blocks: []
    },
    // Command cells are never answer cards.
    {
      id: 'cell-2',
      kind: 'command',
      turn: { status: 'done', resultText: 'x' }
    },
    // Running turns are not terminal yet.
    {
      id: 'cell-3',
      kind: 'ai',
      turn: { status: 'running', resultText: 'in flight' }
    },
    // A finished turn whose answer text only lives in blocks.
    {
      id: 'cell-4',
      kind: 'ai',
      turn: { status: 'done', resultText: '' },
      blocks: [textBlock('answer two')]
    },
    // Legacy cell: no persisted turn at all, only blocks.
    { id: 'cell-5', kind: 'ai', turn: null, blocks: [textBlock('legacy')] },
    // Finished turn without any committed text.
    {
      id: 'cell-6',
      kind: 'ai',
      turn: { status: 'interrupted', resultText: '' },
      blocks: []
    }
  ];

  it('counts exactly the server-eligible cards in document order', () => {
    expect(answerNumberForCell(cells, 'cell-1')).toBe(1);
    expect(answerNumberForCell(cells, 'cell-4')).toBe(2);
    expect(answerNumberForCell(cells, 'cell-2')).toBeNull();
  });

  it('excludes running, text-less, and legacy cells', () => {
    expect(answerNumberForCell(cells, 'cell-3')).toBeNull();
    expect(answerNumberForCell(cells, 'cell-5')).toBeNull();
    expect(answerNumberForCell(cells, 'cell-6')).toBeNull();
    expect(answerNumberForCell(cells, 'missing')).toBeNull();
  });

  it('never offers BTW for a cell without a persisted turn', () => {
    expect(isAnswerCard(cells[4])).toBe(false);
    expect(isAnswerCard(cells[0])).toBe(true);
    expect(isAnswerCard(cells[3])).toBe(true);
  });

  it('matches the server fixture from a real document', () => {
    // `tests/test_btw_snapshot.py` asserts the server's `answer_cards` on this
    // exact file, so both sides are pinned to one real shaped document.
    const fixture = jest.requireActual(
      '../../protocol/btw-answer-cards-fixture.json'
    ) as { cells: Array<Record<string, unknown>> };
    const numbers = fixture.cells.map(cell =>
      answerNumberForCell(fixture.cells as never, cell.id as string)
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    // Dropping the persisted turn (a legacy cell) removes the card entirely.
    const legacy = fixture.cells.map((cell, index) =>
      index === 0 ? { ...cell, turn: null } : cell
    );
    expect(answerNumberForCell(legacy as never, 'cell-5')).toBeNull();
    expect(answerNumberForCell(legacy as never, 'cell-6')).toBe(1);
  });

  it('prefers resultText and falls back to committed text blocks', () => {
    expect(answerTextOf(cells[0])).toBe('answer one');
    expect(answerTextOf(cells[3])).toBe('answer two');
    expect(answerTextOf(cells[4])).toBe('legacy');
    expect(answerTextOf(cells[5])).toBe('');
  });
});
