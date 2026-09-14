from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

FORBIDDEN_REASON = "apt/yum and curl|sh installs are not allowed"

_FORBIDDEN = re.compile(
    r"(?:^|[;&|]\s*|\s)(?:sudo\s+)?(?:apt-get|apt|yum|dnf)\b"
    r"|curl\s+[^|\n]*\|\s*(?:ba)?sh"
    r"|wget\s+[^|\n]*\|\s*(?:ba)?sh",
    re.IGNORECASE,
)
_LEADING_ENV = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+")


def pip_argv() -> list[str]:
    return [sys.executable, "-m", "pip"]


def install_map() -> dict[str, list[str]]:
    pip = pip_argv()
    mapping = {
        "rg": [*pip, "install", "ripgrep"],
        "ripgrep": [*pip, "install", "ripgrep"],
        "jq": [*pip, "install", "jq"],
        "fd": [*pip, "install", "fd-find"],
        "fd-find": [*pip, "install", "fd-find"],
    }
    npm = shutil.which("npm")
    if npm:
        mapping["typescript"] = [npm, "install", "-g", "typescript"]
    return mapping


def first_binary(command: str) -> str | None:
    stripped = command.strip()
    stripped = _LEADING_ENV.sub("", stripped)
    if stripped.startswith("sudo "):
        stripped = stripped[5:].lstrip()
    token = stripped.split()[0] if stripped.split() else ""
    if not token:
        return None
    return Path(token).name


def forbidden_reason(command: str) -> str | None:
    if _FORBIDDEN.search(command):
        return FORBIDDEN_REASON
    return None


def missing_binary(command: str, which=shutil.which) -> str | None:
    name = first_binary(command)
    if name and which(name) is None:
        return name
    return None


def install_argv(binary: str) -> list[str] | None:
    return install_map().get(binary)
