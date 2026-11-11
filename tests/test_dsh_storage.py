import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from jupyter_aiterminal.dsh_storage import runtime_storage_home
from jupyter_aiterminal.dsh_runtime_host import SharedDshRuntime


def log(home: Path, sid: str) -> Path:
    path = home / 'sessions' / '--workspace--' / sid / 'session.v4.jsonl.zstd'
    path.parent.mkdir(parents=True)
    path.write_bytes(b'preserved-history')
    return path


def test_new_sessions_use_stable_store(tmp_path):
    assert runtime_storage_home(tmp_path) == tmp_path / 'runtime' / 'dsh'


def test_legacy_cross_workspace_owner_is_found_without_moving_logs(tmp_path):
    owner = tmp_path / 'workspaces' / 'first' / 'sessions' / 'session-owner' / 'dsh'
    saved = log(owner, 'saved-id')
    wrong = tmp_path / 'workspaces' / 'second' / 'sessions' / 'wrong' / 'dsh'
    wrong.mkdir(parents=True)
    assert runtime_storage_home(tmp_path, 'saved-id') == owner
    assert saved.read_bytes() == b'preserved-history'


def test_new_store_survives_restart_discovery(tmp_path):
    home = runtime_storage_home(tmp_path)
    log(home, 'saved-id')
    assert runtime_storage_home(tmp_path, 'saved-id') == home


def test_duplicate_logs_are_not_silently_selected(tmp_path):
    log(tmp_path / 'runtime' / 'dsh', 'id')
    log(tmp_path / 'workspaces' / 'a' / 'sessions' / 'b' / 'dsh', 'id')
    with pytest.raises(RuntimeError, match='Multiple durable stores'):
        runtime_storage_home(tmp_path, 'id')


def test_symlink_store_outside_root_is_ignored(tmp_path):
    outside = tmp_path / 'outside'
    log(outside, 'id')
    root = tmp_path / 'root'
    alias = root / 'workspaces' / 'a' / 'sessions' / 'b' / 'dsh'
    alias.parent.mkdir(parents=True)
    alias.symlink_to(outside, target_is_directory=True)
    assert runtime_storage_home(root, 'id') == root / 'runtime' / 'dsh'


def test_opaque_id_is_not_interpreted_as_glob(tmp_path):
    log(tmp_path / 'runtime' / 'dsh', 'real')
    assert runtime_storage_home(tmp_path, '*') == tmp_path / 'runtime' / 'dsh'


def test_runtime_pool_shares_only_same_store():
    owner = SharedDshRuntime()
    first = owner.for_storage('a')
    assert owner.for_storage('a') is first
    assert first.for_storage('a') is first
    assert owner.for_storage('b') is not first
    asyncio.run(owner.close())  # unused transports are safe to close


def test_dead_transport_is_released_before_bootstrap():
    class Transport:
        _proc = SimpleNamespace(returncode=-9)
        closed = False

        async def close(self):
            self.closed = True

    transport = Transport()
    runtime = SharedDshRuntime(transport)

    async def scenario():
        async with runtime.transport_startup() as startup:
            assert startup.transport is None
            assert startup.owns_bootstrap
        assert transport.closed
    asyncio.run(scenario())
