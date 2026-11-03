import {
  renderMarkdown,
  type IRenderMimeRegistry
} from '@jupyterlab/rendermime';

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

describe('thinking activity rendering', () => {
  function thinkingBlock(
    id: string,
    overrides: Partial<Extract<ChatBlock, { kind: 'thinking' }>> = {}
  ): Extract<ChatBlock, { kind: 'thinking' }> {
    return {
      kind: 'thinking',
      id,
      status: 'finished',
      text: 'Weighing the options',
      ...overrides
    };
  }

  function activityRow(node: HTMLElement, id: string): HTMLElement | null {
    return node.querySelector<HTMLElement>(
      `[data-activity-id="activity-${id}"]`
    );
  }

  it('keeps the thought body collapsed until its row is expanded', () => {
    const base = toggleTrace(
      completedTurn([thinkingBlock('think-1'), toolBlock('tool-1')])
    );

    const collapsed = renderTurn(base, { handlers: handlers() });
    const collapsedRow = activityRow(collapsed, 'think-1');
    expect(collapsedRow).not.toBeNull();
    expect(
      collapsedRow?.querySelector('.jp-AgentWorkspace-stepOperation strong')
        ?.textContent
    ).toBe('Thought');
    expect(
      collapsedRow?.querySelector('.jp-AgentWorkspace-stepResult')?.textContent
    ).toBe('Completed');
    expect(
      collapsedRow?.querySelector('.jp-AgentWorkspace-thoughtContent')
    ).toBeNull();

    const expanded = renderTurn(toggleActivity(base, 'activity-think-1'), {
      handlers: handlers()
    });
    const body = expanded
      .querySelector('[data-activity-id="activity-think-1"]')
      ?.querySelector<HTMLElement>('.jp-AgentWorkspace-thoughtContent');
    expect(body?.textContent).toBe('Weighing the options');
    expect(body?.classList.contains('is-placeholder')).toBe(false);
  });

  it('labels a streaming thought as Thinking/Running until it finishes', () => {
    const running = toggleActivity(
      deriveTurn(createTurn('run-1'), [
        thinkingBlock('think-running', { status: 'started' })
      ]),
      'activity-think-running'
    );
    const node = renderTurn(running, { handlers: handlers() });
    const row = activityRow(node, 'think-running');

    expect(
      row?.querySelector('.jp-AgentWorkspace-stepOperation strong')?.textContent
    ).toBe('Thinking');
    expect(
      row?.querySelector('.jp-AgentWorkspace-stepResult')?.textContent
    ).toBe('Running');
    expect(
      row?.querySelector('.jp-AgentWorkspace-thoughtContent')?.textContent
    ).toBe('Weighing the options');
  });

  it('shows a status-aware placeholder when no reasoning text was captured', () => {
    const running = toggleActivity(
      deriveTurn(createTurn('run-1'), [
        thinkingBlock('think-empty', { status: 'started', text: '' })
      ]),
      'activity-think-empty'
    );
    const runningBody = renderTurn(running, {
      handlers: handlers()
    }).querySelector<HTMLElement>(
      '[data-activity-id="activity-think-empty"] .jp-AgentWorkspace-thoughtContent'
    );
    expect(runningBody?.classList.contains('is-placeholder')).toBe(true);
    expect(runningBody?.textContent).toBe('Thinking…');

    const finished = toggleActivity(
      toggleTrace(
        completedTurn([thinkingBlock('think-empty-2', { text: '   ' })])
      ),
      'activity-think-empty-2'
    );
    const finishedBody = renderTurn(finished, {
      handlers: handlers()
    }).querySelector<HTMLElement>(
      '[data-activity-id="activity-think-empty-2"] .jp-AgentWorkspace-thoughtContent'
    );
    expect(finishedBody?.classList.contains('is-placeholder')).toBe(true);
    expect(finishedBody?.textContent).toBe('Reasoning completed');
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
    const turn = deriveTurn(createTurn('run-1'), [
      { kind: 'text', id: 'text-1', text: 'Hello stream' }
    ]);
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
    const first = deriveTurn(createTurn('run-1'), [
      { kind: 'text', id: 'text-1', text: 'Hello' }
    ]);
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
    let turn = deriveTurn(createTurn('run-1'), [
      { kind: 'text', id: 'text-1', text: 'Streaming so far' },
      toolBlock('tool-1', { status: 'running' })
    ]);
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
    const turn = deriveTurn(createTurn('run-1'), [
      { kind: 'text', id: 'text-stream', text: 'Streaming answer.' }
    ]);
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
