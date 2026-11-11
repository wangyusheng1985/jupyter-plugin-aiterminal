"""BTW service: lazy sessions, fixed snapshot, restore, cancel, queue."""

from __future__ import annotations

import asyncio
import json

import pytest

from jupyter_aiterminal.btw_service import BtwService, BtwServiceError
from jupyter_aiterminal.btw_store import BtwStore
from jupyter_aiterminal.dsh_btw import BtwRuntimeError
from jupyter_aiterminal.dsh_config import DshProviderConfig, derive_dsh_budget


def config():
    budget = derive_dsh_budget({}, context_window=1000000, max_output_tokens=384000)
    return DshProviderConfig(
        api_protocol='openai-completions',
        base_url='http://127.0.0.1:9/v1',
        model='probe-model',
        context_window=budget.context_window,
        max_output_tokens=budget.max_output_tokens,
        token='secret-token-value',
        budget=budget,
    )


def cell(cell_id, question, answer):
    return {
        'id': cell_id,
        'kind': 'ai',
        'source': question,
        'output': '',
        'blocks': [
            {'kind': 'text', 'id': f'text-{cell_id}', 'text': answer},
            {'kind': 'tool', 'id': f'tool-{cell_id}', 'name': 'bash',
             'input': {}, 'output': 'tool-record'},
        ],
        'turn': {'id': f'run-{cell_id}', 'status': 'done', 'resultText': '',
                 'terminalReason': 'completed'},
        'status': 'done',
    }


def write_notebook(root, name='note.agentnb', cells=None):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {
        'version': 5,
        'cells': cells
        if cells is not None
        else [cell('cell-1', 'first q', 'first a'), cell('cell-2', 'source q', 'source a')],
    }
    path.write_text(json.dumps(document), encoding='utf-8')
    return name


class FakeRuntime:
    instances: list['FakeRuntime'] = []
    fail_prompt_next = False

    def __init__(self, *, config, workspace_root, storage_root):
        self.config = config
        self.workspace_root = workspace_root
        self.storage_root = storage_root
        self.opened: list[str] = []
        self.resumed: list[str] = []
        self.cancelled: list[str] = []
        self.prompts: list[tuple[str, str]] = []
        self.fail_resume = False
        self.fail_prompt = False
        self.answer = 'btw answer'
        self.running = True
        self._counter = 0
        FakeRuntime.instances.append(self)

    async def open_session(self, cwd=None):
        self._counter += 1
        session_id = f'session-{self._counter}'
        self.opened.append(session_id)
        return session_id

    async def resume_session(self, session_id, cwd=None):
        if self.fail_resume:
            raise BtwRuntimeError('saved BTW session could not be resumed')
        self.resumed.append(session_id)

    async def prompt(self, session_id, text):
        # Yield once so a concurrent send can observe the busy flag.
        await asyncio.sleep(0)
        if self.fail_prompt or FakeRuntime.fail_prompt_next:
            raise BtwRuntimeError('BTW prompt failed')
        self.prompts.append((session_id, text))
        return {'status': 'completed', 'reason': 'completed', 'text': self.answer}

    async def cancel(self, session_id):
        self.cancelled.append(session_id)
        return True

    async def close(self):
        self.running = False

    def status(self):
        return {'running': self.running, 'tools': 'disabled'}


def service(tmp_path):
    root = tmp_path / 'ws'
    root.mkdir(exist_ok=True)
    store = BtwStore(tmp_path / 'storage')
    service = BtwService(
        root=root,
        store=store,
        settings_loader=config,
        runtime_factory=FakeRuntime,
    )
    return service, root, store


def run(coro):
    return asyncio.run(coro)


def test_open_creates_one_thread_without_starting_a_runtime(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    FakeRuntime.instances.clear()
    first = run(subject.open_thread('alice', notebook, 'cell-2'))
    second = run(subject.open_thread('alice', notebook, 'cell-2'))
    assert first['threadId'] == second['threadId']
    assert first['answerNumber'] == 2
    assert first['snapshot']['capturedAt']
    assert first['messages'] == []
    assert FakeRuntime.instances == []
    assert subject.status()['running'] is False


def test_first_send_creates_the_session_and_embeds_the_snapshot(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    view = run(subject.send('alice', notebook, thread['threadId'], 'what now?'))
    runtime = FakeRuntime.instances[-1]
    assert runtime.opened == ['session-1']
    session_id, wire = runtime.prompts[0]
    assert session_id == 'session-1'
    assert 'source q' in wire and 'source a' in wire
    assert 'first q' in wire and 'first a' in wire
    assert 'tool-record' not in wire
    assert wire.rstrip().endswith('what now?')
    assert [message['role'] for message in view['messages']] == ['user', 'assistant']
    assert view['messages'][1]['text'] == 'btw answer'

    run(subject.send('alice', notebook, thread['threadId'], 'follow up'))
    assert runtime.opened == ['session-1']
    assert runtime.resumed == ['session-1']
    assert runtime.prompts[1] == ('session-1', 'follow up')


def test_thread_restores_after_a_server_restart(tmp_path):
    subject, root, store = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    run(subject.send('alice', notebook, thread['threadId'], 'hello'))

    restarted = BtwService(
        root=root,
        store=BtwStore(store.root),
        settings_loader=config,
        runtime_factory=FakeRuntime,
    )
    restored = run(restarted.restore_thread('alice', notebook, 'cell-2'))
    assert restored['threadId'] == thread['threadId']
    assert restored['messages'][0]['text'] == 'hello'
    assert restored['snapshot']['answerNumber'] == 2
    assert restored['snapshot']['capturedAt'] == thread['snapshot']['capturedAt']


def test_restore_never_creates_a_thread(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    assert run(subject.restore_thread('alice', notebook, 'cell-2')) is None


def test_resume_failure_is_explicit_and_keeps_the_session_id(tmp_path):
    subject, root, store = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    run(subject.send('alice', notebook, thread['threadId'], 'hello'))
    runtime = FakeRuntime.instances[-1]
    runtime.fail_resume = True
    with pytest.raises(BtwServiceError, match='could not be resumed'):
        run(subject.send('alice', notebook, thread['threadId'], 'again'))
    state = store.load('alice', notebook)
    assert state['threads'][thread['threadId']]['sessionId'] == 'session-1'


def test_cancel_only_targets_the_requested_thread(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(
        root,
        cells=[
            cell('cell-1', 'q1', 'a1'),
            cell('cell-2', 'q2', 'a2'),
        ],
    )
    first = run(subject.open_thread('alice', notebook, 'cell-1'))
    second = run(subject.open_thread('alice', notebook, 'cell-2'))
    run(subject.send('alice', notebook, first['threadId'], 'hello'))
    run(subject.send('alice', notebook, second['threadId'], 'hello'))
    runtime = FakeRuntime.instances[-1]
    view = run(subject.cancel('alice', notebook, first['threadId']))
    assert view['cancelled'] is True
    assert runtime.cancelled == ['session-1']


def test_budget_failure_creates_nothing(tmp_path):
    subject, root, store = service(tmp_path)
    huge = 'x' * 60_000
    notebook = write_notebook(
        root, cells=[cell('cell-1', 'source q', huge)]
    )
    FakeRuntime.instances.clear()
    with pytest.raises(BtwServiceError, match='too large'):
        run(subject.open_thread('alice', notebook, 'cell-1'))
    assert FakeRuntime.instances == []
    assert store.load('alice', notebook)['threads'] == {}


def test_missing_notebook_is_explicit_and_creates_nothing(tmp_path):
    subject, root, store = service(tmp_path)
    with pytest.raises(BtwServiceError, match='missing'):
        run(subject.open_thread('alice', 'note.agentnb', 'cell-1'))
    assert store.load('alice', 'note.agentnb')['threads'] == {}


def test_prompt_failure_is_recorded_without_losing_the_thread(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    FakeRuntime.fail_prompt_next = True
    try:
        view = run(subject.send('alice', notebook, thread['threadId'], 'hello'))
    finally:
        FakeRuntime.fail_prompt_next = False
    assert view['error']
    assert view['messages'][-1]['status'] == 'failed'
    restored = run(subject.restore_thread('alice', notebook, 'cell-2'))
    assert restored['threadId'] == thread['threadId']


def test_send_back_queue_is_idempotent_and_acknowledged(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    first = run(subject.enqueue('alice', notebook, thread['threadId'], 'req-1', 'copy'))
    second = run(subject.enqueue('alice', notebook, thread['threadId'], 'req-1', 'copy'))
    assert first['created'] is True
    assert second['created'] is False
    assert len(run(subject.list_queue('alice', notebook))['entries']) == 1
    claimed = run(subject.claim('alice', notebook))['entry']
    assert claimed['requestId'] == 'req-1'
    assert claimed['claimId']
    acked = run(
        subject.ack(
            'alice', notebook, 'req-1', claimed['claimId'], 'delivered'
        )
    )
    assert acked['status'] == 'delivered'
    assert run(subject.claim('alice', notebook))['entry'] is None


def test_queue_cancel_and_unknown_after_restart(tmp_path):
    subject, root, store = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    run(subject.enqueue('alice', notebook, thread['threadId'], 'req-1', 'one'))
    run(subject.enqueue('alice', notebook, thread['threadId'], 'req-2', 'two'))
    run(subject.cancel_queued('alice', notebook, 'req-2'))
    run(subject.claim('alice', notebook))

    restarted = BtwService(
        root=root,
        store=BtwStore(store.root),
        settings_loader=config,
        runtime_factory=FakeRuntime,
    )
    entries = run(restarted.list_queue('alice', notebook))['entries']
    statuses = {entry['requestId']: entry['status'] for entry in entries}
    assert statuses == {'req-1': 'unknown', 'req-2': 'cancelled'}


def test_concurrent_sends_on_one_thread_are_rejected(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))

    async def main():
        first = asyncio.create_task(
            subject.send('alice', notebook, thread['threadId'], 'one')
        )
        second = asyncio.create_task(
            subject.send('alice', notebook, thread['threadId'], 'two')
        )
        results = await asyncio.gather(first, second, return_exceptions=True)
        return results

    results = run(main())
    errors = [item for item in results if isinstance(item, BtwServiceError)]
    assert errors and 'already answering' in str(errors[0])


def test_second_claim_is_refused_while_a_delivery_is_in_flight(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    run(subject.enqueue('alice', notebook, thread['threadId'], 'req-1', 'one'))
    run(subject.enqueue('alice', notebook, thread['threadId'], 'req-2', 'two'))
    first = run(subject.claim('alice', notebook))
    assert first['entry']['requestId'] == 'req-1'
    second = run(subject.claim('alice', notebook))
    assert second['entry'] is None
    assert second['inFlight'] is True
    # The other entry is still queued, not silently claimed or delivered.
    entries = run(subject.list_queue('alice', notebook))['entries']
    statuses = {entry['requestId']: entry['status'] for entry in entries}
    assert statuses == {'req-1': 'delivering', 'req-2': 'queued'}


def test_ack_requires_the_claim_id(tmp_path):
    subject, root, _ = service(tmp_path)
    notebook = write_notebook(root)
    thread = run(subject.open_thread('alice', notebook, 'cell-2'))
    run(subject.enqueue('alice', notebook, thread['threadId'], 'req-1', 'one'))
    claimed = run(subject.claim('alice', notebook))['entry']
    with pytest.raises(BtwServiceError, match='claim does not match'):
        run(subject.ack('alice', notebook, 'req-1', '', 'delivered'))
    with pytest.raises(BtwServiceError, match='claim does not match'):
        run(subject.ack('alice', notebook, 'req-1', 'claim-other', 'delivered'))
    acked = run(
        subject.ack(
            'alice', notebook, 'req-1', claimed['claimId'], 'delivered'
        )
    )
    assert acked['status'] == 'delivered'
