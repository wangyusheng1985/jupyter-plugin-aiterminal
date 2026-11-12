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
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
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

# Compaction defaults. The threshold ratio matches the pinned runtime default;
# the headroom and summary budget are derived from the effective budget instead
# of adopting the runtime's absolute 65536-token headroom, which cannot coexist
# with the plugin's smaller declared context windows.
DEFAULT_COMPACTION_ENABLED = True
DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8
DEFAULT_COMPACTION_RETAIN_RATIO = 0.16
# Default headroom as a fraction of the message budget. A quarter keeps the
# pressure value strictly positive for every positive message budget.
DEFAULT_HEADROOM_RATIO = 0.25

# Value provenance recorded for every budget field. ``inherited`` is reserved
# for a value a caller can actually identify as inherited; this module never
# fabricates it.
BUDGET_SOURCE_USER = "user"
BUDGET_SOURCE_DEFAULT = "default"
BUDGET_SOURCE_DERIVED = "derived"
BUDGET_SOURCE_INHERITED = "inherited"
BUDGET_SOURCES = (
    BUDGET_SOURCE_USER,
    BUDGET_SOURCE_DEFAULT,
    BUDGET_SOURCE_DERIVED,
    BUDGET_SOURCE_INHERITED,
)

# Budget/compaction formula reference: deepseek-harness tag
# ``dsh-v0.2.1-rc.2``, ``packages/compaction/compaction-basic/src/config.ts``
# (the pinned remote runtime ``deepseek-harness-runtime-bin`` 0.2.1rc2 embeds
# the same file byte-for-byte). Lines 172-198 derive
# ``messageBudget = C - O``, ``pressure = C - O - H``,
# ``threshold = floor(min(C * thresholdRatio, pressure))`` and
# ``retain = floor((C - O) * retainRatio)``; lines 230-241 enforce the
# load-time invariant ``retainRatio < thresholdRatio``. Ratios are in
# ``(0, 1]`` and ``headroomTokens >= 0``. These are the only formulas this
# module uses; do not add a second arithmetic path elsewhere.

_REQUIRED_SETTING_KEYS = ("baseUrl", "model", "token")


@dataclass(frozen=True)
class FieldProvenance:
    """Where one budget field's value came from.

    ``derived_from`` names the input fields a derived value was computed from.
    It carries field names only, never values, so provenance can be displayed
    without leaking credentials.
    """

    source: str
    derived_from: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.source not in BUDGET_SOURCES:
            raise AgentConfigError(
                "budget provenance source must be one of: "
                f"{', '.join(BUDGET_SOURCES)}"
            )

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "derivedFrom": list(self.derived_from),
        }


@dataclass(frozen=True)
class DerivedBudget:
    """The single authoritative budget and compaction snapshot.

    ``context_window`` (C), ``max_output_tokens`` (O), and the compaction
    inputs are resolved from settings; ``message_budget``, ``pressure``,
    ``threshold``, and ``retain`` are computed here exactly once with the
    pinned runtime formulas documented above. Patch builders read these values
    and never recompute or clamp them.

    Construction validates every runtime precondition and load-time invariant;
    an unusable combination raises :class:`AgentConfigError` naming the
    offending fields and computed values.
    """

    context_window: int
    max_output_tokens: int
    compaction_enabled: bool
    threshold_ratio: float
    headroom: int
    retain_ratio: float
    summary_max_tokens: int
    provenance: Mapping[str, FieldProvenance] = field(default_factory=dict)

    # Computed by ``__post_init__`` from the fields above.
    message_budget: int = field(init=False)
    pressure: int = field(init=False)
    threshold: int = field(init=False)
    retain: int = field(init=False)

    def __post_init__(self) -> None:
        message_budget, pressure, threshold, retain = _budget_arithmetic(
            context_window=self.context_window,
            max_output_tokens=self.max_output_tokens,
            threshold_ratio=self.threshold_ratio,
            headroom=self.headroom,
            retain_ratio=self.retain_ratio,
            summary_max_tokens=self.summary_max_tokens,
            compaction_enabled=self.compaction_enabled,
        )
        object.__setattr__(self, "message_budget", message_budget)
        object.__setattr__(self, "pressure", pressure)
        object.__setattr__(self, "threshold", threshold)
        object.__setattr__(self, "retain", retain)
        provenance = dict(self.provenance)
        provenance.setdefault(
            "message_budget",
            FieldProvenance(
                BUDGET_SOURCE_DERIVED,
                ("context_window", "max_output_tokens"),
            ),
        )
        provenance.setdefault(
            "pressure",
            FieldProvenance(
                BUDGET_SOURCE_DERIVED,
                ("message_budget", "headroom"),
            ),
        )
        provenance.setdefault(
            "threshold",
            FieldProvenance(
                BUDGET_SOURCE_DERIVED,
                ("context_window", "threshold_ratio", "pressure"),
            ),
        )
        provenance.setdefault(
            "retain",
            FieldProvenance(
                BUDGET_SOURCE_DERIVED,
                ("message_budget", "retain_ratio"),
            ),
        )
        object.__setattr__(self, "provenance", MappingProxyType(provenance))

    def safe_report(self) -> dict[str, Any]:
        """Return a presentation-safe snapshot without credentials or URLs."""
        return {
            "contextWindow": self.context_window,
            "maxOutputTokens": self.max_output_tokens,
            "compaction": {
                "enabled": self.compaction_enabled,
                "thresholdRatio": self.threshold_ratio,
                "headroom": self.headroom,
                "retainRatio": self.retain_ratio,
                "summaryMaxTokens": self.summary_max_tokens,
            },
            "computed": {
                "messageBudget": self.message_budget,
                "pressure": self.pressure,
                "threshold": self.threshold,
                "retain": self.retain,
            },
            "provenance": {
                name: entry.as_dict()
                for name, entry in self.provenance.items()
            },
        }


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
    # The single authoritative budget. Parsed configs always carry one; direct
    # constructions may omit it, in which case the builder derives it from
    # ``context_window``/``max_output_tokens`` through the same function. The
    # two context fields mirror this budget for existing callers and are
    # checked for agreement so there is no second authority.
    budget: DerivedBudget | None = None
    # Selectable model ids for the same provider. ``model`` is always first and
    # is the default; an empty tuple keeps the single-model behavior.
    models: tuple[str, ...] = ()

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


def _validate_non_negative_int(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AgentConfigError(f"{name} must be a non-negative integer")
    return value


def _validate_ratio(name: str, value: object) -> float:
    """Validate one of the runtime's ``(0, 1]`` ratio inputs."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AgentConfigError(f"{name} must be a number in (0, 1]")
    number = float(value)
    if not math.isfinite(number) or number <= 0 or number > 1:
        raise AgentConfigError(
            f"{name} must be a finite number in (0, 1], got {number!r}"
        )
    return number


def _validate_bool(name: str, value: object) -> bool:
    if not isinstance(value, bool):
        raise AgentConfigError(f"{name} must be a boolean")
    return value


def _budget_arithmetic(
    *,
    context_window: object,
    max_output_tokens: object,
    threshold_ratio: object,
    headroom: object,
    retain_ratio: object,
    summary_max_tokens: object,
    compaction_enabled: object,
) -> tuple[int, int, int, int]:
    """Validate the budget/compaction combination and compute its values.

    Implements the pinned runtime formulas and load-time invariants exactly:
    ``message_budget = C - O``, ``pressure = message_budget - headroom``,
    ``threshold = floor(min(C * threshold_ratio, pressure))``, and
    ``retain = floor(message_budget * retain_ratio)``. Every rejected case is
    an :class:`AgentConfigError` naming the offending fields and values.
    """
    _validate_bool("compactionEnabled", compaction_enabled)
    context_window = _validate_positive_int("context_window", context_window)
    max_output_tokens = _validate_positive_int(
        "max_output_tokens", max_output_tokens
    )
    if max_output_tokens > context_window:
        raise AgentConfigError(
            f"max_output_tokens (O={max_output_tokens}) must not exceed context_window "
            f"(C={context_window})"
        )
    message_budget = context_window - max_output_tokens
    if message_budget <= 0:
        raise AgentConfigError(
            f"message budget must be positive: context_window (C={context_window}) minus "
            f"max_output_tokens (O={max_output_tokens}) equals {message_budget}"
        )

    threshold_ratio = _validate_ratio(
        "compactionThresholdRatio", threshold_ratio
    )
    retain_ratio = _validate_ratio("compactionRetainRatio", retain_ratio)
    if retain_ratio >= threshold_ratio:
        raise AgentConfigError(
            f"compactionRetainRatio ({retain_ratio}) must be less than "
            f"compactionThresholdRatio ({threshold_ratio})"
        )
    headroom = _validate_non_negative_int("compactionHeadroom", headroom)
    pressure = message_budget - headroom
    if pressure <= 0:
        raise AgentConfigError(
            f"compactionHeadroom (H={headroom}) leaves no room for compaction to "
            f"trigger: pressure = message budget ({message_budget}) - headroom ({headroom}) = {pressure}"
            " must be positive"
        )
    threshold = math.floor(min(context_window * threshold_ratio, pressure))
    retain = math.floor(message_budget * retain_ratio)
    if retain >= threshold:
        raise AgentConfigError(
            f"retain target (floor(message budget {message_budget} * "
            f"compactionRetainRatio {retain_ratio}) = {retain}) must be less than threshold "
            f"(floor(min(context window {context_window} * compactionThresholdRatio {threshold_ratio}, "
            f"pressure {pressure}) = {threshold})"
        )
    summary_max_tokens = _validate_positive_int(
        "compactionSummaryMaxTokens", summary_max_tokens
    )
    if summary_max_tokens > max_output_tokens:
        raise AgentConfigError(
            f"compactionSummaryMaxTokens ({summary_max_tokens}) must not exceed "
            f"max_output_tokens (O={max_output_tokens})"
        )
    return message_budget, pressure, threshold, retain


def derive_dsh_budget(
    raw: Mapping[str, Any] | None = None,
    *,
    context_window: int | None = None,
    max_output_tokens: int | None = None,
) -> DerivedBudget:
    """Derive the one authoritative budget/compaction snapshot from settings.

    Field resolution, in order of precedence:

    * ``context_window`` / ``max_output_tokens`` keyword arguments, when not
      ``None``, are explicit host-supplied values recorded as ``user`` and win
      over ``raw``.
    * Otherwise the ``contextWindow`` / ``maxOutputTokens`` setting is used and
      recorded as ``user``; when absent the documented constants
      ``DEFAULT_CONTEXT_WINDOW`` (8192) and ``DEFAULT_MAX_OUTPUT_TOKENS``
      (4096) apply and are recorded as ``default``.
    * ``compactionEnabled`` defaults to ``True`` (recorded ``default``).
    * ``compactionThresholdRatio`` defaults to ``0.8`` (``default``).
    * ``compactionRetainRatio`` defaults to
      ``min(0.16, threshold_ratio / 2)`` (``derived`` from the threshold
      ratio), so a user-supplied small threshold such as ``0.1`` still yields
      a valid default below it.
    * ``compactionHeadroom`` defaults to
      ``floor(message_budget * 0.25)`` (``derived`` from both budgets), which
      keeps ``pressure`` positive for every positive message budget.
    * ``compactionSummaryMaxTokens`` defaults to
      ``max(1, min(max_output_tokens, headroom))`` (``derived``); it therefore
      never exceeds the effective maximum output tokens.

    Every default is derived from the effective budget rather than adopting
    the runtime's absolute 65536-token headroom, so the plugin's smaller
    declared windows stay usable. Explicit user values are never silently
    replaced: an invalid explicit combination raises :class:`AgentConfigError`
    naming the conflicting fields and values. A legacy settings mapping with
    no compaction fields still parses because the derived defaults are valid
    whenever ``context_window > max_output_tokens > 0``; when even that is
    impossible the error names the conflicting budget pair.
    """
    raw = raw if raw is not None else {}
    if not isinstance(raw, Mapping):
        raise AgentConfigError("DSH provider settings must be a mapping.")
    provenance: dict[str, FieldProvenance] = {}

    if context_window is not None:
        resolved_context = _validate_positive_int(
            "context_window", context_window
        )
        provenance["context_window"] = FieldProvenance(BUDGET_SOURCE_USER)
    elif "contextWindow" in raw:
        resolved_context = _validate_positive_int(
            "contextWindow", raw["contextWindow"]
        )
        provenance["context_window"] = FieldProvenance(BUDGET_SOURCE_USER)
    else:
        resolved_context = DEFAULT_CONTEXT_WINDOW
        provenance["context_window"] = FieldProvenance(BUDGET_SOURCE_DEFAULT)

    if max_output_tokens is not None:
        resolved_output = _validate_positive_int(
            "max_output_tokens", max_output_tokens
        )
        provenance["max_output_tokens"] = FieldProvenance(BUDGET_SOURCE_USER)
    elif "maxOutputTokens" in raw:
        resolved_output = _validate_positive_int(
            "maxOutputTokens", raw["maxOutputTokens"]
        )
        provenance["max_output_tokens"] = FieldProvenance(BUDGET_SOURCE_USER)
    else:
        resolved_output = DEFAULT_MAX_OUTPUT_TOKENS
        provenance["max_output_tokens"] = FieldProvenance(
            BUDGET_SOURCE_DEFAULT
        )

    if "compactionEnabled" in raw:
        compaction_enabled = _validate_bool(
            "compactionEnabled", raw["compactionEnabled"]
        )
        provenance["compaction_enabled"] = FieldProvenance(BUDGET_SOURCE_USER)
    else:
        compaction_enabled = DEFAULT_COMPACTION_ENABLED
        provenance["compaction_enabled"] = FieldProvenance(
            BUDGET_SOURCE_DEFAULT
        )

    if "compactionThresholdRatio" in raw:
        threshold_ratio = _validate_ratio(
            "compactionThresholdRatio", raw["compactionThresholdRatio"]
        )
        provenance["threshold_ratio"] = FieldProvenance(BUDGET_SOURCE_USER)
    else:
        threshold_ratio = DEFAULT_COMPACTION_THRESHOLD_RATIO
        provenance["threshold_ratio"] = FieldProvenance(
            BUDGET_SOURCE_DEFAULT
        )

    if "compactionRetainRatio" in raw:
        retain_ratio = _validate_ratio(
            "compactionRetainRatio", raw["compactionRetainRatio"]
        )
        provenance["retain_ratio"] = FieldProvenance(BUDGET_SOURCE_USER)
    else:
        retain_ratio = min(
            DEFAULT_COMPACTION_RETAIN_RATIO, threshold_ratio / 2
        )
        provenance["retain_ratio"] = FieldProvenance(
            BUDGET_SOURCE_DERIVED, ("threshold_ratio",)
        )

    if "compactionHeadroom" in raw:
        headroom = _validate_non_negative_int(
            "compactionHeadroom", raw["compactionHeadroom"]
        )
        provenance["headroom"] = FieldProvenance(BUDGET_SOURCE_USER)
    else:
        message_budget = max(0, resolved_context - resolved_output)
        headroom = math.floor(message_budget * DEFAULT_HEADROOM_RATIO)
        provenance["headroom"] = FieldProvenance(
            BUDGET_SOURCE_DERIVED, ("context_window", "max_output_tokens")
        )

    if "compactionSummaryMaxTokens" in raw:
        summary_max_tokens = _validate_positive_int(
            "compactionSummaryMaxTokens", raw["compactionSummaryMaxTokens"]
        )
        provenance["summary_max_tokens"] = FieldProvenance(
            BUDGET_SOURCE_USER
        )
    else:
        summary_max_tokens = max(1, min(resolved_output, headroom))
        provenance["summary_max_tokens"] = FieldProvenance(
            BUDGET_SOURCE_DERIVED, ("max_output_tokens", "headroom")
        )

    return DerivedBudget(
        context_window=resolved_context,
        max_output_tokens=resolved_output,
        compaction_enabled=compaction_enabled,
        threshold_ratio=threshold_ratio,
        headroom=headroom,
        retain_ratio=retain_ratio,
        summary_max_tokens=summary_max_tokens,
        provenance=provenance,
    )


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


def _config_budget(config: DshProviderConfig) -> DerivedBudget:
    """Return the snapshot's budget, deriving it for direct constructions.

    Parsed configs always carry ``budget``. A config built directly may omit
    it; the builder then derives it from ``context_window``/``max_output_tokens``
    through :func:`derive_dsh_budget`, the same single arithmetic path. When
    both are present they must agree so no second authority can drift.
    """
    if config.budget is not None:
        if not isinstance(config.budget, DerivedBudget):
            raise AgentConfigError(
                "DshProviderConfig budget must be a DerivedBudget instance."
            )
        if (
            config.budget.context_window != config.context_window
            or config.budget.max_output_tokens != config.max_output_tokens
        ):
            raise AgentConfigError(
                "DshProviderConfig budget context_window/max_output_tokens "
                "must match the snapshot context_window/max_output_tokens."
            )
        return config.budget
    return derive_dsh_budget(
        {},
        context_window=config.context_window,
        max_output_tokens=config.max_output_tokens,
    )


def _validate_config_snapshot(config: DshProviderConfig) -> DerivedBudget:
    """Re-validate a provider snapshot so direct construction cannot bypass
    the checks performed by :func:`parse_dsh_provider_config`.

    Returns the authoritative :class:`DerivedBudget` the builders must use.
    """
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
    if config.models:
        if not isinstance(config.models, tuple):
            raise AgentConfigError("DSH models must be a tuple of model ids.")
        if config.model not in config.models:
            raise AgentConfigError(
                "DSH models must include the default model id."
            )
        for entry in config.models:
            if not isinstance(entry, str) or not entry.strip():
                raise AgentConfigError(
                    "Each entry in DSH models must be a non-empty string."
                )
            _ensure_utf8_text("models", entry)
    if not isinstance(config.token, str) or not config.token.strip():
        raise AgentConfigError("DSH token must be a non-empty string.")
    _ensure_utf8_text("token", config.token)
    return _config_budget(config)


def parse_dsh_provider_config(
    raw: Mapping[str, Any],
    *,
    context_window: int | None = None,
    max_output_tokens: int | None = None,
) -> DshProviderConfig:
    """Validate a raw Jupyter Settings mapping into a provider snapshot.

    ``raw`` carries ``apiProtocol`` (optional), ``baseUrl``, ``model``,
    ``token``, and the optional budget/compaction keys ``contextWindow``,
    ``maxOutputTokens``, ``compactionEnabled``, ``compactionThresholdRatio``,
    ``compactionHeadroom``, ``compactionRetainRatio``, and
    ``compactionSummaryMaxTokens``. Absent values use the documented derived
    defaults in :func:`derive_dsh_budget`.

    The ``context_window``/``max_output_tokens`` keyword arguments remain for
    backward-compatible host snapshots. When supplied they are explicit
    ``user`` values and win over ``raw``; when left as ``None`` the raw setting
    or its documented default applies. The resulting :class:`DerivedBudget` is
    the only authority for the emitted provider patch.
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
    budget = derive_dsh_budget(
        raw,
        context_window=context_window,
        max_output_tokens=max_output_tokens,
    )
    models = _parse_models(raw.get("models"), default=values["model"])

    return DshProviderConfig(
        api_protocol=protocol,
        base_url=base_url,
        model=values["model"],
        context_window=budget.context_window,
        max_output_tokens=budget.max_output_tokens,
        token=values["token"],
        budget=budget,
        models=models,
    )


def _parse_models(value: Any, *, default: str) -> tuple[str, ...]:
    """Parse the optional multi-model list; ``model`` is always included first.

    An absent or empty list keeps the historical single-model behavior. Every
    entry must be a non-empty string; duplicates are dropped while preserving
    order so the runtime never sees two selectable options with the same id.
    """
    entries: list[str] = [default]
    if value is not None:
        if not isinstance(value, (list, tuple)):
            raise AgentConfigError("models must be an array of model ids.")
        for item in value:
            if not isinstance(item, str):
                raise AgentConfigError("Each entry in models must be a string.")
            text = item.strip()
            if not text:
                raise AgentConfigError("Each entry in models must be non-empty.")
            _ensure_utf8_text("models", text)
            if text != default:
                entries.append(text)
    seen: set[str] = set()
    unique: list[str] = []
    for entry in entries:
        if entry in seen:
            continue
        seen.add(entry)
        unique.append(entry)
    return tuple(unique)


def model_ids(config: DshProviderConfig) -> tuple[str, ...]:
    """Configured selectable model ids, falling back to the single default."""
    configured = getattr(config, "models", ())
    return tuple(configured) if configured else (config.model,)


def build_provider_insert_patch(config: DshProviderConfig) -> dict[str, Any]:
    """Build the single patch row that inserts the plugin-owned provider.

    The provider key and API-key environment variable are fixed constants, not
    user input. The token itself is never part of the returned structure.
    The snapshot is re-validated here because ``DshProviderConfig`` is a public
    dataclass that callers could otherwise build without validation.

    ``contextWindow``/``maxTokens`` come only from the derived budget; this
    function never recomputes or clamps them.
    """
    budget = _validate_config_snapshot(config)
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
                                    "id": model_id,
                                    "contextWindow": budget.context_window,
                                    "maxTokens": budget.max_output_tokens,
                                }
                                for model_id in model_ids(config)
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
