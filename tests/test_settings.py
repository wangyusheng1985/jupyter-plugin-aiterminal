from pathlib import Path

import pytest

from jupyter_aiterminal.settings import AgentConfigError, load_agent_settings, parse_settings


def test_parse_settings_strips_jsonc():
    values = parse_settings(
        """
        {
          // comment
          "baseUrl": "https://api.anthropic.com",
          "model": "claude-opus-5",
          "token": "secret"
        }
        """
    )
    assert values["baseUrl"] == "https://api.anthropic.com"
    assert values["model"] == "claude-opus-5"
    assert values["token"] == "secret"


def test_missing_file_is_a_config_error(tmp_path: Path):
    with pytest.raises(AgentConfigError, match="Settings"):
        load_agent_settings(tmp_path / "plugin.jupyterlab-settings")


def test_missing_key_is_a_config_error(tmp_path: Path):
    path = tmp_path / "plugin.jupyterlab-settings"
    path.write_text('{"baseUrl": "https://api.anthropic.com", "model": "", "token": "x"}\n')
    with pytest.raises(AgentConfigError, match="model"):
        load_agent_settings(path)


def test_official_api_is_allowed(tmp_path: Path):
    path = tmp_path / "plugin.jupyterlab-settings"
    path.write_text(
        '{"baseUrl": "https://api.anthropic.com", "model": "claude-opus-5", "token": "secret"}\n'
    )
    values = load_agent_settings(path)
    assert values["ANTHROPIC_BASE_URL"] == "https://api.anthropic.com"
    assert values["ANTHROPIC_MODEL"] == "claude-opus-5"
    assert values["ANTHROPIC_API_KEY"] == "secret"


def test_valid_jsonc_settings(tmp_path: Path):
    path = tmp_path / "plugin.jupyterlab-settings"
    path.write_text(
        '/* header */\n{"baseUrl": "http://127.0.0.1:8090/anthropic", '
        '"model": "local-model", "token": "secret"}\n'
    )
    values = load_agent_settings(path)
    assert values["ANTHROPIC_MODEL"] == "local-model"
