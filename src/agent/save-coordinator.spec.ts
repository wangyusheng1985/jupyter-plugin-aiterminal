import {
  WorkspaceSaveCoordinator,
  type SaveCoordinatorState
} from './save-coordinator';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('WorkspaceSaveCoordinator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts saved, debounces dirty revisions, and skips no-op flushes', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const synchronize = jest.fn();
    const states: SaveCoordinatorState[] = [];
    const coordinator = new WorkspaceSaveCoordinator({
      synchronize,
      save,
      onStateChange: state => states.push(state)
    });

    expect(coordinator.state).toMatchObject({
      phase: 'saved',
      requestedRevision: 0,
      savedRevision: 0
    });
    await coordinator.flush();
    expect(save).not.toHaveBeenCalled();

    coordinator.markDirty();
    coordinator.markDirty();
    expect(coordinator.state).toMatchObject({
      phase: 'pending',
      requestedRevision: 2,
      savedRevision: 0
    });
    expect(save).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(400);

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toMatchObject({
      phase: 'saved',
      requestedRevision: 2,
      savedRevision: 2,
      error: null
    });
    expect(states.map(state => state.phase)).toEqual([
      'pending',
      'pending',
      'saving',
      'saving',
      'saved'
    ]);
  });

  it('coalesces mutations during save without overlapping writes', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const save = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await first.promise;
        active -= 1;
      })
      .mockImplementationOnce(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await second.promise;
        active -= 1;
      });
    const synchronize = jest.fn();
    const coordinator = new WorkspaceSaveCoordinator({ synchronize, save });

    coordinator.markDirty();
    const drain = coordinator.flush();
    coordinator.markDirty();
    const sameDrain = coordinator.flush();

    expect(sameDrain).toBe(drain);
    expect(save).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toMatchObject({
      phase: 'saving',
      requestedRevision: 2,
      savedRevision: 0
    });

    first.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);

    second.resolve(undefined);
    await drain;
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(coordinator.state).toMatchObject({
      phase: 'saved',
      requestedRevision: 2,
      savedRevision: 2
    });
  });

  it('keeps failed revisions dirty and recovers through one retry', async () => {
    const save = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new WorkspaceSaveCoordinator({
      synchronize: jest.fn(),
      save
    });

    coordinator.markDirty();
    await expect(coordinator.flush()).rejects.toThrow('disk unavailable');
    expect(coordinator.state).toMatchObject({
      phase: 'error',
      requestedRevision: 1,
      savedRevision: 0,
      error: 'disk unavailable'
    });

    const retry = coordinator.retry();
    expect(coordinator.retry()).toBe(retry);
    await retry;
    expect(save).toHaveBeenCalledTimes(2);
    expect(coordinator.state).toMatchObject({
      phase: 'saved',
      requestedRevision: 1,
      savedRevision: 1,
      error: null
    });
  });

  it('uses a later mutation to schedule recovery after an in-flight failure', async () => {
    const first = deferred<void>();
    const save = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const coordinator = new WorkspaceSaveCoordinator({
      synchronize: jest.fn(),
      save
    });

    coordinator.markDirty();
    const failed = coordinator.flush();
    coordinator.markDirty();
    first.reject(new Error('first failed'));
    await expect(failed).rejects.toThrow('first failed');
    expect(coordinator.state.phase).toBe('error');

    await jest.advanceTimersByTimeAsync(400);

    expect(save).toHaveBeenCalledTimes(2);
    expect(coordinator.state).toMatchObject({
      phase: 'saved',
      requestedRevision: 2,
      savedRevision: 2
    });
  });

  it('accepts an external saved state only while clean and idle', async () => {
    const coordinator = new WorkspaceSaveCoordinator({
      synchronize: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined)
    });
    expect(coordinator.acceptExternalSavedState()).toBe(true);
    coordinator.markDirty();
    expect(coordinator.acceptExternalSavedState()).toBe(false);
    await coordinator.flush();
    expect(coordinator.acceptExternalSavedState()).toBe(true);
  });
});
