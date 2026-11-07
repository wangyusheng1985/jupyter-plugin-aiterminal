"""Contract tests for the pure ACP-profile patch and child env builder.

The narrow dump fixture below is the real row list from the pinned
``0.2.1rc2`` runtime::

    <runtime> --profile acp --dump-config

Only the ``- id:`` lines are kept. No model, SDK, or network is used.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from jupyter_aiterminal.dsh_acp_config import (
    PASSTHROUGH_ENV_KEYS,
    build_acp_profile_patches,
    build_acp_session_params,
    build_acp_subprocess_env,
    render_acp_profile_patch,
    validate_controlled_root,
)
from jupyter_aiterminal.dsh_config import (
    DSH_API_KEY_ENV,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_OPENAI_COMPLETIONS,
    build_provider_insert_patch,
    parse_dsh_provider_config,
)
from jupyter_aiterminal.settings import AgentConfigError

SECRET = "dsh-acp-unit-secret-never-render-me"
BASE_SETTINGS = {
    "baseUrl": "https://api.example.test/v1",
    "model": "example-acp-model",
    "token": SECRET,
}

# Verbatim `- id:` lines from the real 0.2.1rc2 ACP dump. Hand-written on
# purpose: it is the reverse contract for the overlay, never derived from the
# implementation constants.
REAL_ACP_DUMP = """
- id: tool-plugin-manager
- id: plugin-manager
- id: timer
- id: hmr
- id: llm
- id: deepseek-llm-api-extensions
- id: session
- id: session-log-deepseek
- id: typert
- id: typert-loader
- id: typert-gateway
- id: remote-access
- id: session-title
- id: session-title-llm
- id: user-questions
- id: agent
- id: plugin-package-inventory-deepseek
- id: agent-default-model
- id: jobs
- id: llm-retry
- id: config-editor
- id: settings
- id: authorization
- id: deepseek-account
- id: credentials
- id: llm-pi-ai
- id: session-persistence-jsonl
- id: attachment-local
- id: session-query-sqlite
- id: working-directory
- id: tool-working-directory
- id: session-projection
- id: storage
- id: storage-json
- id: storage-domain
- id: session-projection-cache
- id: otel
- id: session-telemetry-otel
- id: subprocess
- id: sandbox
- id: sandbox-policy
- id: bash-sandbox
- id: pwsh-sandbox
- id: approval
- id: permission
- id: shell-env
- id: tool-bash
- id: tool-pwsh
- id: tool-jobs
- id: fs-observation-policy
- id: tool-fs
- id: tool-fs-search
- id: agent-instructions
- id: skill
- id: skill-filesystem
- id: tool-skill
- id: commands
- id: command-feedback
- id: goal
- id: goal-round-driver
- id: command-goal
- id: plan-mode
- id: token-meter
- id: compaction-basic
- id: command-compact
- id: subagent
- id: subagent-spawn-in-process
- id: subagent-fork-in-process
- id: tool-subagent-control
- id: tool-subagent-list-agents
- id: tool-subagent
- id: tool-subagent-fork
- id: ptc-runtime
- id: workflow-ptc
- id: tool-workflow
- id: timeout-policy
- id: spill-local
- id: spill-policy
- id: session-checkpoint-policy
- id: tool-result-pruner
- id: image-offload
- id: tool-todo
- id: tool-goal
- id: repeat-tool-reminder
- id: web
- id: web-search-deepseek
- id: web-deepseek-api
- id: web-fetch-http
- id: tool-web
- id: mcp-resources
- id: tools
- id: system-prompt
- id: agent-loop
- id: fs-sandbox
- id: llm-deepseek
- id: llm-deepseek-account
- id: acp-app-startup
- id: acp
"""

REAL_ROW_IDS = {
    line.removeprefix("- id: ")
    for line in REAL_ACP_DUMP.splitlines()
    if line.startswith("- id: ")
}

# Rows the overlay is allowed to touch, hand-written from the same dump.
OVERLAY_ROW_IDS = {
    "llm-pi-ai",
    "agent-default-model",
    "acp",
    "approval",
    "sandbox-policy",
    "tool-fs",
    "compaction-basic",
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
}

DISABLED_ROW_IDS = {
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
}

# The dump warns on a patch layer that targets no row. Keep the check in the
# tests so a future id typo cannot pass as a silent no-op.
DUMP_PATCH_WARNING_MARKERS = (
    "patch: entry",
    "patch insert: entry",
    "name mismatch",
    "not found",
)


def _unmatched_patch_warnings(stderr: str) -> list[str]:
    return [
        line
        for line in stderr.splitlines()
        if any(marker in line for marker in DUMP_PATCH_WARNING_MARKERS)
    ]


def _config(**overrides: object):
    raw = dict(BASE_SETTINGS)
    raw.update(overrides)
    return parse_dsh_provider_config(raw)


def _rows_by_id(rows: list[dict]) -> dict[str, dict]:
    return {row["id"]: row for row in rows}


def test_real_dump_fixture_is_clean():
    assert len(REAL_ROW_IDS) == REAL_ACP_DUMP.count("- id: ")
    assert "mcp-resources" in REAL_ROW_IDS
    assert "tool-working-directory" in REAL_ROW_IDS
    assert _unmatched_patch_warnings("") == []


def test_unmatched_patch_warning_is_rejected():
    stderr = (
        "dsh: [generated_acp_patch.json] patch: entry (id: ghost-row) not found\n"
    )
    assert _unmatched_patch_warnings(stderr) == [stderr.strip()]


def test_both_protocols_produce_expected_real_rows(tmp_path: Path):
    root = tmp_path / "workspace"
    for protocol in (PROTOCOL_OPENAI_COMPLETIONS, PROTOCOL_ANTHROPIC_MESSAGES):
        config = _config(apiProtocol=protocol)
        rows = build_acp_profile_patches(config, workspace_root=root)
        by_id = _rows_by_id(rows)

        assert len(rows) == len(by_id), "patch list must not repeat row ids"
        assert set(by_id) == OVERLAY_ROW_IDS
        assert set(by_id) <= REAL_ROW_IDS, "every patch id must exist in the real dump"

        provider = by_id["llm-pi-ai"]["config"]["providers"]["jupyter-aiterminal"]
        assert provider["api"] == protocol
        assert provider["baseURL"] == BASE_SETTINGS["baseUrl"]
        assert provider["apiKeyEnv"] == DSH_API_KEY_ENV
        budget = config.budget
        assert budget is not None
        assert provider["models"] == [
            {
                "id": BASE_SETTINGS["model"],
                "name": BASE_SETTINGS["model"],
                "contextWindow": budget.context_window,
                "maxTokens": budget.max_output_tokens,
            }
        ]
        assert provider["defaultMaxTokens"] == budget.max_output_tokens
        assert provider["retryPolicy"] == {"mode": "normal", "maxRetries": 0}

        assert by_id["agent-default-model"]["config"] == {
            "provider": "jupyter-aiterminal",
            "model": BASE_SETTINGS["model"],
        }
        assert by_id["acp"]["config"] == {
            "provider": "jupyter-aiterminal",
            "model": BASE_SETTINGS["model"],
        }
        assert by_id["approval"]["config"] == {"policy": "ask"}
        assert by_id["sandbox-policy"]["config"] == {
            "mode": "workspace-write",
            "workspaceRoot": str(root),
        }
        assert by_id["tool-fs"]["config"] == {
            "read": True,
            "readImage": True,
            "write": True,
            "edit": True,
            "applyPatch": False,
        }
        assert by_id["compaction-basic"]["config"] == {
            "auto": budget.compaction_enabled,
            "thresholdRatio": budget.threshold_ratio,
            "headroomTokens": budget.headroom,
            "retainRatio": budget.retain_ratio,
            "maxTokens": budget.summary_max_tokens,
        }
        # token-meter stays enabled and receives no config: the runtime rejects
        # a config patch against its empty schema.
        assert "token-meter" not in by_id

        for row_id in DISABLED_ROW_IDS:
            assert by_id[row_id] == {"id": row_id, "disabled": True}
        # tool-bash is not patched, so the shipped platform gate survives.
        assert "tool-bash" not in by_id


def test_provider_budget_matches_insert_patch_and_is_not_clamped(tmp_path: Path):
    # 8192 max output tokens is above the removed 4096 cap and must pass through.
    config = _config(contextWindow=32768, maxOutputTokens=8192)
    budget = config.budget
    assert budget is not None
    assert budget.max_output_tokens == 8192

    rows = _rows_by_id(build_acp_profile_patches(config, workspace_root=tmp_path))
    provider = rows["llm-pi-ai"]["config"]["providers"]["jupyter-aiterminal"]
    acp_model = provider["models"][0]
    assert acp_model["contextWindow"] == 32768
    assert acp_model["maxTokens"] == 8192
    assert provider["defaultMaxTokens"] == 8192

    # The existing provider insert patch and the ACP patch share one config and
    # must report identical C/O values.
    insert_row = build_provider_insert_patch(config)["insert"][0]
    insert_provider = insert_row["config"]["providers"]["jupyter-aiterminal"]
    insert_model = insert_provider["models"][0]
    assert insert_model["contextWindow"] == acp_model["contextWindow"]
    assert insert_model["maxTokens"] == acp_model["maxTokens"]


def test_compaction_disabled_patches_auto_false(tmp_path: Path):
    config = _config(compactionEnabled=False)
    rows = _rows_by_id(build_acp_profile_patches(config, workspace_root=tmp_path))
    assert rows["compaction-basic"]["config"]["auto"] is False


def test_compaction_patch_never_inserts_a_new_row(tmp_path: Path):
    rows = build_acp_profile_patches(
        _config(contextWindow=32768, maxOutputTokens=8192),
        workspace_root=tmp_path,
    )
    assert all("insert" not in row for row in rows)
    assert "compaction-basic" in {row["id"] for row in rows}
    assert "token-meter" not in {row["id"] for row in rows}


def test_overlay_never_inserts_or_names_unknown_rows(tmp_path: Path):
    rows = build_acp_profile_patches(_config(), workspace_root=tmp_path)
    assert all("insert" not in row for row in rows)
    assert all(row["id"] in REAL_ROW_IDS for row in rows)
    assert not any(row["id"].startswith("terminal-") for row in rows)


def test_render_is_json_yaml_subset_and_hides_secret(tmp_path: Path):
    rendered = render_acp_profile_patch(_config(), workspace_root=tmp_path)
    parsed = json.loads(rendered)
    assert parsed == build_acp_profile_patches(_config(), workspace_root=tmp_path)
    assert SECRET not in rendered
    assert "sk-" not in rendered


def test_malicious_model_cannot_inject_a_yaml_row(tmp_path: Path):
    config = _config(model="good-model\n- id: injected-row\ndisabled: false")
    rendered = render_acp_profile_patch(config, workspace_root=tmp_path)

    parsed = json.loads(rendered)
    assert all(row["id"] != "injected-row" for row in parsed)
    assert "\n- id: injected-row" not in rendered


def test_patch_requires_absolute_workspace_root():
    with pytest.raises(AgentConfigError, match="absolute"):
        build_acp_profile_patches(_config(), workspace_root="relative/workspace")
    with pytest.raises(AgentConfigError, match="absolute"):
        render_acp_profile_patch(_config(), workspace_root="relative/workspace")


def test_session_params_pin_absolute_cwd_and_reject_mcp_servers(tmp_path: Path):
    params = build_acp_session_params(tmp_path / "workspace")
    assert params == {"cwd": str(tmp_path / "workspace"), "mcpServers": []}

    with pytest.raises(AgentConfigError, match="absolute"):
        build_acp_session_params("relative/workspace")
    with pytest.raises(AgentConfigError, match="MCP"):
        build_acp_session_params(tmp_path, mcp_servers=[{"name": "evil"}])
    with pytest.raises(AgentConfigError, match="MCP"):
        build_acp_session_params(tmp_path, mcp_servers=({"name": "evil"},))
    with pytest.raises(AgentConfigError, match="sequence"):
        build_acp_session_params(tmp_path, mcp_servers="evil")  # type: ignore[arg-type]


def test_env_is_allowlist_only_and_replaces_global_secrets(tmp_path: Path):
    home = tmp_path / "home"
    dsh_home = tmp_path / "dsh"
    host_env = {
        "PATH": "/usr/bin:/bin",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "en_US.UTF-8",
        "TERM": "dumb",
        "TMPDIR": str(tmp_path / "tmp"),
        "OPENAI_API_KEY": "host-openai-secret",
        "AWS_SECRET_ACCESS_KEY": "host-aws-secret",
        "CUSTOM_SECRET": "host-custom-secret",
        "DSH_HOME": "/Users/someone/.dsh",
        "DSH_PROFILE": "user-profile",
        "DSH_PERMISSION_MODE": "danger-full-access",
        "HOME": "/Users/someone",
    }

    env = build_acp_subprocess_env(
        host_env, home=home, dsh_home=dsh_home, config=_config()
    )

    assert env["PATH"] == "/usr/bin:/bin"
    assert env["HOME"] == str(home)
    assert env["DSH_HOME"] == str(dsh_home)
    assert env[DSH_API_KEY_ENV] == SECRET
    assert set(env) <= {
        *PASSTHROUGH_ENV_KEYS,
        "HOME",
        "DSH_HOME",
        DSH_API_KEY_ENV,
    }
    for forbidden in (
        "OPENAI_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "CUSTOM_SECRET",
        "DSH_PROFILE",
        "DSH_PERMISSION_MODE",
    ):
        assert forbidden not in env
    assert env["DSH_HOME"] != host_env["DSH_HOME"]
    assert env["HOME"] != host_env["HOME"]


def test_env_skips_empty_host_values_instead_of_merging(tmp_path: Path):
    env = build_acp_subprocess_env(
        {"PATH": "", "LANG": "C", "TERM": ""},
        home=tmp_path / "home",
        dsh_home=tmp_path / "dsh",
        config=_config(),
    )
    assert "PATH" not in env
    assert "TERM" not in env
    assert env["LANG"] == "C"


def test_env_does_not_mutate_host_mapping_or_os_environ(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    host_env = {"PATH": "/usr/bin:/bin", "OPENAI_API_KEY": "host-secret"}
    original_host = dict(host_env)
    monkeypatch.setenv("OPENAI_API_KEY", "os-secret")
    original_os = dict(os.environ)

    env = build_acp_subprocess_env(
        host_env,
        home=tmp_path / "home",
        dsh_home=tmp_path / "dsh",
        config=_config(),
    )

    assert host_env == original_host
    assert dict(os.environ) == original_os
    assert env[DSH_API_KEY_ENV] == SECRET
    assert "OPENAI_API_KEY" not in env


def test_env_requires_distinct_normalized_absolute_homes(tmp_path: Path):
    with pytest.raises(AgentConfigError, match="absolute"):
        build_acp_subprocess_env(
            {"PATH": "/usr/bin"},
            home="relative",
            dsh_home=tmp_path / "dsh",
            config=_config(),
        )
    with pytest.raises(AgentConfigError, match="different"):
        build_acp_subprocess_env(
            {"PATH": "/usr/bin"},
            home=tmp_path / "same",
            dsh_home=tmp_path / "same",
            config=_config(),
        )
    with pytest.raises(AgentConfigError, match="different"):
        build_acp_subprocess_env(
            {"PATH": "/usr/bin"},
            home=tmp_path / "a" / "x" / ".." / "h",
            dsh_home=tmp_path / "a" / "h",
            config=_config(),
        )


def test_controlled_root_rejects_symlink_and_file_but_creates_nothing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    existing_dir = tmp_path / "existing"
    existing_dir.mkdir()
    assert validate_controlled_root(existing_dir) == existing_dir

    file_path = tmp_path / "file"
    file_path.write_text("user patch", encoding="utf-8")
    with pytest.raises(AgentConfigError, match="directory"):
        validate_controlled_root(file_path)

    link = tmp_path / "link"
    link.symlink_to(existing_dir)
    with pytest.raises(AgentConfigError, match="symlink"):
        validate_controlled_root(link)

    missing = tmp_path / "missing"
    assert validate_controlled_root(missing) == missing
    assert not missing.exists()

    # A symlinked parent chain is rejected even when the leaf does not exist.
    parent_link = tmp_path / "parent-link"
    parent_link.symlink_to(existing_dir)
    with pytest.raises(AgentConfigError, match="symlink"):
        validate_controlled_root(parent_link / "child")
    with pytest.raises(AgentConfigError, match="symlink"):
        validate_controlled_root(parent_link / ".." / "child")

    # Only the target's owner is checked, not ancestors such as ``/`` or /tmp.
    real_euid = os.geteuid()
    monkeypatch.setattr(
        "jupyter_aiterminal.dsh_acp_config.os.geteuid",
        lambda: real_euid + 1,
    )
    with pytest.raises(AgentConfigError, match="owned by the current user"):
        validate_controlled_root(existing_dir)
