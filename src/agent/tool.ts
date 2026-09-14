export function formatToolInput(name: string, input: unknown): string {
  if (input === null || input === undefined || input === '') {
    return '';
  }
  if (typeof input === 'string') {
    return name === 'Bash' ? `$ ${input}` : input;
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return stringify(input);
  }
  const record = input as Record<string, unknown>;
  if (name === 'Bash' && typeof record.command === 'string' && record.command) {
    return `$ ${record.command}`;
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${stringify(value)}`);
    }
  }
  return lines.join('\n') || stringify(input);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
