"""BTW storage: path confinement, atomic persistence, queue idempotency."""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from jupyter_aiterminal.btw_store import (
    BtwStorageError,
    BtwStore,
    ack_queue_entry,
    append_message,
    cancel_queue_entry,
    claim_next_entry,
    create_thread,
    empty_state,
    enqueue_send_back,
    find_thread_by_cell,
    normalize_notebook_path,
    recover_queue,
    resolve_notebook_file,
    validate_state,
)


def snapshot(text='snapshot body'):
    return {
        'text': text,
        'capturedAt': '2026-01-01T00:00:00Z',
        'answerNumber': 1,
        'omittedPairs': 0,
        'truncated': False,
        'sourceChars': len(text),
        'terminalStatus': 'completed',
    }


def store(tmp_path):
    root = tmp_path / 'storage'
    root.mkdir()
    return BtwStore(root)


def test_notebook_paths_must_stay_relative_and_clean():
    assert normalize_notebook_path('dir/note.agentnb') == 'dir/note.agentnb'
    for bad in (
        '',
        '/etc/passwd',
        '../note.agentnb',
        'a/../../note.agentnb',
        'a\\b.agentnb',
        'a//note.agentnb',
        './note.agentnb',
        'note.txt',
        'C:/note.agentnb',
    ):
        with pytest.raises(BtwStorageError):
            normalize_notebook_path(bad)


def test_symlinked_notebook_is_rejected(tmp_path):
    root = tmp_path / 'ws'
    root.mkdir()
    outside = tmp_path / 'outside.agentnb'
    outside.write_text('{}', encoding='utf-8')
    (root / 'link.agentnb').symlink_to(outside)
    with pytest.raises(BtwStorageError, match='symlink'):
        resolve_notebook_file(root, 'link.agentnb')


def test_symlinked_parent_directory_is_rejected(tmp_path):
    root = tmp_path / 'ws'
    root.mkdir()
    real = tmp_path / 'real'
    real.mkdir()
    (real / 'note.agentnb').write_text('{}', encoding='utf-8')
    (root / 'sub').symlink_to(real)
    with pytest.raises(BtwStorageError, match='symlink'):
        resolve_notebook_file(root, 'sub/note.agentnb')


def test_missing_notebook_never_creates_a_file(tmp_path):
    root = tmp_path / 'ws'
    root.mkdir()
    with pytest.raises(BtwStorageError, match='missing'):
        resolve_notebook_file(root, 'note.agentnb')
    assert list(root.iterdir()) == []


def test_thread_lookup_by_cell_is_stable(tmp_path):
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    assert find_thread_by_cell(state, 'cell-1') is thread
    assert find_thread_by_cell(state, 'cell-2') is None
    assert thread['queue'] == []
    assert thread['snapshot']['text'] == 'snapshot body'


def test_state_round_trip_survives_a_new_store_instance(tmp_path):
    first = store(tmp_path)
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    append_message(thread, role='user', text='hello', status='done')
    first.save('alice', 'note.agentnb', state)
    second = BtwStore(first.root)
    loaded = second.load('alice', 'note.agentnb')
    assert loaded['threads'][thread['threadId']]['messages'][0]['text'] == 'hello'
    assert loaded['notebook'] == 'note.agentnb'


def test_state_file_is_private(tmp_path):
    subject = store(tmp_path)
    subject.save('alice', 'note.agentnb', empty_state('note.agentnb'))
    path = subject.state_path('alice', 'note.agentnb')
    assert path.is_file()
    assert os.stat(path).st_mode & 0o077 == 0
    assert os.stat(path.parent).st_mode & 0o077 == 0


def test_corrupt_state_is_reported_instead_of_replaced(tmp_path):
    subject = store(tmp_path)
    path = subject.state_path('alice', 'note.agentnb')
    path.write_text('{not json', encoding='utf-8')
    with pytest.raises(BtwStorageError, match='not readable'):
        subject.load('alice', 'note.agentnb')
    assert path.read_text(encoding='utf-8') == '{not json'


def test_state_for_another_notebook_is_rejected(tmp_path):
    subject = store(tmp_path)
    subject.save('alice', 'note.agentnb', empty_state('note.agentnb'))
    path = subject.state_path('alice', 'note.agentnb')
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload['notebook'] = 'other.agentnb'
    path.write_text(json.dumps(payload), encoding='utf-8')
    with pytest.raises(BtwStorageError, match='does not belong'):
        subject.load('alice', 'note.agentnb')


def test_unknown_state_version_is_rejected():
    state = empty_state('note.agentnb')
    state['version'] = 99
    with pytest.raises(BtwStorageError, match='unsupported version'):
        validate_state(state, 'note.agentnb')


def test_different_users_get_different_files(tmp_path):
    subject = store(tmp_path)
    subject.save('alice', 'note.agentnb', empty_state('note.agentnb'))
    subject.save('bob', 'note.agentnb', empty_state('note.agentnb'))
    assert subject.state_path('alice', 'note.agentnb') != subject.state_path(
        'bob', 'note.agentnb'
    )


def test_concurrent_updates_do_not_lose_writes(tmp_path):
    subject = store(tmp_path)
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    subject.save('alice', 'note.agentnb', state)

    async def append(index):
        def mutate(current):
            target = current['threads'][thread['threadId']]
            append_message(target, role='user', text=f'm{index}', status='done')

        await subject.update('alice', 'note.agentnb', mutate)

    async def main():
        await asyncio.gather(*(append(index) for index in range(10)))

    asyncio.run(main())
    loaded = subject.load('alice', 'note.agentnb')
    texts = [message['text'] for message in loaded['threads'][thread['threadId']]['messages']]
    assert sorted(texts) == sorted(f'm{index}' for index in range(10))


def test_message_trimming_is_bounded_and_counted():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    for index in range(210):
        append_message(thread, role='user', text=f'm{index}', status='done')
    assert len(thread['messages']) == 200
    assert thread['messagesOmitted'] == 10


def test_oversized_user_message_is_refused():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    with pytest.raises(BtwStorageError, match='too long'):
        append_message(thread, role='user', text='x' * 100_001, status='done')


def test_enqueue_is_idempotent_per_request_id():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    first, created = enqueue_send_back(thread, request_id='req-1', text='hello')
    second, created_again = enqueue_send_back(thread, request_id='req-1', text='hello')
    assert created is True
    assert created_again is False
    assert first is second
    assert len(thread['queue']) == 1


def test_queue_requires_claim_before_ack():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    enqueue_send_back(thread, request_id='req-1', text='hello')
    with pytest.raises(BtwStorageError, match='not claimed'):
        ack_queue_entry(
            thread, request_id='req-1', claim_id='claim-1', outcome='delivered'
        )
    entry = claim_next_entry(thread)
    assert entry['status'] == 'delivering'
    claim_id = entry['claimId']
    assert isinstance(claim_id, str) and claim_id
    assert claim_next_entry(thread) is None
    acked = ack_queue_entry(
        thread, request_id='req-1', claim_id=claim_id, outcome='delivered'
    )
    assert acked['status'] == 'delivered'
    assert 'claimId' not in acked
    # Repeating the same outcome is idempotent and cannot duplicate anything.
    again = ack_queue_entry(
        thread, request_id='req-1', claim_id=claim_id, outcome='delivered'
    )
    assert again['status'] == 'delivered'


def test_ack_requires_the_matching_claim_id():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    enqueue_send_back(thread, request_id='req-1', text='hello')
    entry = claim_next_entry(thread)
    for claim_id in (None, '', 'claim-other'):
        with pytest.raises(BtwStorageError, match='claim does not match'):
            ack_queue_entry(
                thread,
                request_id='req-1',
                claim_id=claim_id,
                outcome='delivered',
            )
    assert entry['status'] == 'delivering'


def test_only_queued_entries_can_be_cancelled():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    enqueue_send_back(thread, request_id='req-1', text='hello')
    entry = claim_next_entry(thread)
    with pytest.raises(BtwStorageError, match='claim does not match'):
        cancel_queue_entry(thread, request_id='req-1')
    with pytest.raises(BtwStorageError, match='claim does not match'):
        cancel_queue_entry(thread, request_id='req-1', claim_id='claim-other')
    cancelled = cancel_queue_entry(
        thread, request_id='req-1', claim_id=entry['claimId']
    )
    assert cancelled['status'] == 'cancelled'
    # A queued entry needs no claim token.
    enqueue_send_back(thread, request_id='req-2', text='hello')
    assert (
        cancel_queue_entry(thread, request_id='req-2')['status'] == 'cancelled'
    )


def test_unproven_delivery_becomes_unknown_and_is_never_replayed(tmp_path):
    subject = store(tmp_path)
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    enqueue_send_back(thread, request_id='req-1', text='hello')
    claim_next_entry(thread)
    subject.save('alice', 'note.agentnb', state)

    restarted = BtwStore(subject.root)
    loaded = restarted.load('alice', 'note.agentnb')
    entry = loaded['threads'][thread['threadId']]['queue'][0]
    assert entry['status'] == 'unknown'
    assert 'Confirm' in entry['note']
    # A later load does not claim it again.
    assert claim_next_entry(loaded['threads'][thread['threadId']]) is None


def test_stale_delivery_is_downgraded():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    enqueue_send_back(thread, request_id='req-1', text='hello')
    claim_next_entry(thread)
    thread['queue'][0]['updatedAt'] = '2000-01-01T00:00:00Z'
    assert recover_queue(thread, stale_seconds=10) == 1
    assert thread['queue'][0]['status'] == 'unknown'


def test_queue_terminal_entries_are_pruned_at_the_bound():
    state = empty_state('note.agentnb')
    thread = create_thread(state, cell_id='cell-1', snapshot=snapshot())
    for index in range(60):
        enqueue_send_back(thread, request_id=f'req-{index}', text='hello')
        entry = claim_next_entry(thread)
        ack_queue_entry(
            thread,
            request_id=f'req-{index}',
            claim_id=entry['claimId'],
            outcome='delivered',
        )
    assert len(thread['queue']) <= 50


def test_state_size_cap_is_enforced(tmp_path):
    subject = BtwStore(store(tmp_path).root, max_state_bytes=600)
    state = empty_state('note.agentnb')
    create_thread(state, cell_id='cell-1', snapshot=snapshot('x' * 2000))
    with pytest.raises(BtwStorageError, match='too large'):
        subject.save('alice', 'note.agentnb', state)
