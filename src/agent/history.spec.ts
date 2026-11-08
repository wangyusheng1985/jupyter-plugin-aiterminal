import { WorkspaceInputHistory } from './history';

describe('WorkspaceInputHistory', () => {
  it('stores non-empty inputs oldest to newest and collapses consecutive duplicates', () => {
    const history = new WorkspaceInputHistory();

    expect(history.add('')).toBe(false);
    expect(history.add('   ')).toBe(false);
    expect(history.add('first')).toBe(true);
    expect(history.add('first')).toBe(false);
    expect(history.add('second')).toBe(true);
    expect(history.add('first')).toBe(true);

    expect(history.values).toEqual(['first', 'second', 'first']);
  });

  it('replaces entries when restoring persisted history', () => {
    const history = new WorkspaceInputHistory();
    history.add('old');

    history.restore([' first ', '', 'second', 'second']);

    expect(history.values).toEqual(['first', 'second']);
    expect(history.browsing).toBe(false);
    expect(history.previous('draft')).toEqual({
      source: 'second',
      browsing: true
    });
  });

  it('navigates from the draft through newer to older entries', () => {
    const history = new WorkspaceInputHistory();
    history.add('first');
    history.add('second');
    history.add('third');

    expect(history.previous('draft')).toEqual({
      source: 'third',
      browsing: true
    });
    expect(history.previous('ignored while browsing')).toEqual({
      source: 'second',
      browsing: true
    });
    expect(history.previous('ignored while browsing')).toEqual({
      source: 'first',
      browsing: true
    });
    expect(history.previous('ignored while browsing')).toEqual({
      source: 'first',
      browsing: true
    });
  });

  it('restores the captured draft after moving past the newest entry', () => {
    const history = new WorkspaceInputHistory();
    history.add('first');
    history.add('second');

    history.previous('unfinished command');
    expect(history.previous('ignored')).toEqual({
      source: 'first',
      browsing: true
    });
    expect(history.next()).toEqual({
      source: 'second',
      browsing: true
    });
    expect(history.next()).toEqual({
      source: 'unfinished command',
      browsing: false
    });
    expect(history.browsing).toBe(false);
    expect(history.next()).toBeNull();
  });

  it('resets browsing and captures a new draft on the next navigation', () => {
    const history = new WorkspaceInputHistory();
    history.add('first');
    history.add('second');

    expect(history.previous('old draft')?.source).toBe('second');
    history.resetNavigation();
    expect(history.browsing).toBe(false);
    expect(history.next()).toBeNull();
    expect(history.previous('new draft')?.source).toBe('second');

    history.add('third');
    expect(history.browsing).toBe(false);
    expect(history.next()).toBeNull();
    expect(history.previous('after add')).toEqual({
      source: 'third',
      browsing: true
    });
  });
});
