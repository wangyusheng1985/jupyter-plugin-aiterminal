"""The BTW snapshot is fixed, bounded, and excludes everything but Q/A text."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jupyter_aiterminal.btw_snapshot import (
    BtwSnapshotError,
    answer_cards,
    build_btw_snapshot,
)


def cell(cell_id, question, answer, *, kind='ai', status='done', reason='completed',
         tool_output='secret-tool-output', extra_blocks=()):
    blocks = [{'kind': 'text', 'id': f'text-{cell_id}', 'text': answer}]
    blocks.extend(
        {'kind': 'tool', 'id': f'tool-{cell_id}', 'name': 'bash',
         'input': {'command': 'cat ~/.aws/credentials'}, 'output': tool_output}
        for _ in range(2)
    )
    blocks.extend(extra_blocks)
    return {
        'id': cell_id,
        'kind': kind,
        'source': question,
        'output': '',
        'blocks': blocks,
        'turn': {
            'id': f'run-{cell_id}',
            'status': status,
            'resultText': '',
            'terminalReason': reason,
        },
        'status': status,
    }


def document(*cells):
    return {'version': 5, 'cells': list(cells)}


def test_answer_cards_number_finished_answers_in_document_order():
    doc = document(
        cell('c1', 'q1', 'a1'),
        cell('c2', 'q2', 'a2', kind='command'),
        cell('c3', 'q3', 'a3', status='running', reason=None),
        cell('c4', 'q4', 'a4'),
    )
    cards = answer_cards(doc)
    assert [(card['cellId'], card['answerNumber']) for card in cards] == [
        ('c1', 1),
        ('c4', 2),
    ]


def test_snapshot_excludes_tool_records_and_future_cells():
    doc = document(
        cell('c1', 'first question', 'first answer'),
        cell('c2', 'source question', 'source answer'),
        cell('c3', 'future question', 'future answer'),
    )
    snapshot = build_btw_snapshot(doc, cell_id='c2', captured_at='2026-01-01T00:00:00Z')
    text = snapshot['text']
    assert 'first question' in text and 'first answer' in text
    assert 'source question' in text and 'source answer' in text
    assert 'future question' not in text
    assert 'secret-tool-output' not in text
    assert '.aws' not in text
    assert snapshot['answerNumber'] == 2
    assert snapshot['capturedAt'] == '2026-01-01T00:00:00Z'
    assert snapshot['omittedPairs'] == 0
    assert snapshot['truncated'] is False


def test_snapshot_drops_oldest_pairs_with_a_visible_notice():
    doc = document(
        cell('c1', 'old question', 'x' * 400),
        cell('c2', 'newer question', 'y' * 400),
        cell('c3', 'source question', 'source answer'),
    )
    snapshot = build_btw_snapshot(
        doc, cell_id='c3', captured_at='2026-01-01T00:00:00Z', max_chars=1200
    )
    text = snapshot['text']
    assert 'source question' in text
    assert 'newer question' in text
    assert 'old question' not in text
    assert snapshot['omittedPairs'] == 1
    assert 'omitted' in text
    assert '2026-01-01T00:00:00Z' in text


def test_oversized_source_is_refused_instead_of_silently_cut():
    doc = document(cell('c1', 'q', 'x' * 5000))
    with pytest.raises(BtwSnapshotError, match='too large'):
        build_btw_snapshot(doc, cell_id='c1', max_source_chars=1000)


def test_oversized_source_answer_is_refused_not_cut():
    doc = document(cell('c1', 'q', 'line\n' * 400))
    with pytest.raises(BtwSnapshotError, match='too large'):
        build_btw_snapshot(doc, cell_id='c1', max_source_chars=500)



def test_unfinished_or_unknown_cell_is_refused():
    doc = document(cell('c1', 'q', 'a', status='running', reason=None))
    with pytest.raises(BtwSnapshotError):
        build_btw_snapshot(doc, cell_id='c1')
    with pytest.raises(BtwSnapshotError):
        build_btw_snapshot(doc, cell_id='missing')


def test_terminal_status_is_recorded_for_the_source_answer():
    doc = document(cell('c1', 'q', 'a', status='interrupted', reason='cancelled'))
    snapshot = build_btw_snapshot(doc, cell_id='c1', captured_at='2026-01-01T00:00:00Z')
    assert snapshot['terminalStatus'] == 'cancelled'
    assert 'cancelled' in snapshot['text']


def _fixture_document():
    path = (
        Path(__file__).resolve().parents[1]
        / 'protocol'
        / 'btw-answer-cards-fixture.json'
    )
    return json.loads(path.read_text(encoding='utf-8'))


def test_answer_cards_share_one_fixture_with_the_frontend():
    """The JS `isAnswerCard`/`answerNumberForCell` read this same fixture.

    The cells come from a real saved document, where the answer text lives in
    committed text blocks and `turn.resultText` is empty. That is exactly why
    the frontend must use the server's rule (resultText, else text blocks)
    instead of `turn.resultText` alone.
    """
    cards = answer_cards(_fixture_document())
    assert [(card['cellId'], card['answerNumber']) for card in cards] == [
        ('cell-5', 1),
        ('cell-6', 2),
        ('cell-7', 3),
        ('cell-8', 4),
        ('cell-9', 5),
    ]
    assert all(card['answer'] for card in cards)
    assert [card['status'] for card in cards] == [
        'completed',
        'completed',
        'completed',
        'interrupted',
        'completed',
    ]
