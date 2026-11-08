import type { ChatBlock } from './protocol';
import { presentTool } from './tool-presenter';

function tool(
  overrides: Partial<Extract<ChatBlock, { kind: 'tool' }>> = {}
): Extract<ChatBlock, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id: 'tool-1',
    name: 'Read',
    input: {},
    output: '',
    status: 'done',
    ...overrides
  };
}

describe('presentTool', () => {
  it('summarizes reads with path, lines, size, and duration', () => {
    const presentation = presentTool(
      tool({
        name: 'Read',
        input: { file_path: '/tmp/project/src/workspace.ts' },
        output: 'one\ntwo\n',
        lineCount: 2,
        byteCount: 8,
        durationMs: 1200
      })
    );
    expect(presentation).toMatchObject({
      category: 'read',
      title: 'Read .../src/workspace.ts',
      detail: '2 lines | 8 B | 1.2 s'
    });
  });

  it('counts grep matches and files', () => {
    const presentation = presentTool(
      tool({
        name: 'Grep',
        input: { pattern: 'TODO' },
        output: 'src/a.ts:1:TODO\nsrc/a.ts:2:TODO\nsrc/b.ts:4:TODO\n'
      })
    );
    expect(presentation.detail).toContain('3 matches');
    expect(presentation.detail).toContain('2 files');
  });

  it('summarizes bash commands with their first line', () => {
    const presentation = presentTool(
      tool({
        name: 'Bash',
        input: { command: 'npm test\nnpm run build' },
        output: 'ok\n'
      })
    );
    expect(presentation.title).toBe('Bash npm test');
    expect(presentation.category).toBe('shell');
  });

  it('extracts diff statistics for mutations', () => {
    const presentation = presentTool(
      tool({
        name: 'Edit',
        input: { file_path: '/tmp/a.ts' },
        output: '--- a.ts\n+++ a.ts\n-old\n+new\n+more\n'
      })
    );
    expect(presentation.change).toEqual({
      path: '/tmp/a.ts',
      additions: 2,
      deletions: 1
    });
    expect(presentation.detail).toContain('+2 -1');
  });

  it('uses the output tail for failed tools and records hidden lines', () => {
    const output = Array.from(
      { length: 20 },
      (_, index) => `line ${index}`
    ).join('\n');
    const presentation = presentTool(
      tool({
        name: 'Bash',
        input: { command: 'false' },
        output,
        status: 'error'
      })
    );
    expect(presentation.preview.startsWith('line 8')).toBe(true);
    expect(presentation.hiddenLineCount).toBe(8);
  });

  it('bounds a very large single-line output', () => {
    const output = 'x'.repeat(10_000);
    const presentation = presentTool(
      tool({ name: 'Bash', input: { command: 'cat huge.txt' }, output })
    );

    expect(presentation.preview).toHaveLength(4000);
    expect(presentation.hiddenLineCount).toBe(0);
    expect(presentation.hiddenCharacterCount).toBeGreaterThan(5000);
  });

  it('falls back to a generic summary for unknown tools', () => {
    const presentation = presentTool(
      tool({ name: 'WebSearch', input: { query: 'x' }, output: 'result' })
    );
    expect(presentation).toMatchObject({
      category: 'unknown',
      title: 'WebSearch',
      preview: 'result'
    });
  });
});
