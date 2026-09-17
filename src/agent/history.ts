export interface HistoryNavigation {
  source: string;
  browsing: boolean;
}

export class WorkspaceInputHistory {
  private readonly entries: string[] = [];
  private cursor: number | null = null;
  private draft = '';

  get values(): readonly string[] {
    return this.entries;
  }

  get browsing(): boolean {
    return this.cursor !== null;
  }

  restore(entries: readonly string[]): void {
    this.entries.length = 0;
    this.resetNavigation();
    entries.forEach(entry => this.add(entry));
  }

  add(source: string): boolean {
    const input = source.trim();
    if (!input) return false;
    if (this.entries[this.entries.length - 1] === input) {
      this.resetNavigation();
      return false;
    }
    this.entries.push(input);
    this.resetNavigation();
    return true;
  }

  previous(draft: string): HistoryNavigation | null {
    if (!this.entries.length) return null;
    if (this.cursor === null) {
      this.draft = draft;
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor -= 1;
    }
    return {
      source: this.entries[this.cursor],
      browsing: true
    };
  }

  next(): HistoryNavigation | null {
    if (this.cursor === null) return null;
    if (this.cursor < this.entries.length - 1) {
      this.cursor += 1;
      return {
        source: this.entries[this.cursor],
        browsing: true
      };
    }
    const source = this.draft;
    this.resetNavigation();
    return { source, browsing: false };
  }

  resetNavigation(): void {
    this.cursor = null;
    this.draft = '';
  }
}
