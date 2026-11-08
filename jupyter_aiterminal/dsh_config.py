"""Typed Jupyter Settings to DeepSeek Harness provider configuration.

This module is deliberately pure: it parses the user-supplied settings mapping,
validates it, and returns a provider patch for the pinned ``sdk-minimal``
profile. It never reads ``~/.dsh``, never writes ``dsh_profile.yml``, never
opens a network connection, and never places the token in a patch or command
line. The host owns the controlled ``DSH_HOME``/``cwd`` runtime directory and
injects the token through the fixed ``JUPYTER_AITERMINAL_DSH_API_KEY``
subprocess environment variable named in the patch.

The verified ``0.2.1rc2`` provider contract only supports the
``openai-completions`` and ``anthropic-messages`` APIs. In particular, this
module does not advertise a Responses API.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .settings import AgentConfigError

PROTOCOL_OPENAI_COMPLETIONS = "openai-completions"
PROTOCOL_ANTHROPIC_MESSAGES = "anthropic-messages"
SUPPORTED_API_PROTOCOLS = (
    PROTOCOL_OPENAI_COMPLETIONS,
    PROTOCOL_ANTHROPIC_MESSAGES,
)
# Settings written before the protocol selector existed used an Anthropic model
# endpoint, so a missing ``apiProtocol`` keeps that compatibility behaviour.
DEFAULT_API_PROTOCOL = PROTOCOL_ANTHROPIC_MESSAGES

DSH_PLUGIN_ID = "llm-pi-ai"
DSH_PLUGIN_NAME = "@deepseek-ai/dsh-llm-pi-ai"
DSH_PROVIDER_ID = "jupyter-aiterminal"
DSH_API_KEY_ENV = "JUPYTER_AITERMINAL_DSH_API_KEY"

# The static overlay stays the authority for tool and sandbox posture. The
# generated provider row is a separate patch the host applies after it.
DSH_STATIC_PROFILE_PATH = Path(__file__).resolve().with_name("dsh_profile.yml")

# Conservative metadata defaults. These are safe values for the provider
# snapshot, not a measurement of the real model context window and not a live
# percentage of it.
DEFAULT_CONTEXT_WINDOW = 8192
DEFAULT_MAX_OUTPUT_TOKENS = 4096

_REQUIRED_SETTING_KEYS = ("baseUrl", "model", "token")


@dataclass(frozen=True)
class DshProviderConfig:
    """Validated provider snapshot derived from Jupyter Settings."""

    api_protocol: str
    base_url: str
    model: str
    context_window: int
    max_output_tokens: int
    # The token is never rendered by repr/str; it is injected only through the
    # fixed subprocess environment variable.
    token: str = field(repr=False)

    @property
    def api_key_env(self) -> str:
        """The fixed, plugin-owned environment variable the host must populate."""
        return DSH_API_KEY_ENV


def _ensure_utf8_text(name: str, value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise AgentConfigError(
            f"{name} must be valid UTF-8 text without lone surrogates."
        ) from exc
    return value


def _required_text(raw: Mapping[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        return ""
    return _ensure_utf8_text(key, value.strip())


def _validate_positive_int(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AgentConfigError(f"{name} must be a positive integer")
    return value


def _parse_api_protocol(raw: Mapping[str, Any]) -> str:
    if "apiProtocol" not in raw:
        return DEFAULT_API_PROTOCOL
    value = raw["apiProtocol"]
    if not isinstance(value, str) or not value.strip():
        raise AgentConfigError(
            "DSH apiProtocol must be one of: "
            f"{', '.join(SUPPORTED_API_PROTOCOLS)}."
        )
    protocol = value.strip()
    if protocol not in SUPPORTED_API_PROTOCOLS:
        raise AgentConfigError(
            f"Unsupported DSH apiProtocol {protocol!r}; expected one of: "
            f"{', '.join(SUPPORTED_API_PROTOCOLS)}."
        )
    return protocol


def _validate_base_url(value: str) -> str:
    text = value.strip()
    # Reject embedded C0/DEL controls before urlsplit: recent CPython versions
    # silently strip them, older ones keep them, so the patch content would
    # otherwise drift with the interpreter version.
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in text):
        raise AgentConfigError(
            "DSH baseUrl must not contain control characters."
        )
    try:
        parsed = urlsplit(text)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
    except ValueError as exc:
        raise AgentConfigError(
            "DSH baseUrl must be an absolute http(s) URL with a host "
            "and no user info."
        ) from exc
    if (
        parsed.scheme not in ("http", "https")
        or not hostname
        or username is not None
        or password is not None
    ):
        raise AgentConfigError(
            "DSH baseUrl must be an absolute http(s) URL with a host "
            "and no user info."
        )
    # The provider endpoint is a base URL; query strings and fragments would be
    # appended to every request path and are not supported downstream.
    if parsed.query:
        raise AgentConfigError("DSH baseUrl must not contain a query string.")
    if parsed.fragment:
        raise AgentConfigError("DSH baseUrl must not contain a URL fragment.")
    return text


def _validate_config_snapshot(config: DshProviderConfig) -> None:
    """Re-validate a provider snapshot so direct construction cannot bypass
    the checks performed by :func:`parse_dsh_provider_config`."""
    if not isinstance(config, DshProviderConfig):
        raise AgentConfigError(
            "DSH provider config must be a DshProviderConfig instance."
        )
    if config.api_protocol not in SUPPORTED_API_PROTOCOLS:
        raise AgentConfigError(
            f"Unsupported DSH apiProtocol {config.api_protocol!r}; expected one "
            f"of: {', '.join(SUPPORTED_API_PROTOCOLS)}."
        )
    _validate_base_url(config.base_url)
    if not isinstance(config.model, str) or not config.model.strip():
        raise AgentConfigError("DSH model must be a non-empty string.")
    _ensure_utf8_text("model", config.model)
    if not isinstance(config.token, str) or not config.token.strip():
        raise AgentConfigError("DSH token must be a non-empty string.")
    _ensure_utf8_text("token", config.token)
    _validate_positive_int("context_window", config.context_window)
    _validate_positive_int("max_output_tokens", config.max_output_tokens)
    if config.max_output_tokens > config.context_window:
        raise AgentConfigError(
            "max_output_tokens must not exceed context_window"
        )


def parse_dsh_provider_config(
    raw: Mapping[str, Any],
    *,
    context_window: int = DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
) -> DshProviderConfig:
    """Validate a raw Jupyter Settings mapping into a provider snapshot.

    ``raw`` carries ``apiProtocol`` (optional), ``baseUrl``, ``model``, and
    ``token``. The output limits are explicit arguments so a host can choose
    its snapshot values; the defaults are conservative metadata, not a measured
    context window.
    """
    if not isinstance(raw, Mapping):
        raise AgentConfigError("DSH provider settings must be a mapping.")

    protocol = _parse_api_protocol(raw)
    values = {key: _required_text(raw, key) for key in _REQUIRED_SETTING_KEYS}
    missing = [key for key in _REQUIRED_SETTING_KEYS if not values[key]]
    if missing:
        raise AgentConfigError(
            "DSH provider settings are incomplete "
            f"({', '.join(missing)}); baseUrl, model, and token are required."
        )

    base_url = _validate_base_url(values["baseUrl"])
    context_window = _validate_positive_int("context_window", context_window)
    max_output_tokens = _validate_positive_int(
        "max_output_tokens", max_output_tokens
    )
    if max_output_tokens > context_window:
        raise AgentConfigError(
            "max_output_tokens must not exceed context_window"
        )

    return DshProviderConfig(
        api_protocol=protocol,
        base_url=base_url,
        model=values["model"],
        context_window=context_window,
        max_output_tokens=max_output_tokens,
        token=values["token"],
    )


def build_provider_insert_patch(config: DshProviderConfig) -> dict[str, Any]:
    """Build the single patch row that inserts the plugin-owned provider.

    The provider key and API-key environment variable are fixed constants, not
    user input. The token itself is never part of the returned structure.
    The snapshot is re-validated here because ``DshProviderConfig`` is a public
    dataclass that callers could otherwise build without validation.
    """
    _validate_config_snapshot(config)
    return {
        "insert": [
            {
                "id": DSH_PLUGIN_ID,
                "name": DSH_PLUGIN_NAME,
                "config": {
                    "providers": {
                        DSH_PROVIDER_ID: {
                            "api": config.api_protocol,
                            "baseURL": config.base_url,
                            "apiKeyEnv": DSH_API_KEY_ENV,
                            "models": [
                                {
                                    "id": config.model,
                                    "contextWindow": config.context_window,
                                    "maxTokens": config.max_output_tokens,
                                }
                            ],
                            "retryPolicy": {
                                "mode": "normal",
                                "maxRetries": 0,
                            },
                        }
                    }
                },
            }
        ]
    }


def build_profile_patches(config: DshProviderConfig) -> list[dict[str, Any]]:
    """Return the patch sequence the host applies after the static profile.

    The static ``DSH_STATIC_PROFILE_PATH`` file is not read or modified here;
    the host supplies both its path and this sequence to the DSH client.
    """
    return [build_provider_insert_patch(config)]


def render_profile_patches(patches: Sequence[Mapping[str, Any]]) -> str:
    """Serialize patch rows as JSON, a valid YAML subset, with escaping intact."""
    return json.dumps(list(patches), ensure_ascii=True, indent=2, sort_keys=True)
