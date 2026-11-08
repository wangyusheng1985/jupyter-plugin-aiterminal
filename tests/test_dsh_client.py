"""Tests for the async DSH client using an in-process fake SDK.

The published ``deepseek_harness`` package is never imported here: the tests
monkeypatch :func:`jupyter_aiterminal.dsh_client._import_sdk` with a fake that
mirrors the synchronous SDK surface (``start``, ``start_session``,
``resume_session``, ``close``, ``Session.run``). This keeps the module runnable
without a global SDK install and, importantly, lets the fake block and emit from
a real notification thread so the async wrapper's thread hand-off is exercised.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from jupyter_aiterminal import dsh_client
from jupyter_aiterminal.dsh_client import DshClient, DshClientError
from jupyter_aiterminal.dsh_config import (
    DSH_API_KEY_ENV,
    DSH_PROVIDER_ID,
    DSH_STATIC_PROFILE_PATH,
    parse_dsh_provider_config,
)

TOKEN = "dsh-client-unit-test-token-never-in-patch"

# Every lifecycle test is bounded from the outside, so a fake handler that is
# never released fails the test instead of hanging the whole file.
TEST_TIMEOUT_SECONDS = 10.0


async def _bounded(coro: Any) -> Any:
    return await asyncio.wait_for(coro, TEST_TIMEOUT_SECONDS)


def _provider_config() -> Any:
    return parse_dsh_provider_config(
        {
            "baseUrl": "https://api.example.test/v1",
            "model": "example-model",
            "token": TOKEN,
        }
    )


def _notification(
    session_id: str, event_type: str, data: dict[str, Any]
) -> dict[str, Any]:
    return {
        "method": "session.event",
        "payload": {
            "sessionId": session_id,
            "event": {"type": event_type, "data": data},
        },
    }


class FakeRunResult:
    def __init__(
        self,
        session_id: str,
        final_response: str,
        finish_reason: str | None,
        events: list[dict[str, Any]] | None = None,
    ) -> None:
        self.session_id = session_id
        self.final_response = final_response
        self.finish_reason = finish_reason
        self.events = events or []
        self.notifications: list[Any] = []


class FakeConfig:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        for key, value in kwargs.items():
            setattr(self, key, value)


class FakeSession:
    def __init__(self, harness: "FakeHarness", session_id: str) -> None:
        self.harness = harness
        self.id = session_id

    def run(
        self,
        content: str,
        *,
        on_notification: Callable[[Any], None] | None = None,
    ) -> FakeRunResult:
        return type(self.harness).run_handler(self, content, on_notification)


class FakeHarness:
    instances: list["FakeHarness"] = []
    start_delay = 0.0
    resume_error: BaseException | None = None
    run_handler: Callable[
        [FakeSession, str, Callable[[Any], None] | None], FakeRunResult
    ]

    def __init__(self, config: FakeConfig | None = None) -> None:
        self.config = config
        self.started = False
        self.closed = False
        # Mirrors the real SDK: closing the runtime unblocks in-flight runs.
        self.closed_event = threading.Event()
        self.resumed: list[str] = []
        self.sessions: list[FakeSession] = []
        FakeHarness.instances.append(self)

    def start(self) -> None:
        if FakeHarness.start_delay:
            time.sleep(FakeHarness.start_delay)
        self.started = True

    def start_session(self, session_id: str) -> FakeSession:
        session = FakeSession(self, session_id)
        self.sessions.append(session)
        return session

    def resume_session(self, session_id: str) -> FakeSession:
        if FakeHarness.resume_error is not None:
            raise FakeHarness.resume_error
        self.resumed.append(session_id)
        return self.start_session(session_id)

    def close(self) -> None:
        self.closed = True
        self.closed_event.set()


def _default_run(
    session: FakeSession,
    text: str,
    on_notification: Callable[[Any], None] | None,
) -> FakeRunResult:
    notifications = [
        _notification(session.id, "turn/start", {"turn": 1}),
        _notification(
            session.id,
            "assistant/message",
            {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "msg-1",
                    "content": [{"type": "text", "text": text}],
                },
            },
        ),
        _notification(session.id, "turn/end", {"reason": {"kind": "completed"}}),
    ]
    if on_notification is not None:
        for notification in notifications:
            on_notification(notification)
    return FakeRunResult(session.id, text, "completed")


@pytest.fixture(autouse=True)
def fake_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeHarness.instances.clear()
    FakeHarness.start_delay = 0.0
    FakeHarness.resume_error = None
    FakeHarness.run_handler = _default_run
    monkeypatch.setattr(dsh_client, "_import_sdk", lambda: (FakeConfig, FakeHarness))


def _new_client(
    tmp_path: Path, events: list[dict[str, Any]], **kwargs: Any
) -> DshClient:
    options: dict[str, Any] = {
        "config": _provider_config(),
        "cwd": tmp_path / "workspace",
        "home": tmp_path / "home",
        "emit": events.append,
    }
    options.update(kwargs)
    (tmp_path / "workspace").mkdir(exist_ok=True)
    return DshClient(**options)


def _legal_home(tmp_path: Path) -> Path:
    """A home pre-initialized through the production marker path.

    Fixtures that need an existing legal home (resume store, pre-seeded
    configuration) initialize it exactly as the client does instead of
    bypassing or relaxing the client's own home validation.
    """
    home = tmp_path / "home"
    dsh_client._prepare_home_dir(home)
    return home


def _merged_child_env(config: FakeConfig) -> dict[str, str]:
    """Mirror the real SDK: ``os.environ.copy()`` then ``.update(config.env)``."""
    merged = os.environ.copy()
    merged.update(config.env)
    return merged


def test_start_emits_product_events_and_runs_off_the_loop_thread(
    tmp_path: Path,
) -> None:
    FakeHarness.start_delay = 0.2
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    async def scenario() -> tuple[int, int]:
        ticks = 0
        started = asyncio.Event()

        async def ticker() -> None:
            nonlocal ticks
            while not started.is_set():
                ticks += 1
                await asyncio.sleep(0.01)

        ticker_task = asyncio.create_task(ticker())
        await client.start()
        started.set()
        await ticker_task
        await client.close()
        return ticks, threading.get_ident()

    ticks, loop_thread = asyncio.run(scenario())
    # The blocking SDK start ran in a worker thread: the loop kept ticking.
    assert ticks >= 5
    assert loop_thread == threading.get_ident()
    types = [event["type"] for event in events]
    assert types[:3] == [
        "dsh/v1/connection",
        "dsh/v1/session",
        "dsh/v1/capabilities",
    ]
    capabilities = events[2]["capabilities"]
    assert capabilities == {
        "text_stream": {"status": "available"},
        "session_resume": {"status": "available"},
        "tool_events": {
            "status": "unverified",
            "reason": "projector field contract not verified",
        },
        "artifacts": {
            "status": "unverified",
            "reason": "not exercised on the pinned runtime",
        },
        "questions": {
            "status": "unverified",
            "reason": "not exercised on the pinned runtime",
        },
        "jobs": {
            "status": "unverified",
            "reason": "not exercised on the pinned runtime",
        },
        "subagents": {
            "status": "unverified",
            "reason": "not exercised on the pinned runtime",
        },
        "approval": {
            "status": "unavailable",
            "reason": "pinned runtime has no approval channel",
        },
        "cancel": {
            "status": "unavailable",
            "reason": "pinned runtime has no cancel channel",
        },
    }
    assert set(capabilities) == {
        "text_stream",
        "session_resume",
        "tool_events",
        "artifacts",
        "questions",
        "jobs",
        "subagents",
        "approval",
        "cancel",
    }
    # Handshake events carry exactly the protocol.ts fields, nothing private.
    assert events[0] == {
        "type": "dsh/v1/connection",
        "runtimeId": client.runtime_id,
        "phase": "connected",
    }
    assert events[1] == {
        "type": "dsh/v1/session",
        "sessionId": client.session_id,
        "runtimeId": client.runtime_id,
        "phase": "attached",
    }
    assert events[2] == {
        "type": "dsh/v1/capabilities",
        "runtimeId": client.runtime_id,
        "capabilities": capabilities,
    }


def test_start_uses_pinned_profile_private_home_and_token_only_in_env(
    tmp_path: Path,
) -> None:
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    patch_checks: dict[str, Any] = {}

    async def scenario() -> None:
        await client.start()
        config = FakeHarness.instances[0].config
        assert config.patches[0] == str(DSH_STATIC_PROFILE_PATH.resolve())
        patch_path = Path(config.patches[1])
        patch_checks["text"] = patch_path.read_text(encoding="utf-8")
        patch_checks["file_mode"] = stat.S_IMODE(patch_path.stat().st_mode)
        patch_checks["dir_mode"] = stat.S_IMODE(patch_path.parent.stat().st_mode)
        patch_checks["dir_exists_after_close"] = False
        await client.close()
        patch_checks["dir_exists_after_close"] = patch_path.parent.exists()

    asyncio.run(scenario())
    harness = FakeHarness.instances[0]
    config = harness.config
    assert config.profile == "sdk-minimal"
    assert config.provider == DSH_PROVIDER_ID
    assert config.cwd == str((tmp_path / "workspace").resolve())
    assert config.runtime_cwd == config.cwd
    assert config.dsh_home == str((tmp_path / "home").resolve())
    assert config.env["HOME"] == str((tmp_path / "home").resolve())
    assert config.env[DSH_API_KEY_ENV] == TOKEN
    assert config.env["DEEPSEEK_API_KEY"] == ""
    for proxy in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        assert config.env[proxy] == ""

    assert len(config.patches) == 2
    patch_text = patch_checks["text"]
    assert TOKEN not in patch_text
    assert json.loads(patch_text)[0]["insert"][0]["id"] == "llm-pi-ai"
    assert patch_checks["file_mode"] == 0o600
    assert patch_checks["dir_mode"] == 0o700
    assert stat.S_IMODE((tmp_path / "home").stat().st_mode) == 0o700
    # The temporary patch directory is private configuration, not session data.
    assert patch_checks["dir_exists_after_close"] is False


def test_notifications_are_ordered_and_emitted_on_the_loop_thread(
    tmp_path: Path,
) -> None:
    events: list[dict[str, Any]] = []
    loop_thread = threading.get_ident()
    emit_thread_ids: list[int] = []
    notification_thread_ids: list[int] = []

    def handler(
        session: FakeSession,
        text: str,
        on_notification: Callable[[Any], None] | None,
    ) -> FakeRunResult:
        assert on_notification is not None

        def pump() -> None:
            notification_thread_ids.append(threading.get_ident())
            for index in range(20):
                on_notification(
                    _notification(
                        session.id,
                        "assistant/message",
                        {
                            "turn": 1,
                            "step": 1,
                            "message": {
                                "id": f"msg-{index}",
                                "content": [{"type": "text", "text": f"part-{index}"}],
                            },
                        },
                    )
                )

        thread = threading.Thread(target=pump)
        thread.start()
        thread.join()
        return FakeRunResult(session.id, "", "completed")

    FakeHarness.run_handler = handler
    client = _new_client(tmp_path, events)
    client._emit_callback = lambda event: (  # type: ignore[assignment]
        emit_thread_ids.append(threading.get_ident()),
        events.append(event),
    )

    async def scenario() -> Any:
        nonlocal loop_thread
        loop_thread = threading.get_ident()
        await client.start()
        result = await client.run("go")
        await client.close()
        return result

    result = asyncio.run(scenario())
    snapshots = [
        event["text"] for event in events if event["type"] == "dsh/v1/text.snapshot"
    ]
    assert snapshots == [f"part-{index}" for index in range(20)]
    assert set(emit_thread_ids) == {loop_thread}
    assert set(notification_thread_ids) != {loop_thread}
    assert result.session_id == client.session_id
    assert result.finish_reason == "completed"


def test_two_runs_have_distinct_run_ids_and_scoped_events(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    async def scenario() -> tuple[Any, Any]:
        await client.start()
        first = await client.run("one")
        second = await client.run("two")
        await client.close()
        return first, second

    first, second = asyncio.run(scenario())
    assert first.run_id != second.run_id
    assert first.session_id == second.session_id == client.session_id
    started = [event for event in events if event["type"] == "dsh/v1/run.started"]
    assert [event["runId"] for event in started] == [first.run_id, second.run_id]
    run_events = [event for event in events if "runId" in event]
    assert run_events
    for event in run_events:
        assert event["sessionId"] == client.session_id
        assert event["runId"] in {first.run_id, second.run_id}


def test_late_notifications_from_a_finished_run_never_leak_into_the_next_run(
    tmp_path: Path,
) -> None:
    events: list[dict[str, Any]] = []
    late_threads: list[threading.Thread] = []

    def handler(
        session: FakeSession,
        text: str,
        on_notification: Callable[[Any], None] | None,
    ) -> FakeRunResult:
        assert on_notification is not None
        if text == "first":

            def late() -> None:
                time.sleep(0.05)
                on_notification(_notification(session.id, "turn/start", {"turn": 9}))

            thread = threading.Thread(target=late, daemon=True)
            late_threads.append(thread)
            thread.start()
            return FakeRunResult(session.id, "first", "completed")
        time.sleep(0.15)
        return _default_run(session, text, on_notification)

    FakeHarness.run_handler = handler
    client = _new_client(tmp_path, events)

    async def scenario() -> Any:
        await client.start()
        first = await client.run("first")
        second = await client.run("second")
        await client.close()
        return first, second

    first, second = asyncio.run(scenario())
    for thread in late_threads:
        thread.join(timeout=1.0)
    run1_started = [
        event
        for event in events
        if event["type"] == "dsh/v1/run.started" and event["runId"] == first.run_id
    ]
    assert len(run1_started) == 0  # the late turn/start was dropped, not re-scoped
    assert any(event.get("runId") == second.run_id for event in events)


def test_resume_uses_the_explicit_id_and_missing_resume_fails_clearly(
    tmp_path: Path,
) -> None:
    events: list[dict[str, Any]] = []
    FakeHarness.resume_error = RuntimeError("session not found")
    client = _new_client(tmp_path, events, resume_session_id="session-durable")

    async def scenario() -> None:
        with pytest.raises(
            DshClientError, match="failed to resume DSH session 'session-durable'"
        ):
            await client.start()

    asyncio.run(scenario())
    harness = FakeHarness.instances[0]
    assert harness.resumed == []
    assert harness.closed is True
    assert client._patch_dir is None
    assert (tmp_path / "home").exists()


def test_resume_restores_without_creating_a_new_session(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events, resume_session_id="session-durable")

    async def scenario() -> None:
        await client.start()
        await client.close()

    asyncio.run(scenario())
    harness = FakeHarness.instances[0]
    assert harness.resumed == ["session-durable"]
    assert [session.id for session in harness.sessions] == ["session-durable"]
    assert client.session_id == "session-durable"
    session_event = next(event for event in events if event["type"] == "dsh/v1/session")
    assert session_event["phase"] == "resumed"
    assert "resumed" not in session_event
    assert "state" not in session_event


def test_concurrent_run_is_rejected(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    release = threading.Event()

    def handler(
        session: FakeSession,
        text: str,
        on_notification: Callable[[Any], None] | None,
    ) -> FakeRunResult:
        release.wait(timeout=5.0)
        return FakeRunResult(session.id, text, "completed")

    FakeHarness.run_handler = handler
    client = _new_client(tmp_path, events)

    async def scenario() -> None:
        await client.start()
        first = asyncio.create_task(client.run("first"))
        await asyncio.sleep(0.05)
        with pytest.raises(DshClientError, match="concurrent runs are rejected"):
            await client.run("second")
        release.set()
        await first
        await client.close()

    asyncio.run(scenario())


def test_force_close_releases_a_hanging_run_and_marks_the_harness_closed(
    tmp_path: Path,
) -> None:
    events: list[dict[str, Any]] = []

    def handler(
        session: FakeSession,
        text: str,
        on_notification: Callable[[Any], None] | None,
    ) -> FakeRunResult:
        # Blocks until the runtime is closed, like a real hanging turn.
        session.harness.closed_event.wait(timeout=5.0)
        return FakeRunResult(session.id, text, "completed")

    FakeHarness.run_handler = handler
    client = _new_client(tmp_path, events)

    async def scenario() -> None:
        await client.start()
        run_task = asyncio.create_task(client.run("hang"))
        await asyncio.sleep(0.05)
        assert client._run_worker is not None
        # close() is cleanup, not an interrupt: it must still release the
        # runtime even while the run is active (no cancel capability claimed).
        await client.close()
        assert FakeHarness.instances[0].closed is True
        assert client._run_worker is None  # bounded wait observed the worker end
        with pytest.raises(DshClientError):
            await run_task

    asyncio.run(_bounded(scenario()))


def test_cancelled_run_stays_busy_and_its_late_text_never_reaches_next_run(
    tmp_path: Path,
) -> None:
    events: list[dict[str, Any]] = []
    release_worker = threading.Event()
    release_second = threading.Event()
    release_late = threading.Event()
    late_sent = threading.Event()

    def handler(
        session: FakeSession,
        text: str,
        on_notification: Callable[[Any], None] | None,
    ) -> FakeRunResult:
        assert on_notification is not None
        if text == "first":

            def late() -> None:
                release_late.wait(timeout=5.0)
                on_notification(
                    _notification(
                        session.id,
                        "assistant/message",
                        {
                            "turn": 1,
                            "step": 1,
                            "message": {
                                "id": "msg-late",
                                "content": [
                                    {"type": "text", "text": "late-first-text"}
                                ],
                            },
                        },
                    )
                )
                late_sent.set()

            threading.Thread(target=late, daemon=True).start()
            release_worker.wait(timeout=5.0)
            raise RuntimeError("cancelled run")
        release_second.wait(timeout=5.0)
        return _default_run(session, text, on_notification)

    FakeHarness.run_handler = handler
    client = _new_client(tmp_path, events)

    async def scenario() -> Any:
        await client.start()
        first = asyncio.create_task(client.run("first"))
        await asyncio.sleep(0.05)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        # The worker thread is still blocked: the client must stay busy even
        # though the cancellation released the run lock.
        assert client._run_worker is not None
        with pytest.raises(DshClientError, match="concurrent runs are rejected"):
            await client.run("second")
        release_worker.set()
        deadline = time.monotonic() + 5.0
        while client._run_worker is not None and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert client._run_worker is None
        second_task = asyncio.create_task(client.run("second"))
        await asyncio.sleep(0.05)
        # Run 1's late text arrives while run 2 is the active run.
        release_late.set()
        deadline = time.monotonic() + 2.0
        while not late_sent.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        release_second.set()
        second = await second_task
        await client.close()
        return second

    second = asyncio.run(_bounded(scenario()))
    assert late_sent.is_set()
    assert [event for event in events if event.get("text") == "late-first-text"] == []
    assert any(
        event["type"] == "dsh/v1/text.snapshot" and event["runId"] == second.run_id
        for event in events
    )


def test_concurrent_start_is_rejected_without_leaking_a_runtime(
    tmp_path: Path,
) -> None:
    FakeHarness.start_delay = 0.2
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    async def scenario() -> list[Any]:
        results = await asyncio.gather(
            client.start(), client.start(), return_exceptions=True
        )
        await client.close()
        return list(results)

    results = asyncio.run(_bounded(scenario()))
    errors = [result for result in results if isinstance(result, DshClientError)]
    assert len(errors) == 1
    assert "concurrent starts are rejected" in str(errors[0])
    assert len(FakeHarness.instances) == 1
    assert FakeHarness.instances[0].closed is True


def test_cancelled_start_reclaims_the_late_harness(tmp_path: Path) -> None:
    FakeHarness.start_delay = 0.2
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    async def scenario() -> None:
        task = asyncio.create_task(client.start())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            harness = FakeHarness.instances[0] if FakeHarness.instances else None
            if harness is not None and harness.closed and client._patch_dir is None:
                break
            await asyncio.sleep(0.02)
        assert client._started is False

    asyncio.run(_bounded(scenario()))
    assert len(FakeHarness.instances) == 1
    harness = FakeHarness.instances[0]
    assert harness.started is True  # the thread did create a runtime
    assert harness.closed is True  # ...which was then reclaimed, not leaked
    assert client._harness is None
    assert client._patch_dir is None


def test_patch_write_failure_leaves_no_temporary_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)
    created: list[Path] = []
    real_mkdtemp = tempfile.mkdtemp

    def tracking_mkdtemp(*args: Any, **kwargs: Any) -> str:
        path = real_mkdtemp(*args, **kwargs)
        created.append(Path(path))
        return path

    def boom(self: Path, data: str, **kwargs: Any) -> int:
        raise OSError("disk full")

    monkeypatch.setattr(dsh_client.tempfile, "mkdtemp", tracking_mkdtemp)
    monkeypatch.setattr(Path, "write_text", boom)

    async def scenario() -> None:
        with pytest.raises(DshClientError, match="failed to start the DSH runtime"):
            await client.start()

    asyncio.run(_bounded(scenario()))
    assert client._patch_dir is None
    assert created
    assert not created[0].exists()


def test_failed_run_clears_active_state_and_allows_the_next_run(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    calls = {"count": 0}

    def handler(
        session: FakeSession,
        text: str,
        on_notification: Callable[[Any], None] | None,
    ) -> FakeRunResult:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("boom")
        return _default_run(session, text, on_notification)

    FakeHarness.run_handler = handler
    client = _new_client(tmp_path, events)

    async def scenario() -> None:
        await client.start()
        with pytest.raises(DshClientError, match="DSH run failed: boom"):
            await client.run("first")
        assert client._active_run_id is None
        result = await client.run("second")
        assert result.final_response == "second"
        await client.close()

    asyncio.run(scenario())


def test_close_keeps_session_files_and_is_idempotent(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    async def scenario() -> None:
        await client.start()
        await client.close()
        await client.close()

    asyncio.run(scenario())
    home = tmp_path / "home"
    assert home.is_dir()
    assert FakeHarness.instances[0].closed is True
    assert client._patch_dir is None


def test_run_before_start_and_after_close_fail_clearly(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    client = _new_client(tmp_path, events)

    async def scenario() -> None:
        with pytest.raises(DshClientError, match="not started"):
            await client.run("hello")
        await client.start()
        await client.close()
        with pytest.raises(DshClientError, match="closed DSH client"):
            await client.run("hello")

    asyncio.run(scenario())


def test_child_env_blanks_inherited_secrets_without_mutating_the_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secrets = {
        "OPENAI_API_KEY": "sk-openai-host",
        "ANTHROPIC_API_KEY": "sk-anthropic-host",
        "AWS_SECRET_ACCESS_KEY": "aws-host-secret",
        "JUPYTER_UNRELATED_CUSTOM_SECRET": "custom-host-secret",
    }
    for name, value in secrets.items():
        monkeypatch.setenv(name, value)
    client = _new_client(tmp_path, [])

    async def scenario() -> dict[str, str]:
        await client.start()
        overrides = dict(FakeHarness.instances[0].config.env)
        await client.close()
        return overrides

    overrides = asyncio.run(scenario())
    merged = os.environ.copy()
    merged.update(overrides)
    # The SDK merges config.env over its own os.environ copy: a blanked value is
    # an empty string, not an absent variable.
    for name in secrets:
        assert name in overrides
        assert overrides[name] == ""
        assert merged[name] == ""
    assert merged["PATH"] == os.environ["PATH"]
    assert merged["HOME"] == str((tmp_path / "home").resolve())
    assert merged["DSH_HOME"] == str((tmp_path / "home").resolve())
    assert merged[DSH_API_KEY_ENV] == TOKEN
    # The host mapping is never mutated, so concurrent clients cannot race.
    for name, value in secrets.items():
        assert os.environ[name] == value


def test_home_rejects_symlinked_components(tmp_path: Path) -> None:
    real = tmp_path / "real-home"
    real.mkdir()
    link = tmp_path / "home-link"
    link.symlink_to(real)
    with pytest.raises(DshClientError, match="symbolic link"):
        _new_client(tmp_path, [], home=link)


def test_home_rejects_a_relative_path(tmp_path: Path) -> None:
    with pytest.raises(DshClientError, match="absolute path"):
        _new_client(tmp_path, [], home="relative-home")


def test_home_rejects_a_directory_owned_by_another_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = _legal_home(tmp_path)
    real_geteuid = os.geteuid
    monkeypatch.setattr(dsh_client.os, "geteuid", lambda: real_geteuid() + 1)
    client = _new_client(tmp_path, [], home=home)

    async def scenario() -> None:
        with pytest.raises(DshClientError, match="not owned by the current user"):
            await client.start()

    asyncio.run(scenario())


def test_home_existing_non_empty_without_marker_is_rejected(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / "someone-elses.txt").write_text("keep me", encoding="utf-8")
    client = _new_client(tmp_path, [], home=home)

    async def scenario() -> None:
        with pytest.raises(DshClientError, match="not empty"):
            await client.start()

    asyncio.run(scenario())
    # The foreign file is neither deleted nor chmod-ed.
    assert (home / "someone-elses.txt").read_text(encoding="utf-8") == "keep me"


@pytest.mark.parametrize(
    "entry", ["cordis.patch.yml", "profiles", "extensions", "plugins"]
)
def test_home_rejects_preset_auto_loaded_configuration(
    tmp_path: Path, entry: str
) -> None:
    home = _legal_home(tmp_path)
    target = home / entry
    if entry == "cordis.patch.yml":
        target.write_text("- id: injected\n", encoding="utf-8")
    else:
        target.mkdir()
        (target / "custom.txt").write_text("injected", encoding="utf-8")
    client = _new_client(tmp_path, [], home=home)

    async def scenario() -> None:
        with pytest.raises(DshClientError, match="auto-loaded"):
            await client.start()

    asyncio.run(scenario())


def test_home_marker_is_private_and_existing_mode_is_left_alone(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    os.chmod(home, 0o755)
    client = _new_client(tmp_path, [], home=home)

    async def scenario() -> None:
        await client.start()
        await client.close()

    asyncio.run(scenario())
    marker = home / dsh_client._HOME_MARKER_NAME
    assert marker.is_file()
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600
    payload = json.loads(marker.read_text(encoding="utf-8"))
    assert payload["schema"] == dsh_client._HOME_MARKER_SCHEMA
    assert payload["version"] == dsh_client._HOME_MARKER_VERSION
    assert payload["ownerId"]
    # A pre-existing directory is adopted, never chmod-ed.
    assert stat.S_IMODE(home.stat().st_mode) == 0o755


def test_resume_accepts_and_preserves_a_legal_session_store(tmp_path: Path) -> None:
    home = _legal_home(tmp_path)
    sessions = home / "sessions"
    sessions.mkdir()
    stored = sessions / "session-durable.json"
    stored.write_text("{}", encoding="utf-8")
    client = _new_client(
        tmp_path, [], home=home, resume_session_id="session-durable"
    )

    async def scenario() -> None:
        await client.start()
        await client.close()

    asyncio.run(scenario())
    assert FakeHarness.instances[0].resumed == ["session-durable"]
    assert stored.read_text(encoding="utf-8") == "{}"


def test_two_clients_initialize_one_home_without_a_marker_race(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    first = _new_client(tmp_path, [], home=home)
    second = _new_client(tmp_path, [], home=home)

    async def scenario() -> None:
        await asyncio.gather(_bounded(first.start()), _bounded(second.start()))
        await first.close()
        await second.close()

    asyncio.run(_bounded(scenario()))
    assert len(FakeHarness.instances) == 2
    marker = home / dsh_client._HOME_MARKER_NAME
    payload = json.loads(marker.read_text(encoding="utf-8"))
    assert payload["schema"] == dsh_client._HOME_MARKER_SCHEMA
    assert payload["ownerId"]
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600
    # Only the marker remains; the temp file used to publish it is gone.
    assert sorted(os.listdir(home)) == [dsh_client._HOME_MARKER_NAME]


def test_marker_creation_is_race_free_under_a_thread_barrier(
    tmp_path: Path,
) -> None:
    """Many threads adopt the same fresh home with no partial-marker or
    empty-listdir TOCTOU window leaking through."""
    thread_count = 4
    for iteration in range(100):
        home = tmp_path / f"home-{iteration}"
        barrier = threading.Barrier(thread_count, timeout=5)
        errors: list[BaseException] = []

        def adopt() -> None:
            barrier.wait()
            try:
                dsh_client._prepare_home_dir(home)
            except BaseException as exc:  # noqa: BLE001 - collected and asserted
                errors.append(exc)

        threads = [
            threading.Thread(target=adopt, name=f"adopt-{i}")
            for i in range(thread_count)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        assert all(not thread.is_alive() for thread in threads)
        assert errors == []
        marker = home / dsh_client._HOME_MARKER_NAME
        payload = json.loads(marker.read_text(encoding="utf-8"))
        assert payload["schema"] == dsh_client._HOME_MARKER_SCHEMA
        assert payload["ownerId"]
        assert stat.S_IMODE(marker.stat().st_mode) == 0o600
        # No temp file and no duplicate marker survived the race.
        assert sorted(os.listdir(home)) == [dsh_client._HOME_MARKER_NAME]


def test_home_rejects_a_partially_written_marker(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    marker = home / dsh_client._HOME_MARKER_NAME
    marker.write_text(
        '{"schema": "jupyter-aiterminal-dsh-home", "version": 1,',
        encoding="utf-8",
    )
    with pytest.raises(DshClientError, match="unreadable"):
        dsh_client._prepare_home_dir(home)
    # Corrupt foreign data is never rewritten or deleted.
    assert marker.read_text(encoding="utf-8").startswith("{\"schema\"")


def test_home_rejects_a_marker_with_an_invalid_schema(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    marker = home / dsh_client._HOME_MARKER_NAME
    marker.write_text(json.dumps({"schema": "not-ours"}), encoding="utf-8")
    with pytest.raises(DshClientError, match="invalid schema"):
        dsh_client._prepare_home_dir(home)
