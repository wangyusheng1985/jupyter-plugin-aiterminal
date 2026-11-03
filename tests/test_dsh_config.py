"""Unit contract for the pure DSH provider configuration builder."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jupyter_aiterminal.dsh_config import (
    DEFAULT_API_PROTOCOL,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_OUTPUT_TOKENS,
    DSH_API_KEY_ENV,
    DSH_PLUGIN_ID,
    DSH_PLUGIN_NAME,
    DSH_PROVIDER_ID,
    DSH_STATIC_PROFILE_PATH,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_OPENAI_COMPLETIONS,
    DshProviderConfig,
    build_profile_patches,
    build_provider_insert_patch,
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


def test_raw_context_and_output_overrides_take_precedence_and_validate():
    config = parse_dsh_provider_config(
        _settings(contextWindow=64000, maxOutputTokens=2048),
        context_window=32768,
        max_output_tokens=1024,
    )

    assert config.context_window == 64000
    assert config.max_output_tokens == 2048

    with pytest.raises(AgentConfigError, match="contextWindow"):
        parse_dsh_provider_config(_settings(contextWindow=0))
    with pytest.raises(AgentConfigError, match="maxOutputTokens"):
        parse_dsh_provider_config(_settings(maxOutputTokens="lots"))


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
