from pathlib import Path

import pytest

from jupyter_aiterminal.settings import (
    AgentConfigError,
    load_agent_settings,
    load_dsh_settings,
    parse_settings,
)
from jupyter_aiterminal.dsh_config import (
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_OPENAI_COMPLETIONS,
)


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
    with pytest.raises(AgentConfigError, match="Settings") as exc_info:
        load_agent_settings(tmp_path / "plugin.jupyterlab-settings")
    message = str(exc_info.value)
    assert "Base URL" in message
    assert "Model" in message
    assert "API Token" in message


def test_invalid_json_points_to_all_required_settings(tmp_path: Path):
    path = tmp_path / "plugin.jupyterlab-settings"
    path.write_text("{not-json}\n")
    with pytest.raises(AgentConfigError, match="Settings") as exc_info:
        load_agent_settings(path)
    message = str(exc_info.value)
    assert "Base URL" in message
    assert "Model" in message
    assert "API Token" in message


def test_non_object_settings_point_to_all_required_fields():
    with pytest.raises(AgentConfigError, match="JSON object") as exc_info:
        parse_settings("[]")
    message = str(exc_info.value)
    assert "Settings → AI Terminal" in message
    assert "Base URL" in message
    assert "Model" in message
    assert "API Token" in message


def test_missing_key_is_a_config_error(tmp_path: Path):
    path = tmp_path / "plugin.jupyterlab-settings"
    path.write_text('{"baseUrl": "https://api.anthropic.com", "model": "", "token": "x"}\n')
    with pytest.raises(AgentConfigError, match="model") as exc_info:
        load_agent_settings(path)
    message = str(exc_info.value)
    assert "Settings" in message
    assert "Base URL" in message
    assert "Model" in message
    assert "API Token" in message


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


SECRET = "settings-unit-test-token-never-render-me"


def _write_settings(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "plugin.jupyterlab-settings"
    path.write_text(body, encoding="utf-8")
    return path


def test_load_dsh_settings_defaults_protocol_to_anthropic(tmp_path: Path):
    path = _write_settings(
        tmp_path,
        '// legacy settings without apiProtocol\n'
        '{"baseUrl": "https://api.anthropic.com", '
        '"model": "claude-opus-5", "token": "secret"}\n',
    )
    config = load_dsh_settings(path)
    assert config.api_protocol == PROTOCOL_ANTHROPIC_MESSAGES
    assert config.base_url == "https://api.anthropic.com"
    assert config.model == "claude-opus-5"
    assert config.token == "secret"


def test_load_dsh_settings_reads_explicit_openai_protocol(tmp_path: Path):
    path = _write_settings(
        tmp_path,
        '{"apiProtocol": "openai-completions", '
        '"baseUrl": "https://api.example.test/v1", '
        '"model": "gpt-local", "token": "secret"}\n',
    )
    config = load_dsh_settings(path)
    assert config.api_protocol == PROTOCOL_OPENAI_COMPLETIONS
    assert config.model == "gpt-local"


def test_load_dsh_settings_rejects_unknown_protocol(tmp_path: Path):
    path = _write_settings(
        tmp_path,
        '{"apiProtocol": "openai-responses", '
        '"baseUrl": "https://api.example.test/v1", '
        '"model": "m", "token": "secret"}\n',
    )
    with pytest.raises(AgentConfigError, match="apiProtocol"):
        load_dsh_settings(path)


def test_load_dsh_settings_missing_file(tmp_path: Path):
    with pytest.raises(AgentConfigError, match="missing"):
        load_dsh_settings(tmp_path / "plugin.jupyterlab-settings")


def test_load_dsh_settings_missing_field(tmp_path: Path):
    path = _write_settings(
        tmp_path,
        '{"baseUrl": "https://api.example.test/v1", "model": "m"}\n',
    )
    with pytest.raises(AgentConfigError, match="token"):
        load_dsh_settings(path)


def test_load_dsh_settings_invalid_json_does_not_leak_token(tmp_path: Path):
    path = _write_settings(
        tmp_path, '{"token": "' + SECRET + '", not-json}\n'
    )
    with pytest.raises(AgentConfigError) as exc_info:
        load_dsh_settings(path)
    assert SECRET not in str(exc_info.value)
    assert SECRET not in repr(exc_info.value)


def test_load_dsh_settings_non_object_is_a_config_error(tmp_path: Path):
    path = _write_settings(tmp_path, "[]\n")
    with pytest.raises(AgentConfigError, match="JSON object"):
        load_dsh_settings(path)
