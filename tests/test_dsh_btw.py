"""Fail-closed startup checks for the dedicated BTW runtime."""

from __future__ import annotations

import asyncio

import pytest

from jupyter_aiterminal.btw_config import BTW_DISABLED_ROW_IDS
from jupyter_aiterminal.dsh_btw import BtwRuntime, BtwRuntimeError, verify_btw_dump
from jupyter_aiterminal.dsh_config import DshProviderConfig, derive_dsh_budget
from jupyter_aiterminal.settings import AgentConfigError

BUDGET = derive_dsh_budget({}, context_window=1000000, max_output_tokens=384000)


def dump(*, disabled=BTW_DISABLED_ROW_IDS, approval='never', sandbox='read-only',
         compaction=None, token_meter=True):
    lines = []
    for row_id in disabled:
        lines.extend([f'- id: {row_id}', "  name: '@deepseek-ai/dsh-row'", '  disabled: true'])
    lines.extend(['- id: approval', '  name: "@deepseek-ai/dsh-user-approval"'])
    lines.extend(['  config:', f'    policy: {approval}'])
    lines.extend(['- id: sandbox-policy', '  name: "@deepseek-ai/dsh-sandbox-policy"'])
    lines.extend(['  config:', f'    mode: {sandbox}', '    workspaceRoot: /tmp/ws'])
    values = compaction or {
        'auto': 'true',
        'thresholdRatio': str(BUDGET.threshold_ratio),
        'headroomTokens': str(BUDGET.headroom),
        'retainRatio': str(BUDGET.retain_ratio),
        'maxTokens': str(BUDGET.summary_max_tokens),
    }
    lines.extend(['- id: compaction-basic', '  name: "@deepseek-ai/dsh-compaction-basic"'])
    lines.append('  config:')
    for key, value in values.items():
        lines.append(f'    {key}: {value}')
    if token_meter:
        lines.extend(['- id: token-meter', '  name: "@deepseek-ai/dsh-token-meter"'])
    return '\n'.join(lines) + '\n'


def test_good_dump_passes():
    verify_btw_dump(dump(), BUDGET)


def test_missing_tool_row_is_rejected():
    rows = [row for row in BTW_DISABLED_ROW_IDS if row != 'tool-bash']
    with pytest.raises(AgentConfigError, match='tool-bash'):
        verify_btw_dump(dump(disabled=rows), BUDGET)


def test_enabled_tool_row_is_rejected():
    text = dump().replace(
        '- id: tool-fs\n  name: \'@deepseek-ai/dsh-row\'\n  disabled: true',
        '- id: tool-fs\n  name: \'@deepseek-ai/dsh-row\'\n  disabled: false',
    )
    with pytest.raises(AgentConfigError, match='tool-fs'):
        verify_btw_dump(text, BUDGET)


def test_duplicated_tool_row_is_rejected():
    text = dump() + '- id: tool-fs\n  name: "@deepseek-ai/dsh-row"\n  disabled: true\n'
    with pytest.raises(AgentConfigError, match='tool-fs'):
        verify_btw_dump(text, BUDGET)


def test_approval_policy_must_be_never():
    with pytest.raises(AgentConfigError, match='approval'):
        verify_btw_dump(dump(approval='ask'), BUDGET)


def test_sandbox_must_be_read_only():
    with pytest.raises(AgentConfigError, match='read-only sandbox'):
        verify_btw_dump(dump(sandbox='workspace-write'), BUDGET)


def test_compaction_must_match_the_budget():
    values = {
        'auto': 'true',
        'thresholdRatio': '0.5',
        'headroomTokens': str(BUDGET.headroom),
        'retainRatio': str(BUDGET.retain_ratio),
        'maxTokens': str(BUDGET.summary_max_tokens),
    }
    with pytest.raises(AgentConfigError, match='compaction-basic'):
        verify_btw_dump(dump(compaction=values), BUDGET)


def test_token_meter_must_exist():
    with pytest.raises(AgentConfigError, match='token-meter'):
        verify_btw_dump(dump(token_meter=False), BUDGET)


def test_runtime_refuses_to_start_without_a_tool_free_overlay(tmp_path):
    async def preflight(argv, cwd, env, timeout):
        return 0, dump(sandbox='workspace-write'), ''

    runtime = BtwRuntime(
        config=_config(),
        workspace_root=tmp_path,
        storage_root=tmp_path / 'store',
        runtime_version=lambda: '0.2.1rc2',
        policy_preflight=preflight,
    )
    with pytest.raises(BtwRuntimeError, match='BTW'):
        asyncio.run(runtime.open_session())
    # The transport was never started: no child process, no session.
    assert runtime.running is False
    assert runtime.status()['sessions'] == 0


def test_runtime_rejects_a_preflight_patch_warning(tmp_path):
    async def preflight(argv, cwd, env, timeout):
        return 0, '', 'patch: entry "tool-bash" not found'

    runtime = BtwRuntime(
        config=_config(),
        workspace_root=tmp_path,
        storage_root=tmp_path / 'store',
        runtime_version=lambda: '0.2.1rc2',
        policy_preflight=preflight,
    )
    with pytest.raises(BtwRuntimeError, match='tool-free'):
        asyncio.run(runtime.open_session())


def test_runtime_rejects_a_mismatched_runtime_version(tmp_path):
    runtime = BtwRuntime(
        config=_config(),
        workspace_root=tmp_path,
        storage_root=tmp_path / 'store',
        runtime_version=lambda: '0.1.0',
    )
    with pytest.raises(BtwRuntimeError, match='0.2.1rc2'):
        asyncio.run(runtime.open_session())


def _config():
    return DshProviderConfig(
        api_protocol='openai-completions',
        base_url='http://127.0.0.1:9/v1',
        model='probe-model',
        context_window=BUDGET.context_window,
        max_output_tokens=BUDGET.max_output_tokens,
        token='secret-token-value',
        budget=BUDGET,
    )


def test_cancel_targets_only_the_prompting_session(tmp_path):
    calls = []

    class FakeRuntime:
        async def cancel_session(self, session_id):
            calls.append(session_id)

    runtime = BtwRuntime(
        config=_config(),
        workspace_root=tmp_path,
        storage_root=tmp_path / 'store',
        runtime_version=lambda: '0.2.1rc2',
    )

    async def scenario():
        runtime._runtime = FakeRuntime()
        async with runtime._prompting_lock:
            runtime._prompting.add('session-1')
        idle = await runtime.cancel('session-2')
        active = await runtime.cancel('session-1')
        return idle, active

    assert asyncio.run(scenario()) == (False, True)
    assert calls == ['session-1']
