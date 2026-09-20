import { createWorkspaceCell } from './notebook';
import { CellNavigatorView, type NavigatorRuntime } from './navigator';
import { createTurn, setTurnStatus } from './turn';
import { navigationEntries } from './workspace-interaction';

class FakeRuntime implements NavigatorRuntime {
  callbacks: FrameRequestCallback[] = [];
  cancelled: number[] = [];

  requestFrame = (callback: FrameRequestCallback): number => {
    this.callbacks.push(callback);
    return this.callbacks.length;
  };

  cancelFrame = (handle: number): void => {
    this.cancelled.push(handle);
  };

  createResizeObserver = (): ResizeObserver | null => null;

  flush(): void {
    const callbacks = this.callbacks.splice(0);
    callbacks.forEach(callback => callback(0));
  }
}

function cells() {
  return ['first', 'second', 'third'].map((source, index) => ({
    ...createWorkspaceCell(),
    id: `cell-${index + 1}`,
    source,
    status: index === 1 ? ('running' as const) : ('done' as const),
    executionCount: index + 1
  }));
}

function press(node: HTMLElement, key: string): void {
  node.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true
    })
  );
}

describe('CellNavigatorView', () => {
  it('reconciles markers by stable Cell identity', () => {
    const navigator = new CellNavigatorView({ onActivate: jest.fn() });
    const original = cells();
    navigator.render(navigationEntries(original, 0), 'cell-1');
    const second = navigator.getMarker('cell-2');

    original[1].source = 'changed';
    original[1].status = 'done';
    navigator.render(
      navigationEntries([original[1], original[2]], 0),
      'cell-2'
    );

    expect(navigator.getMarker('cell-2')).toBe(second);
    expect(navigator.getMarker('cell-1')).toBeNull();
    expect(
      navigator.node.querySelectorAll('.jp-AgentWorkspace-navigatorItem')
    ).toHaveLength(2);
    navigator.dispose();
  });

  it('uses one tab stop and activates markers with pointer or keyboard', () => {
    const onActivate = jest.fn();
    const navigator = new CellNavigatorView({ onActivate });
    navigator.render(navigationEntries(cells(), 0), 'cell-2');
    document.body.append(navigator.node);
    const first = navigator.getMarker('cell-1');
    const second = navigator.getMarker('cell-2');

    expect(first?.tabIndex).toBe(0);
    expect(second?.tabIndex).toBe(-1);
    first?.focus();
    press(first as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(second);
    expect(second?.tabIndex).toBe(0);
    press(second as HTMLElement, 'Enter');
    expect(onActivate).toHaveBeenLastCalledWith('cell-2');
    second?.click();
    expect(onActivate).toHaveBeenLastCalledWith('cell-2');
    expect(second?.getAttribute('aria-label')).toContain('running');

    navigator.dispose();
    navigator.node.remove();
  });

  it('batches pointer feedback and reuses one tooltip', () => {
    const runtime = new FakeRuntime();
    const navigator = new CellNavigatorView({ onActivate: jest.fn() }, runtime);
    navigator.render(navigationEntries(cells(), 0), 'cell-1');
    const markers = Array.from(
      navigator.node.querySelectorAll<HTMLButtonElement>(
        '.jp-AgentWorkspace-navigatorItem'
      )
    );
    markers.forEach((marker, index) => {
      Object.defineProperty(marker, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top: index * 24,
          height: 24,
          left: 0,
          right: 24,
          bottom: index * 24 + 24,
          width: 24,
          x: 0,
          y: index * 24,
          toJSON: () => ({})
        })
      });
    });
    const rail = navigator.node.querySelector(
      '.jp-AgentWorkspace-navigatorRail'
    );
    rail?.dispatchEvent(new MouseEvent('pointermove', { clientY: 34 }));
    rail?.dispatchEvent(new MouseEvent('pointermove', { clientY: 36 }));
    expect(runtime.callbacks).toHaveLength(1);

    runtime.flush();

    expect(
      navigator.node.querySelectorAll('.jp-AgentWorkspace-navigatorTooltip')
    ).toHaveLength(1);
    expect(
      navigator.node.querySelector<HTMLElement>(
        '.jp-AgentWorkspace-navigatorTooltip'
      )?.hidden
    ).toBe(false);
    expect(
      markers[1].style.getPropertyValue('--jp-AgentWorkspace-markerScale')
    ).toBe('1');
    navigator.dispose();
  });

  it('exposes every entry through the compact history control', () => {
    const onActivate = jest.fn();
    const navigator = new CellNavigatorView({ onActivate });
    navigator.render(navigationEntries(cells(), 2), 'cell-3');
    const compact = navigator.node.querySelector<HTMLButtonElement>(
      '.jp-AgentWorkspace-navigatorCompact'
    );
    compact?.click();
    const options = navigator.node.querySelectorAll<HTMLButtonElement>(
      '.jp-AgentWorkspace-navigatorPopoverItem'
    );
    expect(options).toHaveLength(3);
    expect(options[2].getAttribute('aria-current')).toBe('true');
    options[0].click();
    expect(onActivate).toHaveBeenCalledWith('cell-1');
    navigator.dispose();
  });

  it('opens a searchable history palette and keeps failure state visible', () => {
    const failed = cells()[0];
    failed.turn = setTurnStatus(createTurn('failed-turn'), 'interrupted', [
      {
        kind: 'tool',
        id: 'failed-tool',
        name: 'Bash',
        input: { command: 'false' },
        output: 'failed',
        status: 'error'
      }
    ]);
    const navigator = new CellNavigatorView({ onActivate: jest.fn() });
    navigator.render(
      navigationEntries([failed, ...cells().slice(1)], 0),
      'cell-1'
    );
    navigator.openHistory();

    const search = navigator.node.querySelector<HTMLInputElement>(
      '.jp-AgentWorkspace-navigatorSearch'
    );
    if (search) {
      search.value = 'third';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(
      navigator.node.querySelectorAll('.jp-AgentWorkspace-navigatorPopoverItem')
    ).toHaveLength(1);
    expect(navigator.getMarker('cell-1')?.classList.contains('is-failed')).toBe(
      true
    );
    expect(navigator.getMarker('cell-1')?.getAttribute('aria-label')).toContain(
      '1 failed'
    );
    navigator.dispose();
  });

  it('shows non-color context membership without replacing keyed markers', () => {
    const navigator = new CellNavigatorView({ onActivate: jest.fn() });
    const sourceCells = cells();
    const memberships = new Map([
      ['cell-1', 'native' as const],
      ['cell-2', 'bridged' as const],
      ['cell-3', 'outside' as const]
    ]);
    navigator.render(navigationEntries(sourceCells, 0, memberships), 'cell-1');
    const native = navigator.getMarker('cell-1');
    const bridged = navigator.getMarker('cell-2');
    const outside = navigator.getMarker('cell-3');

    expect(native?.classList.contains('is-native-context')).toBe(true);
    expect(bridged?.classList.contains('is-bridged-context')).toBe(true);
    expect(outside?.classList.contains('is-outside-context')).toBe(true);
    expect(native?.getAttribute('aria-label')).toContain('native context');
    expect(bridged?.getAttribute('aria-label')).toContain('bridged history');
    expect(outside?.getAttribute('aria-label')).toContain(
      'outside current context'
    );

    sourceCells[1].output = 'stream-only update';
    navigator.render(navigationEntries(sourceCells, 0, memberships), 'cell-2');
    expect(navigator.getMarker('cell-2')).toBe(bridged);
    expect(
      navigator.node
        .querySelector<HTMLButtonElement>(
          '.jp-AgentWorkspace-navigatorPopoverItem[data-cell-id="cell-2"]'
        )
        ?.getAttribute('aria-label')
    ).toContain('bridged history');
    navigator.dispose();
  });
});
