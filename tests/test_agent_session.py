import asyncio

from jupyter_aiterminal.agent import (
    AgentSession,
    _is_not_connected_error,
    format_sdk_error,
    sdk_client_kwargs,
    sdk_environment,
)
from jupyter_aiterminal.policy import FORBIDDEN_REASON
from jupyter_aiterminal.settings import AgentConfigError


def _configure_fake_sdk(monkeypatch, factory):
    monkeypatch.setattr(
        "jupyter_aiterminal.agent.load_agent_settings",
        lambda: {
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "secret",
            "ANTHROPIC_MODEL": "claude-opus-5",
        },
    )
    monkeypatch.setattr(
        "jupyter_aiterminal.agent._build_options",
        lambda **kwargs: kwargs,
    )
    monkeypatch.setattr("jupyter_aiterminal.agent.ClaudeSDKClient", factory)


def _emit_to(events):
    async def emit(event):
        events.append(event)

    return emit


def test_start_reports_missing_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "jupyter_aiterminal.agent.load_agent_settings",
        lambda: (_ for _ in ()).throw(
            __import__("jupyter_aiterminal.settings", fromlist=["AgentConfigError"]).AgentConfigError(
                "AI Terminal settings are missing. Open Settings → AI Terminal and set Base URL, Model, and API Token."
            )
        ),
    )
    events = []

    async def emit(event):
        events.append(event)

    asyncio.run(AgentSession("/tmp", emit).start())
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "config"
    assert "Settings" in events[0]["message"]
    assert "Base URL" in events[0]["message"]
    assert "Model" in events[0]["message"]
    assert "API Token" in events[0]["message"]


def test_pre_tool_use_denies_apt():
    events = []

    async def emit(event):
        events.append(event)

    result = asyncio.run(
        AgentSession(".", emit)._pre_tool_use(
            {"tool_name": "Bash", "tool_input": {"command": "apt-get install jq"}},
            None,
            None,
        )
    )
    assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert events == [
        {
            "type": "denied",
            "command": "apt-get install jq",
            "reason": FORBIDDEN_REASON,
        }
    ]


def test_sdk_environment_allows_root_bypass(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/bin")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "minimax-token")
    monkeypatch.setenv("AITERMINAL_CLAUDE_HOME", str(tmp_path / "claude-home"))
    env = sdk_environment(
        {
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "secret",
            "ANTHROPIC_MODEL": "claude-opus-5",
        }
    )
    assert env["IS_SANDBOX"] == "1"
    assert "/usr/local/bin" in env["PATH"]
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "claude-home")
    assert (tmp_path / "claude-home").is_dir()


def test_sdk_client_kwargs_ignore_user_claude_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/bin")
    monkeypatch.setenv("AITERMINAL_CLAUDE_HOME", str(tmp_path / "claude-home"))
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    claude = fake_bin / "claude"
    claude.write_text("#!/bin/sh\n")
    claude.chmod(0o755)
    monkeypatch.setenv("PATH", str(fake_bin))

    async def hook(_input, _id, _ctx):
        return {}

    kwargs = sdk_client_kwargs(
        {
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "secret",
            "ANTHROPIC_MODEL": "claude-opus-5",
        },
        "/tmp",
        hook,
    )
    assert kwargs["setting_sources"] == []
    assert kwargs["system_prompt"]["preset"] == "claude_code"
    assert "do not summarize" in kwargs["system_prompt"]["append"]
    assert kwargs["extra_args"] == {"no-session-persistence": None}
    assert kwargs["cli_path"] == str(claude)
    assert kwargs["env"]["ANTHROPIC_BASE_URL"] == "https://api.anthropic.com"
    assert "stderr" not in kwargs
    captured: list[str] = []
    kwargs = sdk_client_kwargs(
        {
            "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "secret",
            "ANTHROPIC_MODEL": "claude-opus-5",
        },
        "/tmp",
        hook,
        captured,
    )
    kwargs["stderr"]("boom")
    assert captured == ["boom"]


def test_format_sdk_error_includes_stderr():
    class CLIProcessError(RuntimeError):
        def __init__(self):
            super().__init__("Command failed with exit code 1")
            self.stderr = "--dangerously-skip-permissions cannot be used with root"

    assert "dangerously-skip-permissions" in format_sdk_error(CLIProcessError())
    assert "rate_limit" in format_sdk_error(
        RuntimeError("Command failed with exit code 1"),
        ["API error: rate_limit_error"],
    )


def test_concurrent_starts_create_one_client(monkeypatch):
    created = []
    started = asyncio.Event()
    release = asyncio.Event()

    class FakeClient:
        async def connect(self):
            started.set()
            await release.wait()

    def factory(_options):
        client = FakeClient()
        created.append(client)
        return client

    _configure_fake_sdk(monkeypatch, factory)

    async def run():
        session = AgentSession("/tmp", _emit_to([]))
        first = asyncio.create_task(session.start())
        second = asyncio.create_task(session.start())
        await started.wait()
        assert len(created) == 1
        release.set()
        await asyncio.gather(first, second)
        assert session.client is created[0]

    asyncio.run(run())


def test_connect_failure_does_not_publish_client(monkeypatch):
    events = []

    class FakeClient:
        async def connect(self):
            raise RuntimeError("relay unavailable")

    _configure_fake_sdk(monkeypatch, lambda _options: FakeClient())

    async def run():
        session = AgentSession("/tmp", _emit_to(events))
        await session.start()
        assert session.client is None

    asyncio.run(run())
    assert events == [
        {
            "type": "error",
            "code": "runtime",
            "message": "relay unavailable",
        }
    ]


def test_query_waits_for_in_progress_start(monkeypatch):
    events = []
    started = asyncio.Event()
    release = asyncio.Event()
    created = []

    class FakeClient:
        def __init__(self):
            self.queries = []

        async def connect(self):
            started.set()
            await release.wait()

        async def query(self, prompt):
            self.queries.append(prompt)

        async def receive_response(self):
            if False:
                yield None

    def factory(_options):
        client = FakeClient()
        created.append(client)
        return client

    _configure_fake_sdk(monkeypatch, factory)

    async def run():
        session = AgentSession("/tmp", _emit_to(events))
        starting = asyncio.create_task(session.start())
        await started.wait()
        querying = asyncio.create_task(session.query("hello"))
        await asyncio.sleep(0)
        assert created[0].queries == []
        release.set()
        await asyncio.gather(starting, querying)

    asyncio.run(run())
    assert created[0].queries == ["hello"]
    assert not any(event["type"] == "error" for event in events)


def test_close_during_start_does_not_publish_client(monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()
    created = []

    class FakeClient:
        def __init__(self):
            self.disconnects = 0

        async def connect(self):
            started.set()
            await release.wait()

        async def disconnect(self):
            self.disconnects += 1

    def factory(_options):
        client = FakeClient()
        created.append(client)
        return client

    _configure_fake_sdk(monkeypatch, factory)

    async def run():
        session = AgentSession("/tmp", _emit_to([]))
        starting = asyncio.create_task(session.start())
        await started.wait()
        closing = asyncio.create_task(session.close())
        release.set()
        await asyncio.gather(starting, closing)
        assert session.client is None
        assert created[0].disconnects == 1

    asyncio.run(run())


def test_not_connected_predicate_is_specific():
    not_connected = type("CLIConnectionError", (RuntimeError,), {})
    assert _is_not_connected_error(
        not_connected("Not connected. Call connect() first.")
    )
    assert not _is_not_connected_error(RuntimeError("relay unavailable"))
    assert not _is_not_connected_error(
        not_connected("Not connected. Call connect() first.\nDetails")
    )


def test_query_reconnects_once_after_stale_client(monkeypatch):
    events = []
    created = []
    NotConnected = type("CLIConnectionError", (RuntimeError,), {})

    class StaleClient:
        def __init__(self):
            self.queries = []
            self.disconnects = 0

        async def query(self, prompt):
            self.queries.append(prompt)
            raise NotConnected("Not connected. Call connect() first.")

        async def disconnect(self):
            self.disconnects += 1

    class FreshClient:
        def __init__(self):
            self.queries = []

        async def connect(self):
            pass

        async def query(self, prompt):
            self.queries.append(prompt)

        async def receive_response(self):
            if False:
                yield None

    def factory(_options):
        client = FreshClient()
        created.append(client)
        return client

    _configure_fake_sdk(monkeypatch, factory)
    stale = StaleClient()

    async def run():
        session = AgentSession("/tmp", _emit_to(events))
        session.client = stale
        await session.query("hello")
        assert session.client is created[0]

    asyncio.run(run())
    assert stale.queries == ["hello"]
    assert stale.disconnects == 1
    assert created[0].queries == ["hello"]
    assert not any(
        "Not connected. Call connect() first." in event.get("message", "")
        for event in events
    )


def test_reconnect_failure_is_actionable(monkeypatch):
    events = []
    NotConnected = type("CLIConnectionError", (RuntimeError,), {})

    class StaleClient:
        async def query(self, _prompt):
            raise NotConnected("Not connected. Call connect() first.")

        async def disconnect(self):
            pass

    class FailedClient:
        async def connect(self):
            raise RuntimeError("reconnect failed")

    _configure_fake_sdk(monkeypatch, lambda _options: FailedClient())

    async def run():
        session = AgentSession("/tmp", _emit_to(events))
        session.client = StaleClient()
        await session.query("hello")
        assert session.client is None

    asyncio.run(run())
    assert events == [
        {
            "type": "error",
            "code": "runtime",
            "message": "reconnect failed",
        }
    ]


def test_query_does_not_retry_after_second_not_connected_error(monkeypatch):
    events = []
    created = []
    NotConnected = type("CLIConnectionError", (RuntimeError,), {})

    class StaleClient:
        async def query(self, _prompt):
            raise NotConnected("Not connected. Call connect() first.")

        async def disconnect(self):
            pass

    class StillDisconnectedClient:
        def __init__(self):
            self.queries = []

        async def connect(self):
            pass

        async def query(self, prompt):
            self.queries.append(prompt)
            raise NotConnected("Not connected. Call connect() first.")

    def factory(_options):
        client = StillDisconnectedClient()
        created.append(client)
        return client

    _configure_fake_sdk(monkeypatch, factory)

    async def run():
        session = AgentSession("/tmp", _emit_to(events))
        session.client = StaleClient()
        await session.query("hello")

    asyncio.run(run())
    assert len(created) == 1
    assert created[0].queries == ["hello"]
    assert events[-1] == {
        "type": "error",
        "code": "runtime",
        "message": "Agent connection is not available after reconnecting.",
    }
    assert not any(
        "Not connected. Call connect() first." in event.get("message", "")
        for event in events
    )


def test_query_reports_missing_settings_before_connecting(monkeypatch):
    events = []
    created = []

    monkeypatch.setattr(
        "jupyter_aiterminal.agent.load_agent_settings",
        lambda: (_ for _ in ()).throw(
            AgentConfigError(
                "AI Terminal settings are missing. Open Settings → AI Terminal."
            )
        ),
    )
    monkeypatch.setattr(
        "jupyter_aiterminal.agent.ClaudeSDKClient",
        lambda _options: created.append(object()),
    )

    async def run():
        session = AgentSession("/tmp", _emit_to(events))
        await session.query("hello")
        assert session.client is None
        assert session._running is False

    asyncio.run(run())
    assert created == []
    assert events == [
        {
            "type": "error",
            "code": "config",
            "message": "AI Terminal settings are missing. Open Settings → AI Terminal.",
        }
    ]
