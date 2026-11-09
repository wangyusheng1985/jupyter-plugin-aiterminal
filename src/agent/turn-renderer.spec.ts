import {
  renderMarkdown,
  type IRenderMimeRegistry
} from '@jupyterlab/rendermime';

import type { ChatBlock } from './protocol';
import {
  applyTurnEvent,
  createTurn,
  deriveTurn,
  restoreTurn,
  setTurnStatus,
  toggleActivity,
  toggleTrace,
  toPersistedTurn,
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
    onRevealFailure: jest.fn(),
    onRetry: jest.fn()
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

  it('renders the complete outcome without preview or disclosure controls', () => {
    const longText = Array.from(
      { length: 60 },
      (_, index) => `line ${index + 1}`
    ).join('\n');
    const turn = completedTurn([
      { kind: 'text', id: 'text-long', text: longText }
    ]);
    const node = renderTurn(turn, { handlers: handlers() });
    const body = node.querySelector('.jp-AgentWorkspace-outcomeBody');

    expect(body?.textContent).toContain('line 1');
    expect(body?.textContent).toContain('line 60');
    expect(body?.classList.contains('is-preview')).toBe(false);
    expect(node.querySelector('[data-turn-focus-key^="outcome:"]')).toBeNull();
    expect(node.textContent).not.toContain('Show full result');
    expect(node.textContent).not.toContain('Show less');
  });

  it('keeps terminal errors visible while the record stays collapsed', () => {
    const blocks: ChatBlock[] = [
      toolBlock('tool-1', { status: 'error', output: 'boom\n' })
    ];
    const turn = applyTurnEvent(createTurn('run-failed'), blocks, {
      type: 'result',
      turnId: 'run-failed',
      text: '',
      isError: true,
      reason: 'failed',
      durationMs: 900
    });
    const node = renderTurn(turn, { handlers: handlers() });

    expect(node.querySelector('.jp-AgentWorkspace-executionRecord')).toBeNull();
    expect(
      node.querySelector('.jp-AgentWorkspace-terminalNotice')?.textContent
    ).toBe('Run failed before producing a response.');
    expect(node.querySelector('[data-failure-navigation]')?.textContent).toBe(
      '1 step failed'
    );
  });

  it('keeps representative Markdown semantics inside the scoped outcome', () => {
    jest.mocked(renderMarkdown).mockImplementationOnce(options => {
      options.host.innerHTML = `
        <h2>Summary</h2>
        <p>Introductory paragraph.</p>
        <ul>
          <li>
            <p>Primary item</p>
            <ul><li>Nested item</li></ul>
          </li>
        </ul>
        <pre><code>const ready = true;</code></pre>
        <table><tbody><tr><td>value</td></tr></tbody></table>
      `;
      return Promise.resolve();
    });
    const turn = completedTurn([
      {
        kind: 'text',
        id: 'text-semantic',
        text: '## Summary\n\n- Primary item'
      }
    ]);

    const node = renderTurn(turn, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    const body = node.querySelector('.jp-AgentWorkspace-outcomeBody');

    expect(body?.classList.contains('jp-AgentWorkspace-outcomeBody')).toBe(
      true
    );
    expect(body?.classList.contains('jp-RenderedHTMLCommon')).toBe(true);
    expect(body?.classList.contains('jp-RenderedMarkdown')).toBe(true);
    expect(body?.querySelector('h2')?.textContent).toBe('Summary');
    expect(body?.querySelector('li > p')?.textContent).toBe('Primary item');
    expect(body?.querySelector('li > ul > li')?.textContent).toBe(
      'Nested item'
    );
    expect(body?.querySelector('pre code')?.textContent).toContain('ready');
    expect(body?.querySelector('table td')?.textContent).toBe('value');
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
    const turn = toggleTrace(deriveTurn(createTurn('run-1'), blocks));
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
    let turn = toggleTrace(deriveTurn(createTurn('run-1'), blocks));
    turn = toggleActivity(turn, 'activity-tool-1');
    const node = renderTurn(turn, { handlers: handlers() });
    const first = node.querySelector('[data-activity-id="activity-tool-1"]');

    expect(first?.classList.contains('is-compact')).toBe(false);
    expect(
      first?.querySelector('.jp-AgentWorkspace-activityBody')
    ).not.toBeNull();
  });

  it('defaults new and completed records collapsed but preserves explicit expansion', () => {
    const blocks: ChatBlock[] = [toolBlock('tool-1')];
    const running = deriveTurn(createTurn('run-1'), blocks);
    const completed = setTurnStatus(running, 'done', blocks);

    const runningNode = renderTurn(running, { handlers: handlers() });
    expect(
      runningNode.querySelector('.jp-AgentWorkspace-executionRecord')
    ).toBeNull();
    expect(
      runningNode
        .querySelector('[data-turn-focus-key="trace:run-1"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false');

    const automatic = renderTurn(completed, { handlers: handlers() });
    expect(
      automatic.querySelector('.jp-AgentWorkspace-executionRecord')
    ).toBeNull();

    const explicitlyExpanded = toggleTrace(completed);
    const explicit = renderTurn(explicitlyExpanded, { handlers: handlers() });
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

  it('offers retry for failed or interrupted turns but not successful turns', () => {
    const failedHandlers = handlers();
    const failedBlocks: ChatBlock[] = [
      toolBlock('tool-failed', { status: 'error', output: 'failed' })
    ];
    const failed = setTurnStatus(
      createTurn('run-failed'),
      'done',
      failedBlocks
    );
    const failedNode = renderTurn(failed, { handlers: failedHandlers });
    const retry = failedNode.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-retryTurn'
    );
    expect(retry?.textContent).toBe('Retry as new turn');
    retry?.click();
    expect(failedHandlers.onRetry).toHaveBeenCalledWith('run-failed');

    const interrupted = setTurnStatus(
      createTurn('run-interrupted'),
      'interrupted',
      []
    );
    expect(
      renderTurn(interrupted, { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-retryTurn'
      )
    ).not.toBeNull();

    const successful = setTurnStatus(createTurn('run-success'), 'done', [
      toolBlock('tool-success')
    ]);
    expect(
      renderTurn(successful, { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-retryTurn'
      )
    ).toBeNull();
  });
});

describe('terminal reason notice', () => {
  function turnWithReason(
    id: string,
    reason: ChatTurn['terminalReason'],
    blocks: ChatBlock[] = [],
    status: ChatTurn['status'] = 'done'
  ): ChatTurn {
    const base = setTurnStatus(createTurn(id), status, blocks);
    return { ...base, terminalReason: reason };
  }

  it.each(['cancelled', 'budget-exhausted', 'failed'] as const)(
    'shows a standalone accessible notice for a %s turn beside the partial answer',
    reason => {
      const turn = turnWithReason(
        'run-1',
        reason,
        [{ kind: 'text', id: 'text-1', text: 'Partial answer text.' }],
        'interrupted'
      );
      const node = renderTurn(turn, { handlers: handlers() });
      const notice = node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-terminalNotice'
      );

      expect(notice?.getAttribute('role')).toBe('status');
      expect(notice?.dataset.terminalReason).toBe(reason);
      expect(notice?.textContent?.length).toBeGreaterThan(0);

      // The partial answer stays the outcome; the notice never replaces it.
      const outcome = node.querySelector('.jp-AgentWorkspace-outcomeBody');
      expect(outcome?.textContent).toContain('Partial answer text.');
      expect(outcome?.textContent).not.toContain(notice?.textContent ?? '');
    }
  );

  it('states explicit completion when a completed turn produced no response', () => {
    const node = renderTurn(turnWithReason('run-1', 'completed'), {
      handlers: handlers()
    });
    const notice = node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-terminalNotice'
    );

    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain(
      'completed without producing a response'
    );
    expect(node.querySelector('.jp-AgentWorkspace-outcome')).toBeNull();
  });

  it('does not add a notice to a completed turn that produced a response', () => {
    const turn = turnWithReason('run-1', 'completed', [
      { kind: 'text', id: 'text-1', text: 'Final answer.' }
    ]);
    expect(
      renderTurn(turn, { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-terminalNotice'
      )
    ).toBeNull();
  });

  it('leaves legacy turns without a terminal reason unchanged', () => {
    const legacy = completedTurn([
      { kind: 'text', id: 'text-1', text: 'Legacy answer.' }
    ]);
    expect(legacy.terminalReason).toBeUndefined();
    expect(
      renderTurn(legacy, { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-terminalNotice'
      )
    ).toBeNull();
  });

  it('re-renders the same notice after a persistence round-trip', () => {
    const original = turnWithReason('run-1', 'cancelled');
    const restored = restoreTurn(toPersistedTurn(original));
    expect(restored).not.toBeNull();
    expect(restored?.terminalReason).toBe('cancelled');

    const before = renderTurn(original, { handlers: handlers() }).querySelector(
      '.jp-AgentWorkspace-terminalNotice'
    );
    const after = renderTurn(restored as ChatTurn, {
      handlers: handlers()
    }).querySelector<HTMLElement>('.jp-AgentWorkspace-terminalNotice');

    expect(after?.textContent).toBe(before?.textContent);
    expect(after?.dataset.terminalReason).toBe('cancelled');
  });

  it('never renders arbitrary text for an unknown terminal reason', () => {
    const turn: ChatTurn = {
      ...setTurnStatus(createTurn('run-1'), 'done', []),
      terminalReason: 'mystery' as unknown as ChatTurn['terminalReason']
    };
    expect(
      renderTurn(turn, { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-terminalNotice'
      )
    ).toBeNull();
  });

  describe('real ACP event sequence where result text stays empty', () => {
    function streamedTurn(
      reason: ChatTurn['terminalReason'],
      text: string
    ): { turn: ChatTurn; blocks: ChatBlock[] } {
      const blocks: ChatBlock[] = [{ kind: 'text', id: 'text-1', text }];
      let turn = createTurn('run-1');
      turn = applyTurnEvent(turn, blocks, {
        type: 'text',
        turnId: 'run-1',
        text
      });
      turn = applyTurnEvent(turn, blocks, {
        type: 'result',
        turnId: 'run-1',
        text: '',
        reason
      });
      return { turn, blocks };
    }

    it('does not claim a completed run produced no response when text streamed', () => {
      const { turn } = streamedTurn('completed', 'Streamed answer.');
      expect(turn.resultText).toBe('');
      expect(turn.outcomeKind).toBe('assistant');
      const node = renderTurn(turn, { handlers: handlers() });
      expect(
        node.querySelector('.jp-AgentWorkspace-terminalNotice')
      ).toBeNull();
      expect(
        node.querySelector('.jp-AgentWorkspace-outcomeBody')?.textContent
      ).toContain('Streamed answer.');
    });

    it.each(['cancelled', 'budget-exhausted', 'failed'] as const)(
      'states the stop reason without the no-response wording for a %s turn with streamed text',
      reason => {
        const { turn } = streamedTurn(reason, 'Partial streamed answer.');
        expect(turn.resultText).toBe('');
        const node = renderTurn(turn, { handlers: handlers() });
        const notice = node.querySelector<HTMLElement>(
          '.jp-AgentWorkspace-terminalNotice'
        );
        expect(notice?.dataset.terminalReason).toBe(reason);
        expect(notice?.textContent).not.toContain(
          'without producing a response'
        );
        expect(notice?.textContent).not.toContain(
          'before producing a response'
        );
        expect(
          node.querySelector('.jp-AgentWorkspace-outcomeBody')?.textContent
        ).toContain('Partial streamed answer.');
      }
    );

    it('keeps the streamed answer and notice after a persistence round-trip', () => {
      const { turn, blocks } = streamedTurn('failed', 'Streamed answer.');
      const restored = restoreTurn(toPersistedTurn(turn));
      expect(restored).not.toBeNull();
      const reopened = deriveTurn(restored as ChatTurn, blocks);
      expect(reopened.resultText).toBe('');
      expect(reopened.outcomeKind).toBe('assistant');

      const node = renderTurn(reopened, { handlers: handlers() });
      expect(
        node.querySelector<HTMLElement>('.jp-AgentWorkspace-terminalNotice')
          ?.textContent
      ).toBe('Run failed before finishing.');
      expect(
        node.querySelector('.jp-AgentWorkspace-outcomeBody')?.textContent
      ).toContain('Streamed answer.');
    });

    it('does not count tool output as a response for a completed turn', () => {
      const blocks: ChatBlock[] = [toolBlock('tool-1')];
      let turn = createTurn('run-1');
      turn = applyTurnEvent(turn, blocks, {
        type: 'tool_end',
        turnId: 'run-1',
        id: 'tool-1',
        name: 'Bash',
        output: '/tmp\n'
      });
      turn = applyTurnEvent(turn, blocks, {
        type: 'result',
        turnId: 'run-1',
        text: '',
        reason: 'completed'
      });
      expect(turn.resultText).toBe('');
      expect(turn.outcomeKind).toBe('tool');
      expect(
        renderTurn(turn, { handlers: handlers() }).querySelector<HTMLElement>(
          '.jp-AgentWorkspace-terminalNotice'
        )?.textContent
      ).toContain('completed without producing a response');
    });

    it('does not count thinking as a response for a completed turn', () => {
      const blocks: ChatBlock[] = [
        { kind: 'thinking', id: 'think-1', status: 'finished' }
      ];
      let turn = createTurn('run-1');
      turn = applyTurnEvent(turn, blocks, {
        type: 'thinking',
        turnId: 'run-1',
        id: 'think-1',
        state: 'finished'
      });
      turn = applyTurnEvent(turn, blocks, {
        type: 'result',
        turnId: 'run-1',
        text: '',
        reason: 'completed'
      });
      expect(turn.resultText).toBe('');
      expect(turn.outcomeKind).toBe('none');
      expect(
        renderTurn(turn, { handlers: handlers() }).querySelector<HTMLElement>(
          '.jp-AgentWorkspace-terminalNotice'
        )?.textContent
      ).toContain('completed without producing a response');
    });
  });
});

describe('streaming text rendering', () => {
  function textBody(node: HTMLElement): HTMLElement | null {
    return node.querySelector<HTMLElement>('.jp-AgentWorkspace-activityBody');
  }

  beforeEach(() => {
    jest.mocked(renderMarkdown).mockReset();
    jest.mocked(renderMarkdown).mockImplementation(options => {
      options.host.innerHTML = options.source ? '<p>markdown</p>' : '';
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    jest.mocked(renderMarkdown).mockReset();
  });

  it('renders the running tail synchronously without Markdown parsing', () => {
    const turn = toggleTrace(
      deriveTurn(createTurn('run-1'), [
        { kind: 'text', id: 'text-1', text: 'Hello stream' }
      ])
    );
    const node = renderTurn(turn, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    const body = textBody(node);
    expect(
      body?.querySelector('.jp-AgentWorkspace-streamingText')?.textContent
    ).toBe('Hello stream');
    expect(body?.querySelector('p')).toBeNull();
    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  it('grows across deltas without duplicating the full text', () => {
    const first = toggleTrace(
      deriveTurn(createTurn('run-1'), [
        { kind: 'text', id: 'text-1', text: 'Hello' }
      ])
    );
    const second = deriveTurn(first, [
      { kind: 'text', id: 'text-1', text: 'Hello world' }
    ]);
    const firstNode = renderTurn(first, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    const secondNode = renderTurn(second, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    expect(textBody(firstNode)?.textContent).toBe('Hello');
    expect(textBody(secondNode)?.textContent).toBe('Hello world');
    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  it('renders the completed answer through Markdown', () => {
    const turn = setTurnStatus(createTurn('run-1'), 'done', [
      { kind: 'text', id: 'text-1', text: 'Final answer' }
    ]);
    const node = renderTurn(turn, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    const outcome = node.querySelector('.jp-AgentWorkspace-outcomeBody');
    expect(outcome?.querySelector('p')?.textContent).toBe('markdown');
    expect(renderMarkdown).toHaveBeenCalled();
  });

  it('turns a trailing text into stable Markdown once a tool starts', () => {
    let turn = toggleTrace(
      deriveTurn(createTurn('run-1'), [
        { kind: 'text', id: 'text-1', text: 'Streaming so far' },
        toolBlock('tool-1', { status: 'running' })
      ])
    );
    turn = toggleActivity(turn, 'activity-text-1');
    const node = renderTurn(turn, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    const body = textBody(node);
    expect(body?.querySelector('.jp-AgentWorkspace-streamingText')).toBeNull();
    expect(body?.querySelector('p')?.textContent).toBe('markdown');
    expect(renderMarkdown).toHaveBeenCalled();
  });

  it.each(['error', 'interrupted'] as const)(
    'renders the final answer as Markdown for a %s turn',
    status => {
      const turn = setTurnStatus(createTurn('run-1'), status, [
        { kind: 'text', id: 'text-1', text: 'Partial answer' }
      ]);
      const node = renderTurn(turn, {
        rendermime: {} as IRenderMimeRegistry,
        handlers: handlers()
      });
      const outcome = node.querySelector('.jp-AgentWorkspace-outcomeBody');
      expect(outcome?.querySelector('p')?.textContent).toBe('markdown');
      expect(renderMarkdown).toHaveBeenCalled();
    }
  );
});

describe('Markdown host whitespace', () => {
  const fs = jest.requireActual<{
    readFileSync: (file: string, encoding: string) => string;
  }>('fs');
  const nodePath = jest.requireActual<{
    resolve: (...parts: string[]) => string;
  }>('path');
  const cwd = jest.requireActual<{ cwd: () => string }>('process').cwd();
  const baseCss = fs
    .readFileSync(nodePath.resolve(cwd, 'style/base.css'), 'utf8')
    // jsdom does not parse @container, so downgrade it to @media for the DOM
    // cascade check while every selector and declaration stays the file's own.
    .replace(/@container[^{]*\{/g, '@media all {');
  let style: HTMLStyleElement;

  const representativeMarkdown = `
    <p>First line
second line</p>
    <ul><li><p>Primary item</p></li></ul>
    <p>Inline <code>const  spaced</code> code.</p>
    <pre><code>const ready = true;
const done = false;</code></pre>
  `;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = baseCss;
    document.head.append(style);
    jest.mocked(renderMarkdown).mockImplementation(options => {
      options.host.innerHTML = options.source ? representativeMarkdown : '';
      return Promise.resolve();
    });
  });

  afterEach(() => {
    style.remove();
    document.body.replaceChildren();
    jest.mocked(renderMarkdown).mockReset();
  });

  it('keeps outcome prose normal while preserving preformatted blocks', () => {
    const node = renderTurn(completedTurn([toolBlock('tool-1')]), {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    document.body.append(node);

    const body = node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-outcomeBody'
    );
    expect(body).not.toBeNull();
    expect(getComputedStyle(body!).whiteSpace).toBe('normal');
    expect(getComputedStyle(body!.querySelector('pre')!).whiteSpace).toBe(
      'pre-wrap'
    );
    expect(getComputedStyle(body!.querySelector('p > code')!).whiteSpace).toBe(
      'normal'
    );
    expect(body!.querySelector('p')?.textContent).toContain(
      'First line\nsecond line'
    );
    expect(body!.querySelector('li > p')?.textContent).toBe('Primary item');
    expect(body!.querySelector('pre code')?.textContent).toContain(
      'const ready = true;'
    );
  });

  it('renders the running streamed tail as synchronous pre-wrapped text', () => {
    const turn = toggleTrace(
      deriveTurn(createTurn('run-1'), [
        { kind: 'text', id: 'text-stream', text: 'Streaming answer.' }
      ])
    );
    const node = renderTurn(turn, {
      rendermime: {} as IRenderMimeRegistry,
      handlers: handlers()
    });
    document.body.append(node);

    const body = node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-activityBody'
    );
    expect(body).not.toBeNull();
    expect(getComputedStyle(body!).whiteSpace).toBe('normal');
    const stream = body!.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-streamingText'
    );
    expect(stream).not.toBeNull();
    expect(getComputedStyle(stream!).whiteSpace).toBe('pre-wrap');
    expect(stream!.textContent).toBe('Streaming answer.');
    expect(renderMarkdown).not.toHaveBeenCalled();
  });
});

describe('outcome Markdown copy', () => {
  const markdown = [
    '# 标题',
    '',
    '- item one',
    '- item two',
    '',
    '```ts',
    'const ready = true;',
    '```',
    '',
    '[link](https://example.com)',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |'
  ].join('\n');

  function resultTurn(text: string): ChatTurn {
    return applyTurnEvent(createTurn('run-copy'), [], {
      type: 'result',
      turnId: 'run-copy',
      text,
      reason: 'completed'
    });
  }

  function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(navigator, { clipboard: undefined });
  });

  it('copies the exact pre-render Markdown source instead of the DOM', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const node = renderTurn(resultTurn(markdown), { handlers: handlers() });
    document.body.append(node);

    const button = node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-outcomeCopyButton'
    );
    expect(button).not.toBeNull();
    expect(button!.type).toBe('button');
    expect(button!.getAttribute('aria-label')).toBe('Copy Markdown');
    expect(button!.textContent).toBe('Copy Markdown');

    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    // renderMarkdown is mocked, so an empty DOM still copied the full source.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(markdown);
    const status = node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-outcomeCopyStatus'
    );
    expect(status?.textContent).toBe('Copied');
    expect(status?.getAttribute('role')).toBe('status');
    expect(
      node
        .querySelector('.jp-AgentWorkspace-outcomeActions')
        ?.getAttribute('data-copy-state')
    ).toBe('copied');
    node.remove();
  });

  it('does not copy the DOM when the cell is collapsed', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const turn = resultTurn(markdown);
    expect(turn.presentation.trace).toBe('collapsed');
    const node = renderTurn(turn, { handlers: handlers() });
    document.body.append(node);
    // Collapsed cells still render the full outcome body.
    node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-outcomeCopyButton')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(markdown);
    node.remove();
  });

  it('offers no copy control when the outcome is tool output or empty', () => {
    const toolOutcome = applyTurnEvent(
      createTurn('run-tool'),
      [toolBlock('tool-1')],
      {
        type: 'result',
        turnId: 'run-tool',
        text: '',
        reason: 'completed'
      }
    );
    expect(toolOutcome.outcomeKind).toBe('tool');
    expect(
      renderTurn(toolOutcome, { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-outcomeCopyButton'
      )
    ).toBeNull();

    expect(
      renderTurn(resultTurn('   '), { handlers: handlers() }).querySelector(
        '.jp-AgentWorkspace-outcomeCopyButton'
      )
    ).toBeNull();
  });

  it('falls back to execCommand and still reports success', async () => {
    Object.assign(navigator, { clipboard: undefined });
    const exec = jest.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec
    });
    const node = renderTurn(resultTurn(markdown), { handlers: handlers() });
    document.body.append(node);

    node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-outcomeCopyButton')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(exec).toHaveBeenCalledWith('copy');
    expect(
      node.querySelector<HTMLElement>('.jp-AgentWorkspace-outcomeCopyStatus')
        ?.textContent
    ).toBe('Copied');
    // The temporary textarea must be removed from the document.
    expect(document.querySelector('textarea')).toBeNull();
    node.remove();
  });

  it('reports a failed fallback instead of pretending success', async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: jest.fn().mockReturnValue(false)
    });
    const node = renderTurn(resultTurn(markdown), { handlers: handlers() });
    document.body.append(node);

    node
      .querySelector<HTMLButtonElement>('.jp-AgentWorkspace-outcomeCopyButton')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const status = node.querySelector<HTMLElement>(
      '.jp-AgentWorkspace-outcomeCopyStatus'
    );
    expect(status?.textContent).toBe('Copy failed');
    expect(status?.dataset.copyState).toBe('failed');
    node.remove();
  });

  it('copies again on a second click', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const node = renderTurn(resultTurn(markdown), { handlers: handlers() });
    document.body.append(node);
    const button = node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-outcomeCopyButton'
    )!;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(2, markdown);
    node.remove();
  });
});
