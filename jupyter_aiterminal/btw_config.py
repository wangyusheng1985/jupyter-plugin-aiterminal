"""Tool-less profile overlay for the BTW side-chat runtime.

The BTW runtime is a *separate* DSH process from the main agent runtime. It must
never inherit the main runtime's tools: configuration, not a prompt, is the
boundary. Every plugin row that can register a model-facing tool (filesystem,
shell, jobs, web, skills, todos, goals, subagents, workflows, MCP resources,
plan mode, structured questions, slash commands, attachments, repeat-tool
reminders, tool-result pruning and image offload) is disabled in this overlay,
and ``dsh_btw`` refuses to start unless a completed ``--dump-config`` proves
each row landed disabled.

Evidence for this exact row list against the pinned
``deepseek-harness-runtime-bin`` 0.2.1rc2 is recorded in
``docs/btw-runtime.md``: with this overlay the outbound model request has no
``tools`` field at all, while the same probe against the main ``acp`` profile
reports 25 tools. Adding a tool row to the shipped profile without adding it
here is caught by that documented probe, not by the type system.

The provider, model, budget and compaction rows are reused verbatim from the
main ACP overlay so there is exactly one arithmetic authority
(:class:`~jupyter_aiterminal.dsh_config.DerivedBudget`).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .dsh_acp_config import (
    ACP_ROW_ACP,
    ACP_ROW_AGENT_DEFAULT_MODEL,
    ACP_ROW_APPROVAL,
    ACP_ROW_COMPACTION,
    ACP_ROW_SANDBOX_POLICY,
    _compaction_row,
    _provider_row,
)
from .dsh_config import (
    DSH_PROVIDER_ID,
    DerivedBudget,
    DshProviderConfig,
    _validate_config_snapshot,
)

__all__ = [
    "BTW_APPROVAL_POLICY",
    "BTW_DISABLED_ROW_IDS",
    "BTW_SANDBOX_MODE",
    "build_btw_profile_patches",
    "render_btw_profile_patch",
]

# Rows verified absent of config-only side effects when patched by id on the
# pinned runtime. This list is the whole tool surface of the shipped ``acp``
# profile plus the agent-loop helpers that register tools indirectly.
BTW_DISABLED_ROW_IDS: tuple[str, ...] = (
    # Filesystem tools and search.
    "tool-fs",
    "tool-fs-search",
    # Shell tools and their PTY/job surfaces.
    "tool-bash",
    "tool-pwsh",
    "tool-jobs",
    # Web tools and their providers.
    "tool-web",
    "web",
    "web-search-deepseek",
    "web-deepseek-api",
    "web-fetch-http",
    # Skills, instructions and slash commands.
    "tool-skill",
    "skill",
    "skill-filesystem",
    "commands",
    "command-feedback",
    "command-compact",
    "command-goal",
    # Working-directory tools keep a server-side cwd per session and register
    # their own tool; BTW has no working directory to change.
    "tool-working-directory",
    "working-directory",
    # Goals, todos and plan mode (``exit_plan_mode`` is a real tool).
    "tool-todo",
    "tool-goal",
    "goal",
    "goal-round-driver",
    "plan-mode",
    # Subagents and workflows.
    "tool-subagent",
    "tool-subagent-fork",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "subagent",
    "subagent-spawn-in-process",
    "subagent-fork-in-process",
    "tool-workflow",
    "workflow-ptc",
    # MCP resources (three read tools); client MCP servers are rejected by the
    # fixed ``session/new`` params builder.
    "mcp-resources",
    # Structured questions and attachments.
    "user-questions",
    "attachment-local",
    # Prompt-level helpers that inject or prune tool content.
    "agent-instructions",
    "repeat-tool-reminder",
    "tool-result-pruner",
    "image-offload",
    # Session title generation is an extra model call BTW does not need.
    "session-title",
    "session-title-llm",
)

# BTW never approves anything. The actual barrier is that the model request
# carries no ``tools`` field at all (see ``docs/btw-runtime.md``), plus the
# read-only sandbox; ``policy: never`` only means the host is never asked, so it
# is NOT a deny path for a leaked tool call and must not be described as one.
BTW_APPROVAL_POLICY = "never"
BTW_SANDBOX_MODE = "read-only"


def build_btw_profile_patches(
    config: DshProviderConfig,
    *,
    workspace_root: str | Path,
) -> list[dict[str, Any]]:
    """Build the ordered patch list for the BTW runtime.

    ``workspace_root`` is the same absolute directory the host passes as the
    runtime cwd; it is only the sandbox fallback because BTW sessions carry no
    writable surface at all.
    """
    budget = _validate_config_snapshot(config)
    root = Path(workspace_root)
    if not root.is_absolute():
        raise ValueError("workspace_root must be an absolute path")

    rows: list[dict[str, Any]] = [
        _provider_row(config, budget),
        {
            "id": ACP_ROW_AGENT_DEFAULT_MODEL,
            "config": {
                "provider": DSH_PROVIDER_ID,
                "model": config.model,
            },
        },
        {
            "id": ACP_ROW_ACP,
            "config": {"provider": DSH_PROVIDER_ID, "model": config.model},
        },
        {"id": ACP_ROW_APPROVAL, "config": {"policy": BTW_APPROVAL_POLICY}},
        {
            "id": ACP_ROW_SANDBOX_POLICY,
            "config": {"mode": BTW_SANDBOX_MODE, "workspaceRoot": str(root)},
        },
        _compaction_row(budget),
    ]
    rows.extend({"id": row_id, "disabled": True} for row_id in BTW_DISABLED_ROW_IDS)
    return rows


def render_btw_profile_patch(
    config: DshProviderConfig,
    *,
    workspace_root: str | Path,
) -> str:
    """Serialize the BTW overlay as JSON, which is a valid YAML subset."""
    return json.dumps(
        build_btw_profile_patches(config, workspace_root=workspace_root),
        ensure_ascii=True,
        indent=2,
    )


def btw_budget(config: DshProviderConfig) -> DerivedBudget:
    """Return the single authoritative budget for a BTW runtime snapshot."""
    return _validate_config_snapshot(config)


def btw_disabled_rows() -> Sequence[str]:
    """Read-only view of the disabled row list for diagnostics and tests."""
    return BTW_DISABLED_ROW_IDS
