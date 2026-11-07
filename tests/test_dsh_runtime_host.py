"""Shared runtime ownership: one initialize, one session/new per workspace."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from jupyter_aiterminal.dsh_acp_session import DshAcpSessionError
from jupyter_aiterminal.dsh_config import derive_dsh_budget
from jupyter_aiterminal.dsh_runtime_host import SharedDshRuntime


class FakeTransport:
    def __init__(self) -> None:
        self.started = 0
        self.closed = False
        self.requests: list[tuple[str, Any]] = []
        self._next = 0
        self._proc = type("Proc", (), {"pid": 4242})()

    async def start(self) -> None:
        self.started += 1

    async def request(self, method: str, params: Any = None, timeout: float | None = None) -> Any:
        self.requests.append((method, params))
        if method == "initialize":
            return {"protocolVersion": 1}
        if method == "session/new":
            self._next += 1
            return {"sessionId": f"session-{self._next}"}
        if method == "session/prompt":
            session_id = params["sessionId"]
            await asyncio.sleep(0.01)
            return {"stopReason": "end_turn", "sessionId": session_id}
        return {}

    async def notify(self, method: str, params: Any = None) -> None:
        self.requests.append((method, params))

    async def close(self) -> None:
        self.closed = True
        self._proc = None


def test_three_workspaces_share_one_runtime_and_interrupt_one(tmp_path: Path) -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)
    directories = []
    for name in ("one", "two", "three"):
        path = tmp_path / name
        path.mkdir()
        directories.append(path)

    async def scenario() -> list[str]:
        session_ids = [await runtime.open_session(path) for path in directories]
        tasks = [
            runtime.start_prompt(session_id, f"run {session_id}")
            for session_id in session_ids
        ]
        await asyncio.sleep(0)
        runtime.detach(session_ids[0])
        await runtime.cancel_session(session_ids[1])
        snapshot = runtime.reattach(
            session_ids[0], lambda _event: None
        )
        await asyncio.gather(*tasks)
        assert snapshot["sessionId"] == session_ids[0]
        return session_ids

    session_ids = asyncio.run(scenario())

    assert len(set(session_ids)) == 3
    assert transport.started == 1
    assert runtime.process_id == 4242
    assert ("session/cancel", {"sessionId": session_ids[1]}) in transport.requests
    assert ("session/close", {"sessionId": session_ids[0]}) not in transport.requests


def test_one_failed_resume_does_not_replace_successful_sessions(tmp_path: Path) -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    async def scenario() -> dict[str, str]:
        first = await runtime.open_session(alpha)
        second = await runtime.open_session(beta)
        assert first != second
        return await runtime.recover(resume_failures={second})

    results = asyncio.run(scenario())

    assert list(results.values()).count("resumed") == 1
    assert list(results.values()).count("resume-unavailable") == 1
    assert transport.started == 2
    assert runtime.session_resume_count == 1


def test_prompts_run_across_sessions_but_not_twice_on_one() -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)

    async def scenario() -> tuple[Any, Any]:
        await runtime.start()
        first = asyncio.create_task(runtime.prompt("alpha", "one"))
        await asyncio.sleep(0)
        with pytest.raises(DshAcpSessionError, match="already active"):
            await runtime.prompt("alpha", "again")
        second = asyncio.create_task(runtime.prompt("beta", "two"))
        return await first, await second

    alpha, beta = asyncio.run(scenario())

    assert alpha["sessionId"] == "alpha"
    assert beta["sessionId"] == "beta"
    prompts = [
        params["sessionId"]
        for method, params in transport.requests
        if method == "session/prompt"
    ]
    assert prompts == ["alpha", "beta"]


def test_detach_leaves_the_prompt_running() -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)

    async def scenario() -> bool:
        await runtime.start()
        task = runtime.start_prompt("alpha", "keep going")
        await asyncio.sleep(0)
        runtime.detach("alpha")
        assert runtime.prompt_running("alpha") is True
        assert ("session/cancel", {"sessionId": "alpha"}) not in transport.requests
        assert ("session/close", {"sessionId": "alpha"}) not in transport.requests
        await task
        return runtime.prompt_running("alpha")

    assert asyncio.run(scenario()) is False


def test_reattach_returns_saved_progress_for_the_same_session() -> None:
    runtime = SharedDshRuntime(FakeTransport())
    runtime.remember_snapshot(
        "alpha",
        {"status": "running", "text": "progress while detached"},
    )

    received: list[dict[str, Any]] = []
    snapshot = runtime.reattach("alpha", received.append)

    assert snapshot == {
        "status": "running",
        "text": "progress while detached",
        "sessionId": "alpha",
    }
    assert runtime.attached("alpha") is True


def test_explicit_shutdown_differs_from_detach() -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)

    async def scenario() -> None:
        await runtime.start()
        task = runtime.start_prompt("alpha", "stop this")
        await asyncio.sleep(0)
        runtime.detach("beta")
        await runtime.shutdown_workspace("alpha")
        await task

    asyncio.run(scenario())

    assert ("session/cancel", {"sessionId": "alpha"}) in transport.requests
    assert ("session/close", {"sessionId": "alpha"}) in transport.requests
    assert all(
        params != {"sessionId": "beta"}
        for method, params in transport.requests
        if method in {"session/cancel", "session/close"}
    )


def test_second_attachment_is_rejected() -> None:
    runtime = SharedDshRuntime(FakeTransport())
    runtime.attach("alpha", lambda _event: None)
    with pytest.raises(DshAcpSessionError, match="already attached"):
        runtime.attach("alpha", lambda _event: None)
    runtime.detach("alpha")
    runtime.attach("alpha", lambda _event: None)


def test_cancel_and_close_do_not_stop_the_shared_process() -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)
    runtime.subscribe("alpha", lambda _message: None)
    runtime.subscribe("beta", lambda _message: None)

    async def scenario() -> None:
        await runtime.start()
        await runtime.cancel_session("alpha")
        await runtime.close_session("alpha")

    asyncio.run(scenario())

    assert ("session/cancel", {"sessionId": "alpha"}) in transport.requests
    assert ("session/close", {"sessionId": "alpha"}) in transport.requests
    assert transport.closed is False
    assert runtime.process_id == 4242
    assert "alpha" not in runtime._subscribers
    assert "beta" in runtime._subscribers


def test_notifications_reach_only_the_matching_session() -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)
    alpha: list[dict[str, Any]] = []
    beta: list[dict[str, Any]] = []

    async def collect(target: list[dict[str, Any]], message: dict[str, Any]) -> None:
        target.append(message)

    runtime.subscribe("alpha", lambda message: collect(alpha, message))
    runtime.subscribe("beta", lambda message: collect(beta, message))

    async def deliver() -> None:
        await runtime._route_notification(
            {"method": "session/update", "params": {"sessionId": "alpha"}}
        )
        await runtime._route_notification(
            {"method": "session/update", "params": {"sessionId": "beta"}}
        )
        await runtime._route_notification(
            {"method": "session/update", "params": {"sessionId": "other"}}
        )

    asyncio.run(deliver())

    assert alpha == [
        {"method": "session/update", "params": {"sessionId": "alpha"}}
    ]
    assert beta == [
        {"method": "session/update", "params": {"sessionId": "beta"}}
    ]


def test_initialize_once_and_session_new_per_workspace(tmp_path: Path) -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    async def open_both() -> tuple[str, str]:
        first, second = await asyncio.gather(
            runtime.open_session(alpha),
            runtime.open_session(beta),
        )
        return first, second

    first, second = asyncio.run(open_both())

    assert first != second
    assert transport.started == 1
    assert runtime.process_id == 4242
    methods = [method for method, _params in transport.requests]
    assert methods.count("initialize") == 1
    assert methods.count("session/new") == 2
    assert runtime.initialize_count == 1
    assert runtime.session_new_count == 2


class BadProtocolTransport(FakeTransport):
    async def request(self, method: str, params: Any = None, timeout: float | None = None) -> Any:
        if method == "initialize":
            self.requests.append((method, params))
            return {"protocolVersion": 2}
        return await super().request(method, params, timeout=timeout)


def _active_snapshot() -> dict[str, Any]:
    return derive_dsh_budget({}).safe_report()


def _desired_snapshot() -> dict[str, Any]:
    return derive_dsh_budget(
        {"contextWindow": 16384, "maxOutputTokens": 8192}
    ).safe_report()


def test_first_transport_snapshot_is_authoritative_at_start() -> None:
    runtime = SharedDshRuntime()
    first = FakeTransport()
    second = FakeTransport()
    active = _active_snapshot()
    pending = _desired_snapshot()

    runtime.bind_transport(first, snapshot=active, preflight_proven=True)
    runtime.bind_transport(second, snapshot=pending, preflight_proven=False)

    before = runtime.configuration_report()
    assert before["state"] == "not-started"
    assert before["generation"] == 0
    assert before["active"] is None
    assert before["preflightApplied"] is False

    asyncio.run(runtime.start())
    report = runtime.configuration_report()

    assert report["active"] == active
    assert report["generation"] == 1
    assert report["state"] == "active"
    assert report["preflightApplied"] is True
    assert first.started == 1
    assert second.started == 0
    assert runtime.process_id == 4242

    # A later bind must not replace the first transport's snapshot.
    third = FakeTransport()
    runtime.bind_transport(third, snapshot=pending, preflight_proven=False)
    assert runtime.configuration_report()["active"] == active
    assert runtime.configuration_report()["generation"] == 1

    # The report is a deep copy, not a handle into the active snapshot.
    report["active"]["contextWindow"] = 1
    assert runtime.configuration_report()["active"] == active


def test_desired_snapshot_does_not_change_active_or_generation() -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=_active_snapshot(), preflight_proven=True
    )
    asyncio.run(runtime.start())
    active = _active_snapshot()
    desired = _desired_snapshot()

    report = runtime.configuration_report(desired=desired)

    assert report["state"] == "pending-next-runtime"
    assert report["active"] == active
    assert report["desired"] == desired
    assert report["generation"] == 1
    assert report["differences"]

    again = runtime.configuration_report(desired=desired)
    assert again["active"] == active
    assert again["generation"] == 1

    same = runtime.configuration_report(desired=_active_snapshot())
    assert same["state"] == "active"
    assert same["differences"] == {}


def test_new_session_and_reconnect_use_the_active_snapshot(
    tmp_path: Path,
) -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=_active_snapshot(), preflight_proven=True
    )
    asyncio.run(runtime.start())
    desired = _desired_snapshot()

    async def scenario() -> None:
        await runtime.open_session(tmp_path)
        await runtime.open_session(tmp_path)

    asyncio.run(scenario())

    report = runtime.configuration_report(desired=desired)
    assert report["active"] == _active_snapshot()
    assert report["generation"] == 1
    assert report["state"] == "pending-next-runtime"


def test_report_projects_unknown_and_credential_values_out() -> None:
    snapshot = _active_snapshot()
    snapshot["note"] = "sk-live-note-secret"
    snapshot["baseUrl"] = "https://user:pass@host"
    snapshot["auth"] = "Bearer sk-live-auth-value"
    snapshot["token"] = "leaked-token-value"
    snapshot["apiKey"] = "leaked-api-key-value"
    snapshot["nested"] = {
        "accessToken": "leaked-access-token-value",
        "keep": "visible-but-unknown",
    }
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=snapshot, preflight_proven=True
    )
    asyncio.run(runtime.start())

    report = runtime.configuration_report(
        desired={**snapshot, "authorization": "leaked-authorization-value"}
    )
    serialized = json.dumps(report, sort_keys=True)

    for secret in (
        "sk-live-note-secret",
        "user:pass",
        "sk-live-auth-value",
        "leaked-token-value",
        "leaked-api-key-value",
        "leaked-access-token-value",
        "leaked-authorization-value",
        "visible-but-unknown",
    ):
        assert secret not in serialized
    # Only the fixed safe-report shape survives, so the projections agree.
    assert report["active"] == _active_snapshot()
    assert report["desired"] == _active_snapshot()
    assert report["state"] == "active"
    assert set(report["active"]) == {
        "contextWindow",
        "maxOutputTokens",
        "compaction",
        "computed",
        "provenance",
    }


def test_derived_budget_instance_is_accepted_and_projected() -> None:
    budget = derive_dsh_budget(
        {"contextWindow": 16384, "maxOutputTokens": 8192}
    )
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=budget, preflight_proven=True
    )
    asyncio.run(runtime.start())

    report = runtime.configuration_report(desired=budget)

    assert report["active"] == budget.safe_report()
    assert report["desired"] == budget.safe_report()
    assert report["state"] == "active"
    assert report["differences"] == {}


def test_differences_only_name_known_report_paths() -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=_active_snapshot(), preflight_proven=True
    )
    asyncio.run(runtime.start())
    desired = _desired_snapshot()
    desired["note"] = "sk-live-difference-note"
    desired["baseUrl"] = "https://user:pass@host"

    report = runtime.configuration_report(desired=desired)

    assert report["differences"]
    serialized = json.dumps(report, sort_keys=True)
    assert "sk-live-difference-note" not in serialized
    assert "user:pass" not in serialized
    assert all(
        "note" not in path and "baseUrl" not in path
        for path in report["differences"]
    )


def test_provenance_projection_rejects_or_drops_unknown_strings() -> None:
    leaked_source = _active_snapshot()
    leaked_source["provenance"]["context_window"] = {
        "source": "sk-live-provenance-source",
        "derivedFrom": ["context_window"],
    }
    with pytest.raises(DshAcpSessionError, match=r"provenance.context_window.source"):
        SharedDshRuntime().bind_transport(
            FakeTransport(), snapshot=leaked_source
        )

    leaked_derived = _active_snapshot()
    leaked_derived["provenance"]["context_window"] = {
        "source": "user",
        "derivedFrom": ["sk-live-derived-from"],
    }
    with pytest.raises(DshAcpSessionError, match=r"derivedFrom"):
        SharedDshRuntime().bind_transport(
            FakeTransport(), snapshot=leaked_derived
        )

    unknown_name = _active_snapshot()
    unknown_name["provenance"]["note"] = {
        "source": "user",
        "derivedFrom": ["sk-live-hidden-value"],
    }
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=unknown_name, preflight_proven=True
    )
    asyncio.run(runtime.start())
    report = runtime.configuration_report()
    assert "note" not in report["active"]["provenance"]
    assert "sk-live-hidden-value" not in json.dumps(report, sort_keys=True)


@pytest.mark.parametrize(
    "snapshot",
    [
        [],
        "not-a-mapping",
        {"contextWindow": "sk-live-context"},
        {"contextWindow": True},
        {"maxOutputTokens": 4096.5},
        {"compaction": {"enabled": "yes"}},
        {"compaction": {"headroom": "4096"}},
        {"compaction": []},
        {"computed": {"messageBudget": "4096"}},
        {"computed": {"pressure": None}},
        {
            "provenance": {
                "context_window": {
                    "source": "user",
                    "derivedFrom": "context_window",
                }
            }
        },
    ],
)
def test_invalid_snapshot_types_are_rejected(snapshot: Any) -> None:
    runtime = SharedDshRuntime()
    with pytest.raises(DshAcpSessionError):
        runtime.bind_transport(FakeTransport(), snapshot=snapshot)
    assert runtime._transport is None
    assert runtime.configuration_report()["active"] is None


def test_invalid_desired_types_are_rejected() -> None:
    runtime = SharedDshRuntime()
    with pytest.raises(DshAcpSessionError, match="must be a mapping"):
        runtime.configuration_report(desired="sk-live-desired")
    with pytest.raises(DshAcpSessionError, match="contextWindow"):
        runtime.configuration_report(desired={"contextWindow": [1]})
    with pytest.raises(DshAcpSessionError, match="provenance"):
        runtime.configuration_report(
            desired={"provenance": {"context_window": "sk-live"}}
        )


def test_unproven_preflight_is_not_reported_as_applied() -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=_active_snapshot(), preflight_proven=False
    )
    assert runtime.configuration_report()["preflightApplied"] is False

    asyncio.run(runtime.start())

    report = runtime.configuration_report()
    assert report["active"] is not None
    assert report["preflightApplied"] is False


def test_compaction_state_is_disabled_or_not_observable_never_observed() -> None:
    disabled = SharedDshRuntime()
    disabled.bind_transport(
        FakeTransport(),
        snapshot=derive_dsh_budget(
            {"compactionEnabled": False}
        ).safe_report(),
        preflight_proven=True,
    )
    assert disabled.configuration_report()["compaction"] == "not-observable"
    asyncio.run(disabled.start())
    assert disabled.configuration_report()["compaction"] == "disabled"

    enabled = SharedDshRuntime()
    enabled.bind_transport(
        FakeTransport(), snapshot=_active_snapshot(), preflight_proven=True
    )
    asyncio.run(enabled.start())
    assert enabled.configuration_report()["compaction"] == "not-observable"


def test_legacy_bind_records_no_snapshot_or_preflight_claim() -> None:
    runtime = SharedDshRuntime()
    transport = FakeTransport()
    assert runtime.bind_transport(transport) is transport

    # Before the handshake the runtime really has not started.
    assert runtime.configuration_report()["state"] == "not-started"

    asyncio.run(runtime.start())

    report = runtime.configuration_report()
    assert report["active"] is None
    assert report["generation"] == 0
    # Started, but no configuration snapshot was ever recorded.
    assert report["state"] == "snapshot-unavailable"
    assert report["preflightApplied"] is False


def test_generation_increments_only_on_successful_runtime_start() -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(), snapshot=_active_snapshot(), preflight_proven=True
    )

    asyncio.run(runtime.start())
    assert runtime.configuration_report()["generation"] == 1
    asyncio.run(runtime.start())
    assert runtime.configuration_report()["generation"] == 1

    asyncio.run(runtime.recover())
    assert runtime.configuration_report()["generation"] == 2

    failing = SharedDshRuntime()
    failing.bind_transport(
        BadProtocolTransport(), snapshot=_active_snapshot(), preflight_proven=True
    )
    with pytest.raises(DshAcpSessionError, match="protocol version"):
        asyncio.run(failing.start())
    failed_report = failing.configuration_report()
    assert failed_report["active"] is None
    assert failed_report["generation"] == 0
    assert failed_report["state"] == "not-started"


def test_runtime_lifetime_bounds_generation_identity() -> None:
    first = SharedDshRuntime()
    second = SharedDshRuntime()

    first_report = first.configuration_report(desired=_active_snapshot())
    second_report = second.configuration_report(desired=_active_snapshot())

    assert isinstance(first_report["runtimeLifetime"], str)
    assert first_report["runtimeLifetime"]
    assert first_report["runtimeLifetime"] != second_report["runtimeLifetime"]


def _initialize_sent(transport: FakeTransport) -> bool:
    return any(method == "initialize" for method, _params in transport.requests)


def test_adopt_initialized_transport_skips_start_and_initialize() -> None:
    runtime = SharedDshRuntime()
    transport = FakeTransport()

    adopted = runtime.adopt_initialized_transport(
        transport, snapshot=_active_snapshot(), preflight_proven=True
    )

    assert adopted is transport
    assert transport.started == 0
    assert not _initialize_sent(transport)
    report = runtime.configuration_report()
    assert report["state"] == "active"
    assert report["active"] == _active_snapshot()
    assert report["generation"] == 1
    assert report["preflightApplied"] is True
    assert runtime.process_id == 4242

    # The shared runtime is already started, so request paths never handshake.
    asyncio.run(runtime.request("session/new", {}))
    assert transport.started == 0
    assert not _initialize_sent(transport)


def test_repeated_adopt_of_same_transport_is_idempotent() -> None:
    runtime = SharedDshRuntime()
    transport = FakeTransport()
    runtime.adopt_initialized_transport(
        transport, snapshot=_active_snapshot(), preflight_proven=True
    )

    runtime.adopt_initialized_transport(
        transport, snapshot=_desired_snapshot(), preflight_proven=False
    )

    report = runtime.configuration_report()
    assert report["active"] == _active_snapshot()
    assert report["generation"] == 1
    assert report["preflightApplied"] is True
    assert transport.started == 0


def test_adopt_does_not_replace_or_close_a_different_transport() -> None:
    runtime = SharedDshRuntime()
    first = FakeTransport()
    second = FakeTransport()
    runtime.adopt_initialized_transport(
        first, snapshot=_active_snapshot(), preflight_proven=True
    )

    adopted = runtime.adopt_initialized_transport(
        second, snapshot=_desired_snapshot(), preflight_proven=False
    )

    assert adopted is first
    assert runtime.configuration_report()["active"] == _active_snapshot()
    assert runtime.configuration_report()["generation"] == 1
    assert second.closed is False
    assert second.started == 0
    assert not _initialize_sent(second)


@pytest.mark.parametrize(
    "snapshot",
    [
        [],
        "not-a-mapping",
        {"contextWindow": "sk-live-context"},
        {"compaction": {"enabled": "yes"}},
        {"provenance": {"context_window": {"source": "sk-live", "derivedFrom": []}}},
    ],
)
def test_adopt_rejects_invalid_snapshot_without_half_binding(snapshot: Any) -> None:
    runtime = SharedDshRuntime()
    transport = FakeTransport()

    with pytest.raises(DshAcpSessionError):
        runtime.adopt_initialized_transport(transport, snapshot=snapshot)

    assert runtime._transport is None
    assert runtime._started is False
    report = runtime.configuration_report()
    assert report["active"] is None
    assert report["generation"] == 0
    assert report["state"] == "not-started"
    assert transport.started == 0


def test_adopt_of_bound_transport_uses_candidate_not_later_snapshot() -> None:
    runtime = SharedDshRuntime()
    transport = FakeTransport()
    runtime.bind_transport(
        transport, snapshot=_active_snapshot(), preflight_proven=True
    )

    adopted = runtime.adopt_initialized_transport(
        transport, snapshot=_desired_snapshot(), preflight_proven=False
    )

    assert adopted is transport
    assert transport.started == 0
    assert not _initialize_sent(transport)
    report = runtime.configuration_report()
    assert report["active"] == _active_snapshot()
    assert report["generation"] == 1
    assert report["preflightApplied"] is True


def test_adopt_without_snapshot_reports_snapshot_unavailable() -> None:
    runtime = SharedDshRuntime()
    transport = FakeTransport()
    runtime.adopt_initialized_transport(transport)

    report = runtime.configuration_report()
    assert report["active"] is None
    assert report["generation"] == 0
    assert report["state"] == "snapshot-unavailable"
    assert report["preflightApplied"] is False
    assert transport.started == 0


def test_transport_startup_serializes_two_bootstraps_to_one_transport() -> None:
    runtime = SharedDshRuntime()
    created: list[FakeTransport] = []

    async def bootstrap(label: str) -> Any:
        async with runtime.transport_startup() as startup:
            if startup.owns_bootstrap:
                # Yield control so a second caller can reach the lock while
                # this one is still inside its transaction.
                await asyncio.sleep(0.01)
                transport = FakeTransport()
                created.append(transport)
                runtime.adopt_initialized_transport(
                    transport,
                    snapshot=_active_snapshot(),
                    preflight_proven=True,
                )
            else:
                assert startup.transport is runtime._transport
            return runtime._transport

    async def scenario() -> list[Any]:
        return await asyncio.gather(bootstrap("a"), bootstrap("b"))

    transports = asyncio.run(scenario())

    assert len(created) == 1
    assert transports[0] is transports[1]
    assert created[0].started == 0
    report = runtime.configuration_report()
    assert report["active"] == _active_snapshot()
    assert report["generation"] == 1


def test_transport_startup_keeps_first_snapshot_under_a_late_adopt() -> None:
    runtime = SharedDshRuntime()

    async def bootstrap(create_first: bool) -> None:
        async with runtime.transport_startup():
            if create_first:
                runtime.adopt_initialized_transport(
                    FakeTransport(),
                    snapshot=_active_snapshot(),
                    preflight_proven=True,
                )
            else:
                # A writer that ignored the gate cannot override the first
                # transport's snapshot: adopt is first-wins and never closes
                # or starts the late transport.
                late = FakeTransport()
                adopted = runtime.adopt_initialized_transport(
                    late,
                    snapshot=_desired_snapshot(),
                    preflight_proven=True,
                )
                assert adopted is not late
                assert late.started == 0
                assert late.closed is False

    async def scenario() -> None:
        await bootstrap(create_first=True)
        await bootstrap(create_first=False)

    asyncio.run(scenario())

    report = runtime.configuration_report(desired=_desired_snapshot())
    assert report["active"] == _active_snapshot()
    assert report["generation"] == 1


def test_transport_startup_fast_path_still_locks_without_starting() -> None:
    transport = FakeTransport()
    runtime = SharedDshRuntime(transport)

    async def scenario() -> None:
        async with runtime.transport_startup() as startup:
            assert startup.owns_bootstrap is False
            assert startup.transport is transport
            # Starting the already bound transport while the bootstrap lock is
            # held proves the two locks are independent and cannot deadlock.
            await runtime.start()
        async with runtime.transport_startup() as startup:
            assert startup.owns_bootstrap is False
            assert startup.transport is transport

    asyncio.run(scenario())

    assert transport.started == 1
    assert transport.closed is False
    assert runtime.initialize_count == 1


def test_transport_startup_releases_lock_after_exception() -> None:
    runtime = SharedDshRuntime()

    async def scenario() -> None:
        with pytest.raises(RuntimeError, match="boom"):
            async with runtime.transport_startup() as startup:
                assert startup.owns_bootstrap is True
                raise RuntimeError("boom")
        async with runtime.transport_startup() as startup:
            assert startup.owns_bootstrap is True

    asyncio.run(scenario())


def test_transport_startup_releases_lock_after_cancellation() -> None:
    runtime = SharedDshRuntime()

    async def scenario() -> None:
        entered = asyncio.Event()

        async def holder() -> None:
            async with runtime.transport_startup():
                entered.set()
                await asyncio.sleep(10)

        task = asyncio.create_task(holder())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        async with runtime.transport_startup() as startup:
            assert startup.owns_bootstrap is True

    asyncio.run(scenario())


def test_recover_clears_stale_preflight_evidence() -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(),
        snapshot=derive_dsh_budget(
            {"compactionEnabled": False}
        ).safe_report(),
        preflight_proven=True,
    )
    asyncio.run(runtime.start())
    assert runtime.configuration_report()["preflightApplied"] is True
    assert runtime.configuration_report()["compaction"] == "disabled"

    asyncio.run(runtime.recover())

    report = runtime.configuration_report()
    assert report["preflightApplied"] is False
    assert report["compaction"] == "not-observable"
    assert report["generation"] == 2


def test_unproven_snapshot_never_reports_compaction_disabled() -> None:
    runtime = SharedDshRuntime()
    runtime.bind_transport(
        FakeTransport(),
        snapshot=derive_dsh_budget(
            {"compactionEnabled": False}
        ).safe_report(),
        preflight_proven=False,
    )
    asyncio.run(runtime.start())

    report = runtime.configuration_report()
    assert report["active"]["compaction"]["enabled"] is False
    assert report["preflightApplied"] is False
    assert report["compaction"] == "not-observable"
