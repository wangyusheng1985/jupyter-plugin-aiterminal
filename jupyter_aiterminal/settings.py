from __future__ import annotations

import json
import re
from pathlib import Path

from jupyter_core.paths import jupyter_config_dir

PLUGIN_ID = "jupyter-aiterminal"
SETTINGS_FILE = "plugin.jupyterlab-settings"
REQUIRED_KEYS = ("baseUrl", "model", "token")
REQUIRED_SETTINGS_GUIDANCE = (
    "Open Settings → AI Terminal and set Base URL, Model, and API Token."
)
ENV_KEY_MAP = {
    "baseUrl": "ANTHROPIC_BASE_URL",
    "model": "ANTHROPIC_MODEL",
    "token": "ANTHROPIC_API_KEY",
}
_COMMENT_LINE = re.compile(r"^\s*//.*$")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


class AgentConfigError(Exception):
    """Raised when Jupyter Settings cannot be used for the agent relay."""


def settings_path() -> Path:
    return (
        Path(jupyter_config_dir())
        / "lab"
        / "user-settings"
        / PLUGIN_ID
        / SETTINGS_FILE
    )


def strip_jsonc(text: str) -> str:
    without_blocks = _BLOCK_COMMENT.sub("", text)
    lines = [
        line
        for line in without_blocks.splitlines()
        if not _COMMENT_LINE.match(line)
    ]
    return "\n".join(lines)


def parse_settings(text: str) -> dict[str, str]:
    raw = json.loads(strip_jsonc(text) or "{}")
    if not isinstance(raw, dict):
        raise AgentConfigError(
            "AI Terminal settings must be a JSON object. "
            f"{REQUIRED_SETTINGS_GUIDANCE}"
        )
    values: dict[str, str] = {}
    for key in REQUIRED_KEYS:
        value = raw.get(key, "")
        values[key] = value.strip() if isinstance(value, str) else ""
    return values


def load_agent_settings(path: Path | None = None) -> dict[str, str]:
    settings_file = path or settings_path()
    if not settings_file.is_file():
        raise AgentConfigError(
            f"AI Terminal settings are missing. {REQUIRED_SETTINGS_GUIDANCE}"
        )
    try:
        values = parse_settings(settings_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AgentConfigError(
            "AI Terminal settings are not valid JSON. "
            f"{REQUIRED_SETTINGS_GUIDANCE}"
        ) from exc
    missing = [key for key in REQUIRED_KEYS if not values.get(key)]
    if missing:
        labels = ", ".join(missing)
        raise AgentConfigError(
            "AI Terminal settings are incomplete "
            f"({labels}). {REQUIRED_SETTINGS_GUIDANCE}"
        )
    return {
        ENV_KEY_MAP[key]: values[key]
        for key in REQUIRED_KEYS
    }
