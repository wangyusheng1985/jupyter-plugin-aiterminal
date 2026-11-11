"""The BTW profile overlay must disable every tool row and keep the budget."""

from __future__ import annotations

import json

import pytest

from jupyter_aiterminal.btw_config import (
    BTW_APPROVAL_POLICY,
    BTW_DISABLED_ROW_IDS,
    BTW_SANDBOX_MODE,
    build_btw_profile_patches,
    render_btw_profile_patch,
)
from jupyter_aiterminal.dsh_config import DshProviderConfig, derive_dsh_budget


def provider_config(context_window: int = 1000000, max_output: int = 384000):
    return DshProviderConfig(
        api_protocol='openai-completions',
        base_url='http://127.0.0.1:9/v1',
        model='probe-model',
        context_window=context_window,
        max_output_tokens=max_output,
        token='secret-token-value',
        budget=derive_dsh_budget(
            {}, context_window=context_window, max_output_tokens=max_output
        ),
    )


def rows_by_id(patches):
    return {row['id']: row for row in patches}


def test_every_tool_row_is_disabled(tmp_path):
    rows = rows_by_id(build_btw_profile_patches(provider_config(), workspace_root=tmp_path))
    for row_id in BTW_DISABLED_ROW_IDS:
        assert rows[row_id] == {'id': row_id, 'disabled': True}
    # The rows the main agent runtime needs for file and shell work are the
    # exact ones BTW must never carry.
    for row_id in (
        'tool-fs',
        'tool-fs-search',
        'tool-bash',
        'tool-pwsh',
        'tool-jobs',
        'tool-working-directory',
    ):
        assert rows[row_id]['disabled'] is True


def test_plan_mode_and_subagent_rows_are_disabled(tmp_path):
    # ``exit_plan_mode`` is a real tool: a probe against the runtime found it
    # advertised even when the obvious filesystem/shell rows were disabled.
    rows = rows_by_id(build_btw_profile_patches(provider_config(), workspace_root=tmp_path))
    for row_id in (
        'plan-mode',
        'tool-subagent',
        'tool-workflow',
        'mcp-resources',
        'user-questions',
        'commands',
    ):
        assert rows[row_id]['disabled'] is True


def test_approval_and_sandbox_are_fail_closed(tmp_path):
    rows = rows_by_id(build_btw_profile_patches(provider_config(), workspace_root=tmp_path))
    assert rows['approval']['config']['policy'] == BTW_APPROVAL_POLICY == 'never'
    assert rows['sandbox-policy']['config']['mode'] == BTW_SANDBOX_MODE == 'read-only'
    assert rows['sandbox-policy']['config']['workspaceRoot'] == str(tmp_path)


def test_budget_rows_are_the_single_authority(tmp_path):
    config = provider_config()
    rows = rows_by_id(build_btw_profile_patches(config, workspace_root=tmp_path))
    model = rows['llm-pi-ai']['config']['providers']['jupyter-aiterminal']['models'][0]
    assert model['contextWindow'] == 1000000
    assert model['maxTokens'] == 384000
    compaction = rows['compaction-basic']['config']
    assert compaction == {
        'auto': config.budget.compaction_enabled,
        'thresholdRatio': config.budget.threshold_ratio,
        'headroomTokens': config.budget.headroom,
        'retainRatio': config.budget.retain_ratio,
        'maxTokens': config.budget.summary_max_tokens,
    }


def test_rendered_patch_never_contains_the_token_or_new_rows(tmp_path):
    config = provider_config()
    text = render_btw_profile_patch(config, workspace_root=tmp_path)
    assert 'secret-token-value' not in text
    rows = json.loads(text)
    assert all(set(row) <= {'id', 'config', 'disabled'} for row in rows)
    assert len({row['id'] for row in rows}) == len(rows)


def test_workspace_root_must_be_absolute():
    with pytest.raises(ValueError):
        build_btw_profile_patches(provider_config(), workspace_root='relative/dir')
