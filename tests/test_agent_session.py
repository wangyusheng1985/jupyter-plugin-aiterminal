import asyncio

from jupyter_aiterminal.agent import (
    AgentSession,
    format_sdk_error,
    sdk_client_kwargs,
    sdk_environment,
)
from jupyter_aiterminal.policy import FORBIDDEN_REASON


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
