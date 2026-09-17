import type { ChatBlock } from './protocol';

export type ToolCategory = 'read' | 'search' | 'shell' | 'mutation' | 'unknown';

export interface ToolChange {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface ToolPresentation {
  category: ToolCategory;
  title: string;
  detail: string;
  preview: string;
  hiddenLineCount: number;
  hiddenCharacterCount: number;
  change: ToolChange | null;
}

const PREVIEW_LINE_LIMIT = 12;
const PREVIEW_CHARACTER_LIMIT = 4000;
const SUMMARY_LENGTH_LIMIT = 96;

export function presentTool(
  block: Extract<ChatBlock, { kind: 'tool' }>
): ToolPresentation {
  const input = asRecord(block.input);
  const lineCount = block.lineCount ?? countLines(block.output);
  const byteCount = block.byteCount ?? utf8Bytes(block.output);
  const size = formatBytes(byteCount);
  const duration = formatDuration(block.durationMs);
  const outputMeta = [
    lineCount ? `${lineCount} line${lineCount === 1 ? '' : 's'}` : '',
    size,
    duration
  ]
    .filter(Boolean)
    .join(' | ');
  const preview = makePreview(block.output, block.status === 'error');

  switch (block.name) {
    case 'Read': {
      const path = stringValue(input.file_path) || 'file';
      return {
        category: 'read',
        title: `Read ${compactPath(path)}`,
        detail: outputMeta,
        ...preview,
        change: null
      };
    }
    case 'Glob': {
      const pattern = stringValue(input.pattern) || '*';
      const matches = nonEmptyLines(block.output).length;
      return {
        category: 'search',
        title: `Glob ${truncate(pattern)}`,
        detail: [matches ? `${matches} files` : '', outputMeta]
          .filter(Boolean)
          .join(' | '),
        ...preview,
        change: null
      };
    }
    case 'Grep': {
      const pattern = stringValue(input.pattern) || '';
      const matches = nonEmptyLines(block.output);
      const files = countGrepFiles(matches);
      return {
        category: 'search',
        title: `Grep ${truncate(pattern || 'pattern')}`,
        detail: [
          matches.length ? `${matches.length} matches` : '',
          files ? `${files} files` : '',
          outputMeta
        ]
          .filter(Boolean)
          .join(' | '),
        ...preview,
        change: null
      };
    }
    case 'Bash': {
      const command =
        stringValue(input.command) ||
        (typeof block.input === 'string' ? block.input : '');
      return {
        category: 'shell',
        title: `Bash ${truncate(firstLine(command) || 'command')}`,
        detail: outputMeta,
        ...preview,
        change: null
      };
    }
    case 'Edit':
    case 'Write': {
      const path = stringValue(input.file_path) || 'file';
      const change = {
        path,
        additions: countDiffLines(block.output, '+'),
        deletions: countDiffLines(block.output, '-')
      };
      return {
        category: 'mutation',
        title: `${block.name} ${compactPath(path)}`,
        detail: [formatChange(change), outputMeta].filter(Boolean).join(' | '),
        ...preview,
        change
      };
    }
    default:
      return {
        category: 'unknown',
        title: block.name || 'Tool',
        detail: outputMeta,
        ...preview,
        change: null
      };
  }
}

function makePreview(
  output: string,
  preferTail: boolean
): {
  preview: string;
  hiddenLineCount: number;
  hiddenCharacterCount: number;
} {
  if (!output) {
    return { preview: '', hiddenLineCount: 0, hiddenCharacterCount: 0 };
  }
  const lines = output.split('\n');
  const selected = preferTail
    ? lines.slice(Math.max(0, lines.length - PREVIEW_LINE_LIMIT))
    : lines.slice(0, PREVIEW_LINE_LIMIT);
  const linePreview = selected.join('\n');
  const preview =
    linePreview.length > PREVIEW_CHARACTER_LIMIT
      ? preferTail
        ? linePreview.slice(-PREVIEW_CHARACTER_LIMIT)
        : linePreview.slice(0, PREVIEW_CHARACTER_LIMIT)
      : linePreview;
  return {
    preview,
    hiddenLineCount: Math.max(0, lines.length - selected.length),
    hiddenCharacterCount: Math.max(0, output.length - preview.length)
  };
}

function countDiffLines(output: string, marker: '+' | '-'): number | null {
  const lines = output.split('\n');
  const hasHeaders = lines.some(
    line => line.startsWith('+++ ') || line.startsWith('--- ')
  );
  if (!hasHeaders) return null;
  return lines.filter(
    line =>
      line.startsWith(marker) &&
      !line.startsWith(`${marker}${marker}${marker} `)
  ).length;
}

function countGrepFiles(lines: string[]): number {
  const files = new Set<string>();
  lines.forEach(line => {
    const match = /^([^:]+):/.exec(line);
    if (match) files.add(match[1]);
  });
  return files.size;
}

function formatChange(change: ToolChange): string {
  if (change.additions === null && change.deletions === null) return '';
  return `+${change.additions ?? 0} -${change.deletions ?? 0}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join('/')}`;
}

function firstLine(value: string): string {
  return value.split('\n', 1)[0] ?? '';
}

function truncate(value: string): string {
  return value.length <= SUMMARY_LENGTH_LIMIT
    ? value
    : `${value.slice(0, SUMMARY_LENGTH_LIMIT - 3)}...`;
}

function countLines(value: string): number {
  return value ? value.split('\n').length : 0;
}

function nonEmptyLines(value: string): string[] {
  return value.split('\n').filter(line => line.trim());
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(value: number): string {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}
