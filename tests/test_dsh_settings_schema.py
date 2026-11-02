"""Contract tests for the AI Terminal settings schema (schema/plugin.json)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "plugin.json"

ANTHROPIC_MESSAGES = "anthropic-messages"
OPENAI_COMPLETIONS = "openai-completions"
CONFIG_FIELDS = ("baseUrl", "model", "token")


def _schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _properties() -> dict:
    return _schema()["properties"]


def _validate(raw: dict) -> None:
    """Validate a *raw user settings object* against the shipped schema.

    JupyterLab's SettingsRegistry validates only the user raw settings
    (``validate(user)``) before merging schema defaults, so these tests apply
    the schema to raw objects such as ``{}`` and partial configurations.
    ``jsonschema`` ships with the Jupyter stack; skip rather than add a new
    dependency if it is unavailable.
    """

    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(instance=raw, schema=_schema())


def test_schema_is_a_json_object_with_disabled_extra_settings():
    schema = _schema()

    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert set(_properties()) == {"apiProtocol", *CONFIG_FIELDS}


def test_schema_has_no_root_required_so_new_and_partial_settings_load():
    # Root-level ``required`` would reject the ``{}`` sent by the server when no
    # user settings file exists, leaving the Settings Editor unable to load the
    # plugin. Field completeness is enforced by the backend instead.
    assert "required" not in _schema()
    for field in CONFIG_FIELDS:
        assert "required" not in _properties()[field]


def test_new_user_empty_settings_pass_schema_validation():
    _validate({})


def test_partial_settings_pass_schema_validation():
    _validate({"baseUrl": "https://relay.example.com/v1"})
    _validate({"model": "some-model"})
    _validate({"token": "placeholder"})
    _validate({"apiProtocol": OPENAI_COMPLETIONS})
    _validate({"baseUrl": "https://api.anthropic.com", "apiProtocol": ANTHROPIC_MESSAGES})


def test_full_settings_pass_schema_validation():
    _validate(
        {
            "apiProtocol": ANTHROPIC_MESSAGES,
            "baseUrl": "https://api.anthropic.com",
            "model": "some-model",
            "token": "placeholder",
        }
    )


def test_validator_rejects_settings_the_schema_disallows():
    # Guards the validation helper itself: the shipped schema is not a no-op.
    jsonschema = pytest.importorskip("jsonschema")
    schema = _schema()

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance={"unknownField": "x"}, schema=schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance={"apiProtocol": "responses"}, schema=schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance={"baseUrl": 42}, schema=schema)


def test_api_protocol_enum_lists_only_supported_protocols():
    api_protocol = _properties()["apiProtocol"]

    assert api_protocol["type"] == "string"
    assert set(api_protocol["enum"]) == {ANTHROPIC_MESSAGES, OPENAI_COMPLETIONS}


def test_api_protocol_defaults_to_anthropic_messages():
    # The schema default is a UI/fallback hint, not a claim about backend state.
    assert _properties()["apiProtocol"]["default"] == ANTHROPIC_MESSAGES


def test_config_fields_are_optional_strings():
    for field in CONFIG_FIELDS:
        assert _properties()[field]["type"] == "string"


def test_descriptions_do_not_claim_claude_sdk_exclusivity():
    for name, prop in _properties().items():
        text = f"{prop.get('title', '')} {prop.get('description', '')}"
        lowered = text.lower()
        assert "claude agent sdk" not in lowered, name
        assert "claudesdk" not in lowered, name
        assert "claude sdk" not in lowered, name


def test_token_description_states_server_side_settings_storage():
    description = _properties()["token"]["description"].lower()

    assert "jupyterlab user settings" in description
    assert "server" in description
    assert "vault" not in description
    assert "password manager" not in description


def test_defaults_do_not_ship_a_gateway_or_secret():
    properties = _properties()

    for field in CONFIG_FIELDS:
        assert properties[field]["default"] == ""
