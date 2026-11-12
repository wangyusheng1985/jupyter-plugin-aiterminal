"""Contract tests for the AI Terminal settings schema (schema/plugin.json)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "plugin.json"

ANTHROPIC_MESSAGES = "anthropic-messages"
OPENAI_COMPLETIONS = "openai-completions"
CONFIG_FIELDS = ("baseUrl", "model", "token")
# Optional multi-model selector: an array of model ids.
MODEL_LIST_FIELDS = ("models",)
# Advanced budget fields: optional positive integers.
POSITIVE_INTEGER_FIELDS = ("contextWindow", "maxOutputTokens", "compactionSummaryMaxTokens")
# Compaction headroom may legitimately be zero.
NON_NEGATIVE_INTEGER_FIELDS = ("compactionHeadroom",)
RATIO_FIELDS = ("compactionThresholdRatio", "compactionRetainRatio")
BOOLEAN_FIELDS = ("compactionEnabled",)
ADVANCED_FIELDS = (
    *POSITIVE_INTEGER_FIELDS,
    *NON_NEGATIVE_INTEGER_FIELDS,
    *RATIO_FIELDS,
    *BOOLEAN_FIELDS,
)


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
    assert set(_properties()) == {
        "apiProtocol",
        *CONFIG_FIELDS,
        *MODEL_LIST_FIELDS,
        *ADVANCED_FIELDS,
    }


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


def test_advanced_fields_are_optional_and_ship_no_schema_default():
    # A schema default would be injected into the merged settings and mask
    # whether the value came from the user or from a runtime default, so the
    # raw provenance could no longer be reported.
    for field in ADVANCED_FIELDS:
        prop = _properties()[field]
        assert "default" not in prop, field
        assert "required" not in prop, field


def test_advanced_settings_are_absent_from_partial_settings():
    _validate({})
    _validate(
        {
            "apiProtocol": ANTHROPIC_MESSAGES,
            "baseUrl": "https://api.anthropic.com",
            "model": "some-model",
            "token": "placeholder",
        }
    )


def test_advanced_field_types_and_bounds():
    properties = _properties()

    for field in POSITIVE_INTEGER_FIELDS:
        assert properties[field]["type"] == "integer"
        assert properties[field]["minimum"] == 1

    headroom = properties["compactionHeadroom"]
    assert headroom["type"] == "integer"
    assert headroom["minimum"] == 0

    for field in RATIO_FIELDS:
        ratio = properties[field]
        assert ratio["type"] == "number"
        assert ratio["exclusiveMinimum"] == 0
        assert ratio["maximum"] == 1

    for field in BOOLEAN_FIELDS:
        assert properties[field]["type"] == "boolean"


def test_advanced_settings_pass_schema_validation():
    _validate(
        {
            "contextWindow": 200000,
            "maxOutputTokens": 32000,
            "compactionEnabled": True,
            "compactionThresholdRatio": 0.8,
            "compactionRetainRatio": 0.3,
            "compactionHeadroom": 0,
            "compactionSummaryMaxTokens": 4000,
        }
    )


def test_ratios_accept_one_but_reject_zero_and_above_one():
    for field in RATIO_FIELDS:
        _validate({field: 1})
        jsonschema = pytest.importorskip("jsonschema")
        for value in (0, 0.0, -0.1, 1.1):
            with pytest.raises(jsonschema.ValidationError):
                jsonschema.validate(instance={field: value}, schema=_schema())


def test_integer_budgets_reject_zero_negative_and_non_integer():
    jsonschema = pytest.importorskip("jsonschema")
    schema = _schema()

    for field in POSITIVE_INTEGER_FIELDS:
        for value in (0, -1, 1.5, "100"):
            with pytest.raises(jsonschema.ValidationError):
                jsonschema.validate(instance={field: value}, schema=schema)

    for value in (-1, 1.5, "0"):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance={"compactionHeadroom": value}, schema=schema)


def test_schema_rejects_unknown_budget_keys():
    jsonschema = pytest.importorskip("jsonschema")
    schema = _schema()

    for key in (
        "contextLength",
        "maxTokens",
        "compactionThreshold",
        "compactionRetainTokens",
        "budget",
    ):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance={key: 1}, schema=schema)


def test_advanced_descriptions_state_next_runtime_start():
    # Activation is bounded to the next shared-runtime start; the schema copy
    # must say so instead of implying a hot apply.
    for field in ADVANCED_FIELDS:
        description = _properties()[field]["description"].lower()
        assert "shared runtime next starts" in description, field


def test_context_window_description_does_not_claim_measured_capacity():
    description = _properties()["contextWindow"]["description"].lower()

    assert "not a measurement" in description
