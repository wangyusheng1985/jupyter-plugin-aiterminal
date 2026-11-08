import { Widget } from '@lumino/widgets';

import {
  markerProximity,
  moveRovingId,
  navigationLabel,
  retainRovingId,
  type CellNavigationEntry
} from './workspace-interaction';

export interface CellNavigatorHandlers {
  onActivate: (cellId: string) => void;
}

export interface NavigatorRuntime {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  createResizeObserver: (
    callback: ResizeObserverCallback
  ) => ResizeObserver | null;
}

function browserRuntime(): NavigatorRuntime {
  return {
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: handle => window.cancelAnimationFrame(handle),
    createResizeObserver: callback =>
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(callback)
  };
}

export class CellNavigatorView extends Widget {
  private readonly rail: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private readonly compactButton: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly popoverList: HTMLDivElement;
  private readonly markerButtons = new Map<string, HTMLButtonElement>();
  private entries: CellNavigationEntry[] = [];
  private viewportCellId: string | null = null;
  private rovingId: string | null = null;
  private targetedId: string | null = null;
  private markerCenters: number[] = [];
  private pointerY = 0;
  private frame = 0;
  private geometryDirty = true;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(
    private readonly handlers: CellNavigatorHandlers,
    private readonly runtime: NavigatorRuntime = browserRuntime()
  ) {
    super();
    const instanceId = ++navigatorCounter;
    this.addClass('jp-AgentWorkspace-navigator');
    const label = document.createElement('span');
    label.id = `jp-AgentWorkspace-navigatorLabel-${instanceId}`;
    label.className = 'jp-AgentWorkspace-navigatorLabel';
    label.textContent = 'Cell history';
    this.node.setAttribute('aria-labelledby', label.id);

    this.rail = document.createElement('div');
    this.rail.className = 'jp-AgentWorkspace-navigatorRail';
    this.rail.addEventListener('pointerenter', () => {
      this.geometryDirty = true;
    });
    this.rail.addEventListener('pointermove', event => {
      this.pointerY = event.clientY;
      this.schedulePointerFrame();
    });
    this.rail.addEventListener('pointerleave', () => {
      if (this.node.contains(document.activeElement)) return;
      this.clearTarget();
    });
    this.rail.addEventListener('scroll', () => {
      this.geometryDirty = true;
    });

    this.tooltip = document.createElement('div');
    this.tooltip.id = `jp-AgentWorkspace-navigatorTooltip-${instanceId}`;
    this.tooltip.className = 'jp-AgentWorkspace-navigatorTooltip';
    this.tooltip.setAttribute('role', 'tooltip');
    this.tooltip.hidden = true;

    this.compactButton = document.createElement('button');
    this.compactButton.type = 'button';
    this.compactButton.className = 'jp-AgentWorkspace-navigatorCompact';
    this.compactButton.textContent = 'Cell history';
    this.compactButton.setAttribute('aria-haspopup', 'true');
    this.compactButton.setAttribute('aria-expanded', 'false');
    this.compactButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.setPopoverOpen(this.popover.hidden);
    });

    this.popover = document.createElement('div');
    this.popover.className = 'jp-AgentWorkspace-navigatorPopover';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'jp-AgentWorkspace-navigatorSearch';
    this.searchInput.placeholder = 'Search Cell history';
    const searchLabel = document.createElement('label');
    searchLabel.className = 'jp-AgentWorkspace-navigatorLabel';
    searchLabel.textContent = 'Search Cell history';
    searchLabel.htmlFor = `jp-AgentWorkspace-navigatorSearch-${instanceId}`;
    this.searchInput.id = searchLabel.htmlFor;
    this.searchInput.addEventListener('input', () => this.renderPopover());
    this.popoverList = document.createElement('div');
    this.popoverList.className = 'jp-AgentWorkspace-navigatorPopoverList';
    this.popover.append(searchLabel, this.searchInput, this.popoverList);
    this.popover.hidden = true;

    this.node.append(
      label,
      this.rail,
      this.tooltip,
      this.compactButton,
      this.popover
    );
    this.resizeObserver = this.runtime.createResizeObserver(() => {
      this.geometryDirty = true;
    });
    this.resizeObserver?.observe(this.rail);
  }

  render(
    entries: readonly CellNavigationEntry[],
    viewportCellId: string | null
  ): void {
    this.entries = entries.slice();
    this.viewportCellId = viewportCellId;
    const ids = this.entries.map(entry => entry.id);
    const selectedId = this.entries.find(entry => entry.selected)?.id ?? null;
    this.rovingId = retainRovingId(ids, this.rovingId, selectedId);

    const seen = new Set<string>();
    this.entries.forEach((entry, index) => {
      seen.add(entry.id);
      const button =
        this.markerButtons.get(entry.id) ?? this.createMarker(entry.id);
      this.syncMarker(button, entry, index);
      if (button.parentElement !== this.rail) {
        this.rail.append(button);
      } else if (this.rail.children[index] !== button) {
        this.rail.insertBefore(button, this.rail.children[index] ?? null);
      }
    });
    this.markerButtons.forEach((button, id) => {
      if (seen.has(id)) return;
      button.remove();
      this.markerButtons.delete(id);
    });
    this.renderPopover();
    this.geometryDirty = true;
    if (this.targetedId && !seen.has(this.targetedId)) {
      this.clearTarget();
    }
  }

  getMarker(cellId: string): HTMLButtonElement | null {
    return this.markerButtons.get(cellId) ?? null;
  }

  openHistory(): void {
    this.setPopoverOpen(this.popover.hidden);
  }

  dispose(): void {
    if (this.isDisposed) return;
    if (this.frame) this.runtime.cancelFrame(this.frame);
    this.resizeObserver?.disconnect();
    super.dispose();
  }

  private createMarker(cellId: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-AgentWorkspace-navigatorItem';
    button.dataset.cellId = cellId;
    button.setAttribute('aria-describedby', this.tooltip.id);
    const line = document.createElement('span');
    line.className = 'jp-AgentWorkspace-navigatorLine';
    line.setAttribute('aria-hidden', 'true');
    button.append(line);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onActivate(cellId);
    });
    button.addEventListener('focus', () => {
      this.rovingId = cellId;
      this.syncTabStops();
      this.showTarget(cellId);
      button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
    button.addEventListener('blur', event => {
      const next = event.relatedTarget;
      if (next instanceof Node && this.node.contains(next)) return;
      this.clearTarget();
    });
    button.addEventListener('keydown', event =>
      this.onMarkerKey(event, cellId)
    );
    this.markerButtons.set(cellId, button);
    return button;
  }

  private syncMarker(
    button: HTMLButtonElement,
    entry: CellNavigationEntry,
    index: number
  ): void {
    button.dataset.index = String(index);
    button.classList.toggle('is-selected', entry.selected);
    button.classList.toggle('is-current', entry.id === this.viewportCellId);
    button.classList.toggle('is-queued', entry.status === 'queued');
    button.classList.toggle('is-running', entry.status === 'running');
    button.classList.toggle('is-failed', entry.failureCount > 0);
    button.classList.toggle(
      'is-native-context',
      entry.contextMembership === 'native'
    );
    button.classList.toggle(
      'is-bridged-context',
      entry.contextMembership === 'bridged'
    );
    button.classList.toggle(
      'is-outside-context',
      entry.contextMembership === 'outside'
    );
    button.dataset.contextMembership = entry.contextMembership;
    button.setAttribute('aria-label', navigationLabel(entry));
    button.setAttribute('aria-current', entry.selected ? 'true' : 'false');
    button.tabIndex = entry.id === this.rovingId ? 0 : -1;
  }

  private syncTabStops(): void {
    this.markerButtons.forEach((button, id) => {
      button.tabIndex = id === this.rovingId ? 0 : -1;
    });
  }

  private onMarkerKey(event: KeyboardEvent, cellId: string): void {
    const ids = this.entries.map(entry => entry.id);
    let next: string | null = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = moveRovingId(ids, cellId, -1);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = moveRovingId(ids, cellId, 1);
    } else if (event.key === 'Home') {
      next = ids[0] ?? null;
    } else if (event.key === 'End') {
      next = ids[ids.length - 1] ?? null;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      this.handlers.onActivate(cellId);
      return;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.rovingId = next;
    this.syncTabStops();
    if (next) this.markerButtons.get(next)?.focus({ preventScroll: true });
  }

  private schedulePointerFrame(): void {
    if (this.frame) return;
    this.frame = this.runtime.requestFrame(() => {
      this.frame = 0;
      if (this.geometryDirty) this.measureCenters();
      const proximity = markerProximity(this.markerCenters, this.pointerY);
      this.entries.forEach((entry, index) => {
        const weight = proximity.weights[index] ?? 0;
        this.markerButtons
          .get(entry.id)
          ?.style.setProperty(
            '--jp-AgentWorkspace-markerScale',
            String(0.35 + weight * 0.65)
          );
      });
      const entry = this.entries[proximity.targetIndex];
      if (entry) this.showTarget(entry.id);
    });
  }

  private measureCenters(): void {
    this.markerCenters = this.entries.map(entry => {
      const rect = this.markerButtons.get(entry.id)?.getBoundingClientRect();
      return rect ? rect.top + rect.height / 2 : 0;
    });
    this.geometryDirty = false;
  }

  private showTarget(cellId: string): void {
    const entry = this.entries.find(candidate => candidate.id === cellId);
    const button = this.markerButtons.get(cellId);
    if (!entry || !button) return;
    this.targetedId = cellId;
    this.markerButtons.forEach((candidate, id) => {
      candidate.classList.toggle('is-targeted', id === cellId);
    });
    this.tooltip.textContent = `${entry.preview || 'Empty input'}${contextTooltipSuffix(
      entry
    )}`;
    this.tooltip.style.top = `${button.offsetTop + button.offsetHeight / 2}px`;
    this.tooltip.hidden = false;
  }

  private clearTarget(): void {
    this.targetedId = null;
    this.tooltip.hidden = true;
    this.markerButtons.forEach(button => {
      button.classList.remove('is-targeted');
      button.style.removeProperty('--jp-AgentWorkspace-markerScale');
    });
  }

  private setPopoverOpen(open: boolean): void {
    this.popover.hidden = !open;
    this.popover.classList.toggle('is-open', open);
    this.compactButton.setAttribute('aria-expanded', String(open));
    if (open) {
      this.searchInput.value = '';
      this.searchInput.focus({ preventScroll: true });
    }
  }

  private renderPopover(): void {
    const fragment = document.createDocumentFragment();
    const query = this.searchInput.value.trim().toLocaleLowerCase();
    const matching = this.entries.filter(entry => {
      if (!query) return true;
      return entry.source.toLocaleLowerCase().includes(query);
    });
    matching.forEach(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jp-AgentWorkspace-navigatorPopoverItem';
      button.dataset.cellId = entry.id;
      button.textContent = entry.preview || 'Empty input';
      button.dataset.contextMembership = entry.contextMembership;
      button.setAttribute('aria-label', navigationLabel(entry));
      button.setAttribute('aria-current', entry.selected ? 'true' : 'false');
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this.setPopoverOpen(false);
        this.handlers.onActivate(entry.id);
      });
      fragment.append(button);
    });
    if (!matching.length) {
      const empty = document.createElement('div');
      empty.className = 'jp-AgentWorkspace-navigatorPopoverEmpty';
      empty.textContent = 'No matching Cells';
      fragment.append(empty);
    }
    this.popoverList.replaceChildren(fragment);
    this.compactButton.hidden = this.entries.length === 0;
  }
}

function contextTooltipSuffix(entry: CellNavigationEntry): string {
  switch (entry.contextMembership) {
    case 'native':
      return ' · Native context';
    case 'bridged':
      return ' · Bridged history';
    case 'outside':
      return ' · Outside current context';
    case 'draft':
    case 'none':
      return '';
  }
}

let navigatorCounter = 0;
