import type { ChatBlock } from './protocol';
import {
  createTurn,
  deriveTurn,
  setTurnStatus,
  toggleActivity,
  toggleTrace,
  type ChatTurn
} from './turn';
import { renderTurn, turnSummary } from './turn-renderer';

jest.mock('@jupyterlab/rendermime', () => ({
  renderMarkdown: jest.fn()
}));

function handlers() {
  return {
    onToggleTrace: jest.fn(),
    onToggleActivity: jest.fn(),
    onToggleEvidence: jest.fn(),
    onToggleOutcome: jest.fn(),
    onRevealFailure: jest.fn()
  };
}

function completedTurn(blocks: ChatBlock[]): ChatTurn {
  return setTurnStatus(createTurn('run-1'), 'done', blocks);
}

function toolBlock(
  id: string,
  overrides: Partial<Extract<ChatBlock, { kind: 'tool' }>> = {}
): Extract<ChatBlock, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    name: 'Bash',
    input: { command: 'pwd' },
    output: '/tmp\n',
    status: 'done',
    durationMs: 120,
    ...overrides
  };
}

describe('renderTurn', () => {
  it('renders one unframed outcome followed by the collapsed audit summary', () => {
    const turn = completedTurn([
      {
        kind: 'text',
        id: 'text-1',
        text: 'Finished the requested task.'
      },
      toolBlock('tool-1')
    ]);
    const node = renderTurn(turn, { handlers: handlers() });

    expect(node.firstElementChild?.className).toBe('jp-AgentWorkspace-outcome');
    expect(
      node.querySelector('.jp-AgentWorkspace-outcomeBody')?.textContent
    ).toContain('Finished the requested task.');
    expect(node.querySelector('.jp-AgentWorkspace-sectionLabel')).toBeNull();
    expect(node.querySelector('.jp-AgentWorkspace-diagnostics')).toBeNull();
    expect(node.querySelector('.jp-AgentWorkspace-changes')).toBeNull();
    expect(
      node.querySelector('.jp-AgentWorkspace-auditSummary')
    ).not.toBeNull();
    expect(
      node
        .querySelector('[data-turn-focus-key="trace:run-1"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(node.querySelector('.jp-AgentWorkspace-executionRecord')).toBeNull();
  });

  it('summarizes available audit metrics and omits unavailable values', () => {
    const turn = completedTurn([
      {
        kind: 'text',
        id: 'text-1',
        text: 'done'
      },
      toolBlock('tool-1', {
        name: 'Read',
        input: { file_path: '/tmp/source.ts' },
        output: 'one\n'
      }),
      toolBlock('tool-2', {
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: '--- a.ts\n+++ a.ts\n-old\n+new\n',
        durationMs: 1250
      })
    ]);
    turn.metrics.durationMs = 3400;

    expect(turnSummary(turn)).toBe('2 steps | 3.4 s | 1 file changed');
    expect(turnSummary(createTurn('empty'))).toBe('0 steps');

    const node = renderTurn(turn, { handlers: handlers() });
    expect(
      node.querySelector('.jp-AgentWorkspace-auditStats')?.textContent
    ).toContain('2 steps');
    expect(
      node.querySelector('.jp-AgentWorkspace-auditStats')?.textContent
    ).toContain('3.4 s');
    expect(
      node.querySelector('.jp-AgentWorkspace-auditStats')?.textContent
    ).toContain('1 file changed');
  });

  it('renders an actionable failure count and delegates failure navigation', () => {
    const turn = completedTurn([
      {
        kind: 'text',
        id: 'text-1',
        text: 'Recovered from one failed edit.'
      },
      toolBlock('tool-1', {
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: 'target text not found\n',
        status: 'error'
      })
    ]);
    const options = { handlers: handlers() };
    const node = renderTurn(turn, options);
    const failure = node.querySelector<HTMLButtonElement>(
      '[data-failure-navigation]'
    );

    expect(failure?.textContent).toBe('1 step failed');
    expect(failure?.getAttribute('data-turn-control')).toBe('');
    failure?.click();
    expect(options.handlers.onRevealFailure).toHaveBeenCalledWith(
      'run-1',
      'activity-tool-1'
    );

    const clean = renderTurn(completedTurn([toolBlock('tool-2')]), {
      handlers: handlers()
    });
    expect(clean.querySelector('[data-failure-navigation]')).toBeNull();
  });

  it('renders the expanded record as chronological responsive rows', () => {
    let turn = completedTurn([
      toolBlock('tool-1', {
        name: 'Read',
        input: { file_path: '/tmp/source.ts' },
        output: 'one\ntwo\n',
        durationMs: 84
      }),
      toolBlock('tool-2', {
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: '--- a.ts\n+++ a.ts\n-old\n+new\n',
        durationMs: 210
      }),
      toolBlock('tool-3', {
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: '--- a.ts\n+++ a.ts\n-old\n+new\n+more\n',
        status: 'error',
        durationMs: 64
      })
    ]);
    turn = toggleTrace(turn);
    turn = toggleActivity(turn, 'activity-tool-3');
    const node = renderTurn(turn, { handlers: handlers() });
    const rows = node.querySelectorAll('.jp-AgentWorkspace-activity');

    expect(rows).toHaveLength(3);
    expect(
      rows[0].querySelector('.jp-AgentWorkspace-stepNumber')?.textContent
    ).toBe('1');
    expect(
      rows[0].querySelector('.jp-AgentWorkspace-stepOperation strong')
        ?.textContent
    ).toBe('Read');
    expect(
      rows[1].querySelector('.jp-AgentWorkspace-stepDuration')?.textContent
    ).toBe('210 ms');
    expect(
      rows[2].querySelector('.jp-AgentWorkspace-stepResult')?.textContent
    ).toContain('Failed');
    expect(
      rows[2].querySelector('.jp-AgentWorkspace-activityDiagnostic')
        ?.textContent
    ).toContain('failed');
  });

  it('keeps raw evidence behind bounded progressive disclosure', () => {
    const output = Array.from(
      { length: 24 },
      (_, index) => `line ${index + 1}`
    ).join('\n');
    const blocks: ChatBlock[] = [
      {
        kind: 'text',
        id: 'text-1',
        text: 'done'
      },
      toolBlock('tool-1', {
        input: { command: 'cat output.txt' },
        output
      })
    ];
    let previewTurn = completedTurn(blocks);
    previewTurn = toggleTrace(previewTurn);
    previewTurn = toggleActivity(previewTurn, 'activity-tool-1');
    const preview = renderTurn(previewTurn, { handlers: handlers() });
    const previewActivity = preview.querySelector(
      '[data-activity-id="activity-tool-1"]'
    );

    expect(previewActivity?.textContent).not.toContain('line 24');
    expect(
      previewActivity?.querySelector('.jp-AgentWorkspace-hiddenEvidence')
        ?.textContent
    ).toContain('12 more output lines');
    expect(
      previewActivity?.querySelector('.jp-AgentWorkspace-activityEvidence')
    ).not.toBeNull();

    const fullTurn: ChatTurn = {
      ...previewTurn,
      presentation: {
        ...previewTurn.presentation,
        fullEvidenceActivityIds: ['activity-tool-1']
      }
    };
    const full = renderTurn(fullTurn, { handlers: handlers() });
    expect(
      full.querySelector('.jp-AgentWorkspace-toolOutput')?.textContent
    ).toContain('line 24');

    const collapsed = renderTurn(completedTurn(blocks), {
      handlers: handlers()
    });
    expect(
      collapsed.querySelector('.jp-AgentWorkspace-activityEvidence')
    ).toBeNull();
  });

  it('keeps the latest running activity visible and older rows compact', () => {
    const blocks: ChatBlock[] = Array.from({ length: 6 }, (_, index) =>
      toolBlock(`tool-${index + 1}`, {
        name: 'Read',
        input: { file_path: `/tmp/file-${index + 1}.ts` },
        output: `file ${index + 1}\n`
      })
    );
    const turn = deriveTurn(createTurn('run-1'), blocks);
    const node = renderTurn(turn, { handlers: handlers() });
    const rows = node.querySelectorAll('.jp-AgentWorkspace-activity');

    expect(rows).toHaveLength(6);
    expect(
      node.querySelectorAll('.jp-AgentWorkspace-activity.is-compact')
    ).toHaveLength(3);
    expect(rows[5].classList.contains('is-current')).toBe(true);
    expect(
      rows[5].querySelector('.jp-AgentWorkspace-activityBody')
    ).not.toBeNull();
  });

  it('keeps a user-expanded older activity expanded while running', () => {
    const blocks: ChatBlock[] = Array.from({ length: 5 }, (_, index) =>
      toolBlock(`tool-${index + 1}`, {
        name: 'Read',
        input: { file_path: `/tmp/file-${index + 1}.ts` }
      })
    );
    let turn = deriveTurn(createTurn('run-1'), blocks);
    turn = toggleActivity(turn, 'activity-tool-1');
    const node = renderTurn(turn, { handlers: handlers() });
    const first = node.querySelector('[data-activity-id="activity-tool-1"]');

    expect(first?.classList.contains('is-compact')).toBe(false);
    expect(
      first?.querySelector('.jp-AgentWorkspace-activityBody')
    ).not.toBeNull();
  });

  it('collapses an automatic record on completion but preserves explicit expansion', () => {
    const blocks: ChatBlock[] = [toolBlock('tool-1')];
    const running = deriveTurn(createTurn('run-1'), blocks);
    const completed = setTurnStatus(running, 'done', blocks);
    const automatic = renderTurn(completed, { handlers: handlers() });

    expect(
      automatic.querySelector('.jp-AgentWorkspace-executionRecord')
    ).toBeNull();

    const explicitlyExpanded = toggleTrace(toggleTrace(running));
    const stillExpanded = setTurnStatus(explicitlyExpanded, 'done', blocks);
    const explicit = renderTurn(stillExpanded, { handlers: handlers() });
    expect(
      explicit.querySelector('.jp-AgentWorkspace-executionRecord')
    ).not.toBeNull();
  });

  it('uses native disclosure buttons with assistive expansion state', () => {
    let turn = setTurnStatus(createTurn('run-1'), 'done', [
      toolBlock('tool-1')
    ]);
    turn = {
      ...turn,
      presentation: {
        ...turn.presentation,
        trace: 'expanded'
      }
    };
    const options = { handlers: handlers() };
    const node = renderTurn(turn, options);
    const button = node.querySelector<HTMLButtonElement>(
      '[data-turn-focus-key="activity:activity-tool-1"]'
    );

    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    button?.click();
    expect(options.handlers.onToggleActivity).toHaveBeenCalledWith(
      'run-1',
      'activity-tool-1'
    );
  });
});
