export type SavePhase = 'saved' | 'pending' | 'saving' | 'error';

export interface SaveCoordinatorState {
  phase: SavePhase;
  requestedRevision: number;
  savedRevision: number;
  error: string | null;
}

export interface SaveCoordinatorOptions {
  synchronize: () => void;
  save: () => Promise<void>;
  onStateChange?: (state: SaveCoordinatorState) => void;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 400;
const MAX_ERROR_LENGTH = 500;

export class WorkspaceSaveCoordinator {
  private requestedRevision = 0;
  private savedRevision = 0;
  private phase: SavePhase = 'saved';
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: SaveCoordinatorOptions) {}

  get state(): SaveCoordinatorState {
    return {
      phase: this.phase,
      requestedRevision: this.requestedRevision,
      savedRevision: this.savedRevision,
      error: this.error
    };
  }

  get dirty(): boolean {
    return this.requestedRevision > this.savedRevision;
  }

  get saving(): boolean {
    return this.inFlight !== null;
  }

  markDirty(options: { immediate?: boolean } = {}): number {
    this.requestedRevision += 1;
    this.error = null;
    if (!this.inFlight) {
      this.setPhase('pending');
      if (options.immediate) {
        void this.flush().catch(() => undefined);
      } else {
        this.schedule();
      }
    } else {
      this.emit();
    }
    return this.requestedRevision;
  }

  flush(): Promise<void> {
    this.cancelTimer();
    if (this.inFlight) return this.inFlight;
    if (!this.dirty) {
      if (this.phase !== 'error' && this.phase !== 'saved') {
        this.setPhase('saved');
      }
      return Promise.resolve();
    }
    const running = this.drain();
    this.inFlight = running;
    void running.then(
      () => {
        if (this.inFlight === running) this.inFlight = null;
      },
      () => {
        if (this.inFlight === running) this.inFlight = null;
      }
    );
    return running;
  }

  retry(): Promise<void> {
    return this.flush();
  }

  acceptExternalSavedState(): boolean {
    if (this.inFlight || this.dirty) return false;
    this.cancelTimer();
    this.error = null;
    this.setPhase('saved');
    return true;
  }

  private async drain(): Promise<void> {
    while (this.savedRevision < this.requestedRevision) {
      const targetRevision = this.requestedRevision;
      this.error = null;
      this.setPhase('saving');
      try {
        this.options.synchronize();
        await this.options.save();
      } catch (error) {
        this.error = boundedError(error);
        this.setPhase('error');
        if (this.requestedRevision > targetRevision) this.schedule();
        throw error;
      }
      this.savedRevision = targetRevision;
      this.emit();
    }
    this.error = null;
    this.setPhase('saved');
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private setPhase(phase: SavePhase): void {
    if (this.phase === phase) {
      this.emit();
      return;
    }
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    this.options.onStateChange?.(this.state);
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || 'Workspace save failed.').slice(
    0,
    MAX_ERROR_LENGTH
  );
}
