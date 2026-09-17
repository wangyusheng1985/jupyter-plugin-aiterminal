export const INPUT_HISTORY_STORAGE_PREFIX =
  'jupyter-aiterminal:input-history:v1:';
export const LEGACY_COMMAND_HISTORY_STORAGE_PREFIX =
  'jupyter-aiterminal:command-history:v1:';
export const MAX_INPUT_HISTORY_ENTRIES = 200;
export const MAX_INPUT_HISTORY_BYTES = 64 * 1024;

export interface InputHistoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function inputHistoryStorageKey(workspacePath: string): string {
  return `${INPUT_HISTORY_STORAGE_PREFIX}${encodeURIComponent(workspacePath)}`;
}

export function legacyCommandHistoryStorageKey(workspacePath: string): string {
  return `${LEGACY_COMMAND_HISTORY_STORAGE_PREFIX}${encodeURIComponent(
    workspacePath
  )}`;
}

export class InputHistoryStorage {
  constructor(
    private readonly storage: InputHistoryStorageLike | null = browserStorage()
  ) {}

  load(workspacePath: string): string[] {
    if (!this.storage) return [];
    try {
      const key = inputHistoryStorageKey(workspacePath);
      const raw = this.storage.getItem(key);
      if (raw !== null) return parseEntries(raw);

      const legacyKey = legacyCommandHistoryStorageKey(workspacePath);
      const legacyRaw = this.storage.getItem(legacyKey);
      if (legacyRaw === null) return [];

      const migrated = parseEntries(legacyRaw);
      try {
        this.storage.setItem(key, JSON.stringify(migrated));
      } catch {
        // Keep migrated entries in memory when the unified write fails.
      }
      return migrated;
    } catch {
      return [];
    }
  }

  save(workspacePath: string, entries: readonly string[]): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(
        inputHistoryStorageKey(workspacePath),
        JSON.stringify(boundedEntries(entries))
      );
    } catch {
      // Storage can be unavailable in private contexts or full for this origin.
    }
  }
}

function browserStorage(): InputHistoryStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseEntries(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? boundedEntries(parsed) : [];
  } catch {
    return [];
  }
}

function boundedEntries(source: readonly unknown[]): string[] {
  const entries: string[] = [];
  source.forEach(value => {
    if (typeof value !== 'string') return;
    const input = value.trim();
    if (input) entries.push(input);
  });

  const bounded = entries.slice(-MAX_INPUT_HISTORY_ENTRIES);
  while (
    bounded.length > 0 &&
    utf8Length(JSON.stringify(bounded)) > MAX_INPUT_HISTORY_BYTES
  ) {
    bounded.shift();
  }
  return bounded;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
