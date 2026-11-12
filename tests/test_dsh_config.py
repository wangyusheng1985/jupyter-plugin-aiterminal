"""Unit contract for the pure DSH provider configuration builder."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from jupyter_aiterminal.dsh_config import (
    BUDGET_SOURCE_DEFAULT,
    BUDGET_SOURCE_DERIVED,
    BUDGET_SOURCE_USER,
    DEFAULT_API_PROTOCOL,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_RETAIN_RATIO,
    DEFAULT_COMPACTION_THRESHOLD_RATIO,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_HEADROOM_RATIO,
    DEFAULT_MAX_OUTPUT_TOKENS,
    DSH_API_KEY_ENV,
    DSH_PLUGIN_ID,
    DSH_PLUGIN_NAME,
    DSH_PROVIDER_ID,
    DSH_STATIC_PROFILE_PATH,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_OPENAI_COMPLETIONS,
    DerivedBudget,
    DshProviderConfig,
    build_profile_patches,
    build_provider_insert_patch,
    derive_dsh_budget,
    parse_dsh_provider_config,
    render_profile_patches,
)
from jupyter_aiterminal.settings import AgentConfigError

SECRET = "dsh-unit-test-secret-never-render-me"
BASE_SETTINGS = {
    "baseUrl": "https://api.example.test/v1",
    "model": "example-model",
    "token": SECRET,
}


def _settings(**overrides: object) -> dict[str, object]:
    raw: dict[str, object] = dict(BASE_SETTINGS)
    raw.update(overrides)
    return raw


def _provider(patch: dict) -> dict:
    return patch["insert"][0]["config"]["providers"][DSH_PROVIDER_ID]


def test_parses_both_supported_protocols():
    openai = parse_dsh_provider_config(
        _settings(apiProtocol=PROTOCOL_OPENAI_COMPLETIONS)
    )
    anthropic = parse_dsh_provider_config(
        _settings(apiProtocol=PROTOCOL_ANTHROPIC_MESSAGES)
    )

    assert openai.api_protocol == PROTOCOL_OPENAI_COMPLETIONS
    assert anthropic.api_protocol == PROTOCOL_ANTHROPIC_MESSAGES
    assert openai.base_url == BASE_SETTINGS["baseUrl"]
    assert openai.model == BASE_SETTINGS["model"]
    assert openai.token == SECRET


def test_missing_protocol_defaults_to_anthropic_for_legacy_settings():
    config = parse_dsh_provider_config(_settings())

    assert DEFAULT_API_PROTOCOL == PROTOCOL_ANTHROPIC_MESSAGES
    assert config.api_protocol == PROTOCOL_ANTHROPIC_MESSAGES


@pytest.mark.parametrize(
    "protocol",
    ["openai-responses", "responses", "", "  ", None, 1],
)
def test_rejects_unsupported_or_blank_protocol(protocol: object):
    with pytest.raises(AgentConfigError, match="apiProtocol"):
        parse_dsh_provider_config(_settings(apiProtocol=protocol))


@pytest.mark.parametrize("key", ["baseUrl", "model", "token"])
def test_rejects_missing_required_value(key: str):
    raw = _settings()
    del raw[key]

    with pytest.raises(AgentConfigError, match=key):
        parse_dsh_provider_config(raw)


@pytest.mark.parametrize("key", ["baseUrl", "model", "token"])
def test_rejects_blank_required_value(key: str):
    with pytest.raises(AgentConfigError, match=key):
        parse_dsh_provider_config(_settings(**{key: "   "}))


@pytest.mark.parametrize(
    "base_url",
    [
        "ftp://api.example.test",
        "api.example.test/v1",
        "https:///v1",
        "https://user@api.example.test/v1",
        "https://user:password@api.example.test/v1",
    ],
)
def test_rejects_non_http_url_or_userinfo(base_url: str):
    with pytest.raises(AgentConfigError, match="baseUrl"):
        parse_dsh_provider_config(_settings(baseUrl=base_url))


@pytest.mark.parametrize(
    "base_url",
    [
        "https://api.example.test/v1\r\nX-Evil: 1",
        "https://api.example.test/v1\x00",
        "https://api.example.test/v1\x7f",
    ],
)
def test_rejects_control_characters_in_base_url(base_url: str):
    with pytest.raises(AgentConfigError, match="control"):
        parse_dsh_provider_config(_settings(baseUrl=base_url))


@pytest.mark.parametrize(
    "base_url",
    [
        "https://api.example.test/v1?api-version=2024-01-01",
        "https://api.example.test/v1#fragment",
    ],
)
def test_rejects_query_or_fragment_in_base_url(base_url: str):
    with pytest.raises(AgentConfigError, match="baseUrl"):
        parse_dsh_provider_config(_settings(baseUrl=base_url))


def test_rejects_lone_surrogate_in_model():
    with pytest.raises(AgentConfigError, match="UTF-8"):
        parse_dsh_provider_config(_settings(model="model-\ud800"))


def test_direct_dataclass_construction_is_rejected_by_builder():
    valid = dict(
        api_protocol=PROTOCOL_OPENAI_COMPLETIONS,
        base_url=BASE_SETTINGS["baseUrl"],
        model=BASE_SETTINGS["model"],
        context_window=DEFAULT_CONTEXT_WINDOW,
        max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
        token=SECRET,
    )
    bad_configs = [
        DshProviderConfig(**{**valid, "api_protocol": "openai-responses"}),
        DshProviderConfig(**{**valid, "base_url": "ftp://api.example.test"}),
        DshProviderConfig(**{**valid, "base_url": "https://api.example.test/v1?x=1"}),
        DshProviderConfig(**{**valid, "model": ""}),
        DshProviderConfig(**{**valid, "context_window": -1}),
        DshProviderConfig(**{**valid, "max_output_tokens": 10**9}),
        DshProviderConfig(**{**valid, "token": ""}),
    ]

    for config in bad_configs:
        with pytest.raises(AgentConfigError):
            build_provider_insert_patch(config)


def test_token_is_hidden_from_repr_and_str():
    config = parse_dsh_provider_config(_settings())

    assert SECRET not in repr(config)
    assert SECRET not in str(config)
    assert "token=" not in repr(config)


def test_provider_patch_uses_verified_contract_and_fixed_identifiers():
    config = parse_dsh_provider_config(
        _settings(apiProtocol=PROTOCOL_OPENAI_COMPLETIONS)
    )
    patch = build_provider_insert_patch(config)
    provider = _provider(patch)

    assert patch["insert"][0]["id"] == DSH_PLUGIN_ID == "llm-pi-ai"
    assert patch["insert"][0]["name"] == DSH_PLUGIN_NAME == "@deepseek-ai/dsh-llm-pi-ai"
    assert list(patch["insert"][0]["config"]["providers"]) == [DSH_PROVIDER_ID]
    assert DSH_PROVIDER_ID == "jupyter-aiterminal"
    assert provider["api"] == PROTOCOL_OPENAI_COMPLETIONS
    assert provider["baseURL"] == BASE_SETTINGS["baseUrl"]
    assert provider["apiKeyEnv"] == DSH_API_KEY_ENV == "JUPYTER_AITERMINAL_DSH_API_KEY"
    assert provider["models"] == [
        {
            "id": BASE_SETTINGS["model"],
            "contextWindow": DEFAULT_CONTEXT_WINDOW,
            "maxTokens": DEFAULT_MAX_OUTPUT_TOKENS,
        }
    ]
    assert provider["retryPolicy"] == {"mode": "normal", "maxRetries": 0}


def test_user_controlled_identifiers_cannot_override_fixed_patch_fields():
    config = parse_dsh_provider_config(
        _settings(providerId="attacker", apiKeyEnv="ATTACKER_API_KEY")
    )
    patch = build_provider_insert_patch(config)
    provider = _provider(patch)
    providers = patch["insert"][0]["config"]["providers"]

    assert list(providers) == [DSH_PROVIDER_ID]
    assert "attacker" not in providers
    assert provider["apiKeyEnv"] == DSH_API_KEY_ENV


def test_patch_json_never_contains_token_or_raw_newline_injection():
    injected_model = 'model"\n- id: injected\n  apiKey: not-a-real-key'
    config = parse_dsh_provider_config(_settings(model=injected_model))
    patches = build_profile_patches(config)
    rendered = render_profile_patches(patches)

    assert SECRET not in rendered
    assert "\n- id: injected" not in rendered
    loaded = json.loads(rendered)
    assert loaded == patches
    assert _provider(loaded[0])["models"][0]["id"] == injected_model


def test_output_limit_is_parameterized_and_validated():
    config = parse_dsh_provider_config(
        _settings(), context_window=32768, max_output_tokens=1024
    )
    model = _provider(build_provider_insert_patch(config))["models"][0]

    assert model["contextWindow"] == 32768
    assert model["maxTokens"] == 1024

    with pytest.raises(AgentConfigError, match="max_output_tokens"):
        parse_dsh_provider_config(
            _settings(), context_window=1024, max_output_tokens=2048
        )
    with pytest.raises(AgentConfigError, match="max_output_tokens"):
        parse_dsh_provider_config(_settings(), max_output_tokens=0)


def test_rendered_patch_stays_utf8_writable_for_non_ascii_values():
    config = parse_dsh_provider_config(_settings(model="模型-\u03c0"))
    rendered = render_profile_patches(build_profile_patches(config))

    rendered.encode("utf-8")
    loaded = json.loads(rendered)
    assert _provider(loaded[0])["models"][0]["id"] == "模型-\u03c0"


def test_static_profile_path_helper_does_not_modify_profile():
    before = DSH_STATIC_PROFILE_PATH.read_bytes()

    patches = build_profile_patches(parse_dsh_provider_config(_settings()))

    assert DSH_STATIC_PROFILE_PATH.name == "dsh_profile.yml"
    assert isinstance(DSH_STATIC_PROFILE_PATH, Path)
    assert len(patches) == 1
    assert DSH_STATIC_PROFILE_PATH.read_bytes() == before


# --- Derived budget and compaction -----------------------------------------


def test_legacy_settings_without_budget_fields_use_documented_derived_defaults():
    config = parse_dsh_provider_config(_settings())
    budget = config.budget

    assert isinstance(budget, DerivedBudget)
    assert config.context_window == budget.context_window == DEFAULT_CONTEXT_WINDOW == 8192
    assert (
        config.max_output_tokens
        == budget.max_output_tokens
        == DEFAULT_MAX_OUTPUT_TOKENS
        == 4096
    )
    assert budget.compaction_enabled is DEFAULT_COMPACTION_ENABLED is True
    assert budget.threshold_ratio == DEFAULT_COMPACTION_THRESHOLD_RATIO == 0.8
    assert budget.retain_ratio == DEFAULT_COMPACTION_RETAIN_RATIO == 0.16
    # message = C - O; headroom = floor(message * 0.25);
    # pressure = message - headroom; threshold = floor(min(C * r, pressure));
    # retain = floor(message * retainRatio); summary = min(O, headroom).
    assert budget.message_budget == 4096
    assert budget.headroom == 1024 == int(4096 * DEFAULT_HEADROOM_RATIO)
    assert budget.pressure == 3072
    assert budget.threshold == 3072
    assert budget.retain == 655
    assert budget.summary_max_tokens == 1024

    assert budget.provenance["context_window"].source == BUDGET_SOURCE_DEFAULT
    assert budget.provenance["max_output_tokens"].source == BUDGET_SOURCE_DEFAULT
    assert budget.provenance["compaction_enabled"].source == BUDGET_SOURCE_DEFAULT
    assert budget.provenance["threshold_ratio"].source == BUDGET_SOURCE_DEFAULT
    assert budget.provenance["retain_ratio"].source == BUDGET_SOURCE_DERIVED
    assert budget.provenance["headroom"].source == BUDGET_SOURCE_DERIVED
    assert budget.provenance["summary_max_tokens"].source == BUDGET_SOURCE_DERIVED
    assert budget.provenance["retain_ratio"].derived_from == ("threshold_ratio",)
    assert budget.provenance["headroom"].derived_from == (
        "context_window",
        "max_output_tokens",
    )
    assert budget.provenance["summary_max_tokens"].derived_from == (
        "max_output_tokens",
        "headroom",
    )
    for computed in ("message_budget", "pressure", "threshold", "retain"):
        assert budget.provenance[computed].source == BUDGET_SOURCE_DERIVED


def test_raw_budget_fields_are_parsed_and_marked_user_provided():
    config = parse_dsh_provider_config(
        _settings(
            contextWindow=200000,
            maxOutputTokens=32000,
            compactionEnabled=False,
            compactionThresholdRatio=0.6,
            compactionRetainRatio=0.2,
            compactionHeadroom=1000,
            compactionSummaryMaxTokens=4000,
        )
    )
    budget = config.budget

    assert config.context_window == 200000
    assert config.max_output_tokens == 32000
    assert budget.compaction_enabled is False
    assert budget.threshold_ratio == 0.6
    assert budget.retain_ratio == 0.2
    assert budget.headroom == 1000
    assert budget.summary_max_tokens == 4000
    assert budget.message_budget == 168000
    assert budget.pressure == 167000
    assert budget.threshold == 120000
    assert budget.retain == 33600
    for name in (
        "context_window",
        "max_output_tokens",
        "compaction_enabled",
        "threshold_ratio",
        "retain_ratio",
        "headroom",
        "summary_max_tokens",
    ):
        assert budget.provenance[name].source == BUDGET_SOURCE_USER


def test_small_threshold_ratio_still_derives_a_valid_retain_ratio():
    budget = parse_dsh_provider_config(
        _settings(compactionThresholdRatio=0.1)
    ).budget

    assert budget.threshold_ratio == 0.1
    assert budget.retain_ratio == 0.05
    assert budget.retain_ratio < budget.threshold_ratio
    assert budget.retain < budget.threshold
    assert budget.provenance["retain_ratio"].source == BUDGET_SOURCE_DERIVED
    assert budget.provenance["retain_ratio"].derived_from == ("threshold_ratio",)


def test_keyword_budget_overrides_stay_compatible_and_win_over_raw_fields():
    budget = parse_dsh_provider_config(
        _settings(contextWindow=100000),
        context_window=32768,
        max_output_tokens=1024,
    ).budget

    assert budget.context_window == 32768
    assert budget.max_output_tokens == 1024
    assert budget.message_budget == 31744
    assert budget.headroom == 7936
    assert budget.pressure == 23808
    assert budget.threshold == 23808
    assert budget.retain == 5079
    assert budget.summary_max_tokens == 1024
    assert budget.provenance["context_window"].source == BUDGET_SOURCE_USER
    assert budget.provenance["max_output_tokens"].source == BUDGET_SOURCE_USER


@pytest.mark.parametrize(
    "field",
    ["contextWindow", "maxOutputTokens", "compactionHeadroom", "compactionSummaryMaxTokens"],
)
def test_budget_integer_fields_reject_bool_and_non_integer(field: str):
    for bad in (True, 1.5, "16"):
        with pytest.raises(AgentConfigError, match=field):
            parse_dsh_provider_config(_settings(**{field: bad}))


@pytest.mark.parametrize("field", ["compactionThresholdRatio", "compactionRetainRatio"])
@pytest.mark.parametrize(
    "bad",
    [0, -0.1, 1.1, float("nan"), float("inf"), True, "0.5"],
)
def test_ratio_fields_reject_out_of_range_non_finite_and_bool(field: str, bad: object):
    with pytest.raises(AgentConfigError, match=field):
        parse_dsh_provider_config(_settings(**{field: bad}))


def test_compaction_enabled_must_be_a_boolean():
    with pytest.raises(AgentConfigError, match="compactionEnabled"):
        parse_dsh_provider_config(_settings(compactionEnabled=1))


@pytest.mark.parametrize("headroom", [4096, 5000])
def test_explicit_headroom_without_pressure_is_rejected_not_overridden(headroom: int):
    with pytest.raises(AgentConfigError, match="compactionHeadroom.*pressure"):
        parse_dsh_provider_config(_settings(compactionHeadroom=headroom))


def test_retain_ratio_at_or_above_threshold_ratio_is_rejected_even_when_retain_below_threshold():
    # C=8192, O=4096, H=1024 => pressure 3072, threshold 3072,
    # retain = floor(4096 * 0.5) = 2048 < 3072, yet retainRatio >= thresholdRatio
    # is a load-time invariant violation and must still be rejected.
    with pytest.raises(
        AgentConfigError,
        match=r"compactionRetainRatio.*compactionThresholdRatio",
    ):
        parse_dsh_provider_config(
            _settings(
                compactionThresholdRatio=0.5,
                compactionRetainRatio=0.5,
            )
        )


def test_retain_target_at_or_above_threshold_is_rejected():
    # pressure 96 makes threshold 96 while retain is floor(4096 * 0.16) = 655.
    with pytest.raises(AgentConfigError, match=r"retain target.*threshold"):
        parse_dsh_provider_config(
            _settings(
                compactionThresholdRatio=0.2,
                compactionRetainRatio=0.16,
                compactionHeadroom=4000,
            )
        )


def test_summary_budget_must_be_positive_and_not_exceed_max_output_tokens():
    with pytest.raises(AgentConfigError, match="compactionSummaryMaxTokens"):
        parse_dsh_provider_config(
            _settings(maxOutputTokens=1024, compactionSummaryMaxTokens=2048)
        )
    with pytest.raises(AgentConfigError, match="compactionSummaryMaxTokens"):
        parse_dsh_provider_config(_settings(compactionSummaryMaxTokens=0))


def test_legacy_non_compactable_budget_is_an_explicit_error_naming_the_pair():
    with pytest.raises(AgentConfigError, match=r"context_window.*max_output_tokens"):
        parse_dsh_provider_config(_settings(contextWindow=4096, maxOutputTokens=4096))


@pytest.mark.parametrize(
    "context,output",
    [(16, 8), (64, 32), (100, 10), (8192, 4096)],
)
def test_small_windows_derive_positive_pressure_and_retain_below_threshold(
    context: int, output: int
):
    budget = parse_dsh_provider_config(
        _settings(contextWindow=context, maxOutputTokens=output)
    ).budget

    assert budget.pressure > 0
    assert budget.retain < budget.threshold
    assert budget.summary_max_tokens <= output
    assert budget.summary_max_tokens >= 1


def test_derive_dsh_budget_is_public_and_accepts_keyword_budgets():
    budget = derive_dsh_budget(
        {"compactionRetainRatio": 0.1},
        context_window=32768,
        max_output_tokens=2048,
    )

    assert budget.message_budget == 30720
    assert budget.retain_ratio == 0.1
    assert budget.provenance["context_window"].source == BUDGET_SOURCE_USER
    assert budget.provenance["retain_ratio"].source == BUDGET_SOURCE_USER
    assert budget.provenance["threshold_ratio"].source == BUDGET_SOURCE_DEFAULT


def test_provider_patch_reads_budget_only_and_does_not_clamp():
    config = parse_dsh_provider_config(
        _settings(contextWindow=200000, maxOutputTokens=32000)
    )
    model = _provider(build_provider_insert_patch(config))["models"][0]

    assert model["contextWindow"] == config.budget.context_window == 200000
    assert model["maxTokens"] == config.budget.max_output_tokens == 32000


def test_direct_config_budget_must_agree_with_snapshot_fields():
    config = parse_dsh_provider_config(_settings())
    mismatched = replace(config, context_window=8192 + 1)

    with pytest.raises(AgentConfigError, match="budget"):
        build_provider_insert_patch(mismatched)
    without_budget = replace(config, budget=None)
    model = _provider(build_provider_insert_patch(without_budget))["models"][0]
    assert model["contextWindow"] == config.context_window
    assert model["maxTokens"] == config.max_output_tokens


def test_budget_is_immutable_and_provenance_carries_no_credentials():
    config = parse_dsh_provider_config(_settings())
    budget = config.budget

    with pytest.raises(TypeError):
        budget.provenance["headroom"] = None  # type: ignore[index]
    report = json.dumps(budget.safe_report(), sort_keys=True)
    assert SECRET not in report
    assert BASE_SETTINGS["baseUrl"] not in report
    assert DSH_API_KEY_ENV not in report
    assert report.count(BUDGET_SOURCE_DERIVED) >= 4


def test_disabled_compaction_is_still_jointly_validated():
    with pytest.raises(AgentConfigError, match="compactionHeadroom"):
        parse_dsh_provider_config(
            _settings(compactionEnabled=False, compactionHeadroom=4096)
        )


def test_budget_errors_name_fields_and_values_without_credentials():
    with pytest.raises(AgentConfigError) as excinfo:
        parse_dsh_provider_config(
            _settings(compactionThresholdRatio=0.5, compactionRetainRatio=0.9)
        )

    message = str(excinfo.value)
    assert "compactionThresholdRatio" in message
    assert "compactionRetainRatio" in message
    assert "0.5" in message
    assert SECRET not in message
    assert BASE_SETTINGS["baseUrl"] not in message


def test_models_default_to_the_single_default_model():
    config = parse_dsh_provider_config(_settings())
    assert config.models == ("example-model",)
    provider = _provider(build_provider_insert_patch(config))
    assert [entry["id"] for entry in provider["models"]] == ["example-model"]


def test_configured_models_are_selectable_and_deduplicated():
    config = parse_dsh_provider_config(
        _settings(models=["other-model", "example-model", "third-model", "other-model"])
    )
    assert config.models == ("example-model", "other-model", "third-model")
    provider = _provider(build_provider_insert_patch(config))
    assert [entry["id"] for entry in provider["models"]] == [
        "example-model",
        "other-model",
        "third-model",
    ]
    # Every selectable model shares the one authoritative budget.
    assert {entry["contextWindow"] for entry in provider["models"]} == {
        provider["models"][0]["contextWindow"]
    }
    assert {entry["maxTokens"] for entry in provider["models"]} == {
        provider["models"][0]["maxTokens"]
    }


@pytest.mark.parametrize("models", [[""], ["  "], [1], [[]], [None]])
def test_invalid_models_are_rejected(models):
    with pytest.raises(AgentConfigError):
        parse_dsh_provider_config(_settings(models=models))


def test_non_list_models_are_rejected():
    with pytest.raises(AgentConfigError):
        parse_dsh_provider_config(_settings(models="other-model"))
