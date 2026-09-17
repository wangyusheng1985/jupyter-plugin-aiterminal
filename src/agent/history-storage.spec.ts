import {
  INPUT_HISTORY_STORAGE_PREFIX,
  InputHistoryStorage,
  MAX_INPUT_HISTORY_BYTES,
  MAX_INPUT_HISTORY_ENTRIES,
  inputHistoryStorageKey,
  legacyCommandHistoryStorageKey,
  type InputHistoryStorageLike
} from './history-storage';

class MemoryStorage implements InputHistoryStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('InputHistoryStorage', () => {
  it('round-trips inputs under a versioned, encoded workspace key', () => {
    const storage = new MemoryStorage();
    const adapter = new InputHistoryStorage(storage);
    const path = 'folder/a workspace.agentnb';

    adapter.save(path, ['ls', 'pwd']);

    expect(inputHistoryStorageKey(path)).toBe(
      `${INPUT_HISTORY_STORAGE_PREFIX}folder%2Fa%20workspace.agentnb`
    );
    expect(storage.getItem(inputHistoryStorageKey(path))).toBe(
      JSON.stringify(['ls', 'pwd'])
    );
    expect(adapter.load(path)).toEqual(['ls', 'pwd']);
  });

  it('ignores malformed data and filters invalid entries', () => {
    const storage = new MemoryStorage();
    const adapter = new InputHistoryStorage(storage);
    const key = inputHistoryStorageKey('work.agentnb');

    storage.setItem(key, 'not-json');
    expect(adapter.load('work.agentnb')).toEqual([]);

    storage.setItem(key, JSON.stringify({ entries: ['pwd'] }));
    expect(adapter.load('work.agentnb')).toEqual([]);

    storage.setItem(
      key,
      JSON.stringify([' pwd ', '', null, 42, { command: 'ls' }, 'ls'])
    );
    expect(adapter.load('work.agentnb')).toEqual(['pwd', 'ls']);
  });

  it('falls back when reads and writes are unavailable', () => {
    const adapter = new InputHistoryStorage({
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      }
    });

    expect(adapter.load('work.agentnb')).toEqual([]);
    expect(() => adapter.save('work.agentnb', ['pwd'])).not.toThrow();
  });

  it('keeps the newest entries within count and byte bounds', () => {
    const storage = new MemoryStorage();
    const adapter = new InputHistoryStorage(storage);
    const entries = Array.from(
      { length: MAX_INPUT_HISTORY_ENTRIES + 1 },
      (_, index) => `command-${index}`
    );

    storage.setItem(
      inputHistoryStorageKey('count.agentnb'),
      JSON.stringify(entries)
    );
    expect(adapter.load('count.agentnb')).toEqual(entries.slice(1));

    const newest = 'x'.repeat(MAX_INPUT_HISTORY_BYTES - 5);
    adapter.save('bytes.agentnb', ['oldest', newest]);
    expect(adapter.load('bytes.agentnb')).toEqual([newest]);
  });

  it('imports legacy command history into the unified key once', () => {
    const storage = new MemoryStorage();
    const adapter = new InputHistoryStorage(storage);
    const path = 'work/legacy.agentnb';
    const legacyKey = legacyCommandHistoryStorageKey(path);
    storage.setItem(legacyKey, JSON.stringify([' pwd ', '', 'ls']));

    expect(adapter.load(path)).toEqual(['pwd', 'ls']);
    expect(storage.getItem(inputHistoryStorageKey(path))).toBe(
      JSON.stringify(['pwd', 'ls'])
    );
    expect(storage.getItem(legacyKey)).toBe(
      JSON.stringify([' pwd ', '', 'ls'])
    );

    storage.setItem(legacyKey, JSON.stringify(['legacy only']));
    expect(adapter.load(path)).toEqual(['pwd', 'ls']);
  });

  it('does not import malformed legacy data', () => {
    const storage = new MemoryStorage();
    const adapter = new InputHistoryStorage(storage);
    const path = 'work/malformed.agentnb';
    storage.setItem(legacyCommandHistoryStorageKey(path), 'not-json');

    expect(adapter.load(path)).toEqual([]);
    expect(storage.getItem(inputHistoryStorageKey(path))).toBe('[]');
  });

  it('keeps migrated entries when the unified write fails', () => {
    const storage = new MemoryStorage();
    const path = 'work/readonly.agentnb';
    storage.setItem(legacyCommandHistoryStorageKey(path), '["pwd"]');
    jest.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(new InputHistoryStorage(storage).load(path)).toEqual(['pwd']);
  });
});
