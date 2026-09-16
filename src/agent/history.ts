export interface HistoryNavigation {
  source: string;
  browsing: boolean;
}

export class CommandHistory {
  private readonly entries: string[] = [];
  private cursor: number | null = null;
  private draft = '';

  get values(): readonly string[] {
    return this.entries;
  }

  get browsing(): boolean {
    return this.cursor !== null;
  }

  add(source: string): boolean {
    const command = source.trim();
    if (!command) return false;
    if (this.entries[this.entries.length - 1] === command) {
      this.resetNavigation();
      return false;
    }
    this.entries.push(command);
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
