"""Pure ACP-profile patch and subprocess environment for the DSH runtime.

This module composes the ``--patch`` overlay the host applies on top of the
shipped ``acp`` profile, plus the complete child environment for
:class:`~jupyter_aiterminal.dsh_acp_transport.DshAcpTransport`. It deliberately
does not write files, create directories, read ``~/.dsh``, or touch
``os.environ``: the host owns the controlled session directory and passes the
rendered patch text to disk.

Every patched row and field below was confirmed against the real
``0.2.1rc2`` runtime with::

    <runtime> --profile acp --dump-config

The profile already contains these rows, so the overlay patches them by ``id``
and never inserts a plugin row. New rows are not invented; in particular there
are no ``browser``/``computer``/``office``/``schedule`` rows in the shipped ACP
profile, and the PTY backend rows are left alone.

MCP tool surfaces are not controlled by this overlay. Disabling the
``mcp-resources`` row only removes that package's three resource-reading
tools; the ACP server mounts any client-supplied ``session/new.mcpServers``
entries directly through ``dsh-mcp-client`` in the agent scope. A host must
therefore build ``session/new`` with :func:`build_acp_session_params`, which
rejects a non-empty ``mcp_servers`` list and pins the session cwd to the
controlled workspace.

``tool-bash`` is deliberately not patched: the shipped base row keeps its
``process.platform === 'win32'`` gate. This first ACP version targets Linux
and macOS only; the Windows bash path is unverified.

The provider key and API-key environment variable are fixed plugin constants,
not user input. The token is never rendered into the patch; the host injects it
only through ``JUPYTER_AITERMINAL_DSH_API_KEY`` in the isolated child
environment.
"""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .dsh_config import (
    DSH_API_KEY_ENV,
    DSH_PLUGIN_ID,
    DSH_PROVIDER_ID,
    DerivedBudget,
    DshProviderConfig,
    _validate_config_snapshot,
)
from .settings import AgentConfigError

ACP_PROFILE = "acp"

# Rows that exist in the shipped ACP profile. Only these ids are patched; the
# module never inserts a row, so a typo cannot create a new plugin.
ACP_ROW_AGENT_DEFAULT_MODEL = "agent-default-model"
ACP_ROW_ACP = "acp"
ACP_ROW_APPROVAL = "approval"
ACP_ROW_SANDBOX_POLICY = "sandbox-policy"
ACP_ROW_TOOL_FS = "tool-fs"
# ``compaction-basic`` is already enabled in the shipped profile; the overlay
# patches its config in place. ``token-meter`` is likewise already enabled and
# is deliberately left without a config: the pinned runtime rejects a config
# patch against its empty schema.
ACP_ROW_COMPACTION = "compaction-basic"

# Tool/service rows kept out of the ACP agent surface. The ACP profile is meant
# for basic file plus shell work; web, jobs, subagents, workflows, skills,
# goals, todos, and working-directory stay disabled. Disabling ``mcp-resources``
# removes only that package's three resource-reading tools; it does NOT close
# the MCP tool surface, which the ACP server mounts from
# ``session/new.mcpServers`` via ``dsh-mcp-client``. The host closes that path
# with :func:`build_acp_session_params`.
ACP_DISABLED_ROW_IDS = (
    "tool-web",
    "web",
    "web-search-deepseek",
    "web-deepseek-api",
    "web-fetch-http",
    "mcp-resources",
    "tool-jobs",
    "tool-subagent",
    "tool-subagent-fork",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-workflow",
    "tool-todo",
    "tool-goal",
    "tool-skill",
    "tool-working-directory",
)

# Host values copied into the child environment. Everything else is dropped,
# and the host's HOME/DSH_HOME/token values are replaced by the controlled ones.
PASSTHROUGH_ENV_KEYS = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TZ",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
)


def _absolute_root(name: str, value: str | Path) -> Path:
    if not isinstance(value, (str, Path)):
        raise AgentConfigError(f"{name} must be a path")
    path = Path(value)
    if not path.is_absolute():
        raise AgentConfigError(f"{name} must be an absolute path, got {path}")
    return path


def validate_controlled_root(path: str | Path, *, name: str = "root") -> Path:
    """Validate a host-owned HOME/DSH_HOME path without creating anything.

    The host creates the per-workspace directory with ``0700`` on first use.
    This pure check rejects relative paths, any symlink on the original path or
    its parent chain, and an existing target that is not a directory or is not
    owned by the current user. Ancestor ownership is not checked: ``/``,
    ``/tmp``, and similar system directories legitimately belong to root. It
    intentionally does not mkdir, chmod, or resolve symlinks.
    """
    root = _absolute_root(name, path)
    canonical = Path(os.path.abspath(root))
    # Walk the original path components with lstat so a symlinked parent chain
    # (including one hidden behind ``..``) cannot redirect HOME/DSH_HOME to an
    # attacker-controlled directory.
    for component in (root, *root.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise AgentConfigError(f"cannot inspect {name} path {component}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode):
            raise AgentConfigError(f"{name} must not be a symlink: {component}")
    try:
        target = canonical.lstat()
    except FileNotFoundError:
        target = None
    except OSError as exc:
        raise AgentConfigError(f"cannot inspect {name} path {canonical}: {exc}") from exc
    if target is not None:
        if not stat.S_ISDIR(target.st_mode):
            raise AgentConfigError(
                f"{name} must be a directory when it exists: {canonical}"
            )
        if target.st_uid != os.geteuid():
            raise AgentConfigError(
                f"{name} must be owned by the current user: {canonical}"
            )
    return canonical


def build_acp_session_params(
    workspace_root: str | Path,
    mcp_servers: Sequence[Any] = (),
) -> dict[str, Any]:
    """Build the fixed ``session/new`` params the host must send.

    The ACP server mounts ``mcpServers`` directly in the agent scope, bypassing
    ``mcp-resources``, so this builder rejects any non-empty list. ``cwd`` is
    the same absolute controlled workspace passed to the runtime and patch.
    """
    root = _absolute_root("workspace_root", workspace_root)
    if not isinstance(mcp_servers, Sequence) or isinstance(mcp_servers, (str, bytes)):
        raise AgentConfigError("mcp_servers must be a sequence")
    if len(mcp_servers) != 0:
        raise AgentConfigError("ACP sessions must not declare MCP servers")
    return {"cwd": os.fspath(Path(os.path.abspath(root))), "mcpServers": []}


def _provider_row(config: DshProviderConfig, budget: DerivedBudget) -> dict[str, Any]:
    # C (context window) and O (maximum output tokens) come from the one
    # derived budget; this overlay never recomputes or clamps them. Every
    # configured model id is selectable through the runtime's model option.
    configured = getattr(config, "models", ()) or (config.model,)
    return {
        "id": DSH_PLUGIN_ID,
        "config": {
            "providers": {
                DSH_PROVIDER_ID: {
                    "api": config.api_protocol,
                    "baseURL": config.base_url,
                    "apiKeyEnv": DSH_API_KEY_ENV,
                    "models": [
                        {
                            "id": model_id,
                            "name": model_id,
                            "contextWindow": budget.context_window,
                            "maxTokens": budget.max_output_tokens,
                        }
                        for model_id in configured
                    ],
                    "defaultMaxTokens": budget.max_output_tokens,
                    "retryPolicy": {
                        "mode": "normal",
                        "maxRetries": 0,
                    },
                }
            }
        },
    }


def _compaction_row(budget: DerivedBudget) -> dict[str, Any]:
    # Field names match the pinned runtime's ``compaction-basic`` schema. This
    # is a patch of an existing id, never an insert.
    return {
        "id": ACP_ROW_COMPACTION,
        "config": {
            "auto": budget.compaction_enabled,
            "thresholdRatio": budget.threshold_ratio,
            "headroomTokens": budget.headroom,
            "retainRatio": budget.retain_ratio,
            "maxTokens": budget.summary_max_tokens,
        },
    }


def build_acp_profile_patches(
    config: DshProviderConfig,
    *,
    workspace_root: str | Path,
) -> list[dict[str, Any]]:
    """Build the ordered patch list applied after the shipped ``acp`` profile.

    ``workspace_root`` must be the same absolute directory the host passes as
    the runtime cwd and to :func:`build_acp_session_params`. ``sandbox-policy``
    uses that path only as the fallback for agents without a session cwd; the
    real ACP write boundary is the client-supplied ``session/new.cwd``, which
    the host pins through :func:`build_acp_session_params`.
    """
    budget = _validate_config_snapshot(config)
    root = _absolute_root("workspace_root", workspace_root)

    rows: list[dict[str, Any]] = [
        _provider_row(config, budget),
        {
            "id": ACP_ROW_AGENT_DEFAULT_MODEL,
            "config": {"provider": DSH_PROVIDER_ID, "model": config.model},
        },
        {
            "id": ACP_ROW_ACP,
            "config": {"provider": DSH_PROVIDER_ID, "model": config.model},
        },
        {
            "id": ACP_ROW_APPROVAL,
            "config": {"policy": "ask"},
        },
        {
            "id": ACP_ROW_SANDBOX_POLICY,
            "config": {"mode": "workspace-write", "workspaceRoot": str(root)},
        },
        {
            "id": ACP_ROW_TOOL_FS,
            "config": {
                "read": True,
                "readImage": True,
                "write": True,
                "edit": True,
                "applyPatch": False,
            },
        },
        _compaction_row(budget),
    ]
    rows.extend({"id": row_id, "disabled": True} for row_id in ACP_DISABLED_ROW_IDS)
    return rows


def render_acp_profile_patch(
    config: DshProviderConfig,
    *,
    workspace_root: str | Path,
) -> str:
    """Serialize the overlay as JSON, which is a valid YAML subset.

    Escaping is left to :func:`json.dumps`, so a model name or URL containing
    newlines cannot create an extra YAML row.
    """
    return json.dumps(
        build_acp_profile_patches(config, workspace_root=workspace_root),
        ensure_ascii=True,
        indent=2,
    )


def _copy_host_value(host_env: Mapping[str, str], key: str) -> str | None:
    value = host_env.get(key)
    if not isinstance(value, str) or not value:
        return None
    if "\x00" in value:
        raise AgentConfigError(f"host environment value for {key} must not contain NUL")
    return value


def build_acp_subprocess_env(
    host_env: Mapping[str, str],
    *,
    home: str | Path,
    dsh_home: str | Path,
    config: DshProviderConfig,
) -> dict[str, str]:
    """Build the complete replacement env for one ACP runtime subprocess.

    ``host_env`` is read-only. Only :data:`PASSTHROUGH_ENV_KEYS` are copied,
    and empty host values are skipped rather than merged as empty strings.
    ``HOME``/``DSH_HOME`` are replaced with the validated host-owned roots, and
    the token is injected only through the fixed ``DSH_API_KEY_ENV`` key. No
    host ``DSH_*``, cloud, or custom secret variables are inherited. The
    returned mapping is the full child environment: callers must not merge it
    with ``os.environ``.
    """
    if not isinstance(host_env, Mapping):
        raise AgentConfigError("host_env must be a mapping")
    _validate_config_snapshot(config)

    controlled_home = validate_controlled_root(home, name="home")
    controlled_dsh_home = validate_controlled_root(dsh_home, name="dsh_home")
    if os.path.abspath(controlled_home) == os.path.abspath(controlled_dsh_home):
        raise AgentConfigError("home and dsh_home must be different directories")

    child_env: dict[str, str] = {}
    for key in PASSTHROUGH_ENV_KEYS:
        value = _copy_host_value(host_env, key)
        if value is not None:
            child_env[key] = value

    child_env["HOME"] = os.fspath(controlled_home)
    child_env["DSH_HOME"] = os.fspath(controlled_dsh_home)
    child_env[DSH_API_KEY_ENV] = config.token
    return child_env
