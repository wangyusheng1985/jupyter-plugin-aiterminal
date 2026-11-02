import type { DshArtifactEvent } from './protocol';
import {
  ArtifactProjection,
  ArtifactView,
  artifactOpenDecision,
  artifactRecordFromEvent,
  checkWorkspaceRelativePath,
  registerArtifactRenderer,
  renderArtifactCard,
  type ArtifactRecord
} from './artifacts';
import {
  RendererRegistry,
  type RendererContext,
  type RendererHostCallbacks
} from './renderers';

function artifactEvent(
  overrides: Partial<DshArtifactEvent> = {}
): DshArtifactEvent {
  return {
    type: 'dsh/v1/artifact',
    sessionId: 's-1',
    runtimeId: 'rt-1',
    runId: 'run-1',
    artifactId: 'art-1',
    phase: 'created',
    name: 'report.md',
    uri: 'docs/report.md',
    mediaType: 'text/markdown',
    source: 'presented',
    ...overrides
  };
}

function host(
  overrides: Partial<RendererHostCallbacks> = {}
): RendererHostCallbacks {
  return {
    openArtifact: jest.fn(),
    resolveInteraction: jest.fn(),
    ...overrides
  };
}

function context(overrides: Partial<RendererContext> = {}): RendererContext {
  return {
    capabilities: { artifacts: { status: 'available' } },
    host: host(),
    ...overrides
  };
}

function record(overrides: Partial<DshArtifactEvent> = {}): ArtifactRecord {
  return artifactRecordFromEvent(artifactEvent(overrides));
}

function openButton(card: HTMLElement): HTMLButtonElement {
  const button = card.querySelector('button');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('expected an Open button');
  }
  return button;
}

describe('checkWorkspaceRelativePath', () => {
  it('accepts plain and encoded workspace-relative file paths', () => {
    expect(checkWorkspaceRelativePath('docs/report.md')).toEqual({
      ok: true,
      path: 'docs/report.md'
    });
    expect(checkWorkspaceRelativePath('./notes/a.txt')).toEqual({
      ok: true,
      path: './notes/a.txt'
    });
    expect(checkWorkspaceRelativePath('docs/My%20File.md')).toEqual({
      ok: true,
      path: 'docs/My File.md'
    });
    expect(checkWorkspaceRelativePath('docs%2Fnested.md')).toEqual({
      ok: true,
      path: 'docs/nested.md'
    });
  });

  it.each([
    ['', 'missing_uri'],
    ['a\u0000b', 'nul_byte'],
    ['a\u0001b', 'control_character'],
    ['a\\b', 'backslash'],
    ['\\\\server\\share', 'backslash'],
    ['//evil.example/x', 'protocol_relative'],
    ['/etc/passwd', 'absolute_path'],
    ['~/secret', 'absolute_path'],
    ['C:/secret', 'absolute_path'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,<script>alert(1)</script>', 'scheme'],
    ['http://example.com/a', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['docs/../../secret', 'traversal'],
    ['..%2Fsecret', 'traversal'],
    ['%2e%2e/secret', 'traversal'],
    ['%252e%252e/secret', 'nested_escape'],
    ['a%5Cb', 'backslash'],
    ['%00', 'nul_byte'],
    ['docs/a?x=1', 'query_or_fragment'],
    ['docs/a#frag', 'query_or_fragment'],
    ['docs//a', 'empty_segment'],
    ['docs/', 'empty_segment'],
    ['%zz', 'malformed_escape']
  ] as const)('rejects %s', (uri, reason) => {
    expect(checkWorkspaceRelativePath(uri)).toEqual({ ok: false, reason });
  });
});

describe('ArtifactProjection', () => {
  let projection: ArtifactProjection;

  beforeEach(() => {
    projection = new ArtifactProjection();
  });

  it('deduplicates created and updated events for one identity', () => {
    projection.apply(artifactEvent());
    projection.apply(
      artifactEvent({
        phase: 'updated',
        name: 'final.md',
        uri: 'docs/final.md',
        mediaType: 'text/plain'
      })
    );

    expect(projection.size).toBe(1);
    const current = projection.get(artifactEvent());
    expect(current?.name).toBe('final.md');
    expect(current?.uri).toBe('docs/final.md');
    expect(current?.mediaType).toBe('text/plain');
    expect(current?.phase).toBe('updated');
  });

  it('updates the same durable artifact after a runtime reconnect', () => {
    projection.apply(artifactEvent());
    projection.apply(
      artifactEvent({
        phase: 'updated',
        runtimeId: 'rt-2',
        name: 'after-reconnect.md'
      })
    );

    expect(projection.size).toBe(1);
    const current = projection.get(artifactEvent());
    expect(current?.runtimeId).toBe('rt-2');
    expect(current?.name).toBe('after-reconnect.md');
  });

  it('keeps artifacts from different sessions and runs separate', () => {
    projection.apply(artifactEvent());
    projection.apply(artifactEvent({ sessionId: 's-2' }));
    projection.apply(artifactEvent({ runId: 'run-2' }));

    expect(projection.size).toBe(3);
  });

  it('removes a deleted artifact and tolerates duplicate deletes', () => {
    projection.apply(artifactEvent());
    expect(projection.apply(artifactEvent({ phase: 'deleted' }))).toBeNull();
    expect(projection.size).toBe(0);
    expect(projection.apply(artifactEvent({ phase: 'deleted' }))).toBeNull();
    expect(projection.size).toBe(0);
  });

  it('clears a stale locator when an update reports it unavailable', () => {
    projection.apply(artifactEvent());
    projection.apply(
      artifactEvent({
        phase: 'updated',
        uri: undefined,
        unavailableReason: 'uri_unavailable'
      })
    );

    const current = projection.get(artifactEvent());
    expect(current?.uri).toBeUndefined();
    expect(current?.unavailableReason).toBe('uri_unavailable');
  });
});

describe('artifactOpenDecision', () => {
  it('allows only safe relative paths with capability and host present', () => {
    expect(artifactOpenDecision(record(), context())).toEqual({
      canOpen: true,
      path: 'docs/report.md'
    });
  });

  it('blocks deleted and unavailable artifacts', () => {
    expect(
      artifactOpenDecision(record({ phase: 'deleted' }), context())
    ).toMatchObject({ canOpen: false, code: 'deleted' });
    expect(
      artifactOpenDecision(
        record({ uri: undefined, unavailableReason: 'uri_unavailable' }),
        context()
      )
    ).toMatchObject({ canOpen: false, code: 'unavailable' });
  });

  it('blocks unsafe locators even when the capability is available', () => {
    expect(
      artifactOpenDecision(record({ uri: '../secret' }), context())
    ).toMatchObject({ canOpen: false, code: 'unsafe_path' });
    expect(
      artifactOpenDecision(record({ uri: 'javascript:alert(1)' }), context())
    ).toMatchObject({ canOpen: false, code: 'unsafe_path' });
  });

  it('treats unverified artifact support as unusable', () => {
    expect(
      artifactOpenDecision(
        record(),
        context({ capabilities: { artifacts: { status: 'unverified' } } })
      )
    ).toMatchObject({ canOpen: false, code: 'capability_unverified' });
  });

  it('blocks opening without a host callback', () => {
    expect(
      artifactOpenDecision(
        record(),
        context({ host: {} as RendererHostCallbacks })
      )
    ).toMatchObject({ canOpen: false, code: 'missing_host' });
  });
});

describe('registerArtifactRenderer', () => {
  let registry: RendererRegistry;

  beforeEach(() => {
    registry = new RendererRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('renders name, source, media type, and an explicit unverified note', () => {
    registerArtifactRenderer(registry);
    const card = registry.renderArtifact(artifactEvent(), context());

    expect(card.dataset.rendererFallback).toBeUndefined();
    expect(card.dataset.artifactVerified).toBe('false');
    expect(card.textContent).toContain('report.md');
    expect(card.textContent).toContain('Presented');
    expect(card.textContent).toContain('text/markdown');
    expect(card.textContent).toContain('contents not verified');
  });

  it('uses a safe unknown-source fallback', () => {
    const card = renderArtifactCard(record({ source: undefined }), context());
    const source = card.querySelector('.jp-Dsh-artifactSource');

    expect(source?.textContent).toBe('Source unknown');
    expect(source?.getAttribute('data-source-unknown')).toBe('true');
  });

  it('keeps injected runtime text inert', () => {
    const card = renderArtifactCard(
      record({
        name: '<img src=x onerror="alert(1)">',
        mediaType: '<script>alert(1)</script>',
        uri: undefined,
        unavailableReason: '<b>gone</b>'
      }),
      context()
    );

    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('script')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(card.textContent).toContain('<script>alert(1)</script>');
  });

  it('shows unavailable reasons and disables opening', () => {
    const callbacks = host();
    const card = renderArtifactCard(
      record({ uri: undefined, unavailableReason: 'uri_unavailable' }),
      context({ host: callbacks })
    );
    const button = openButton(card);

    expect(button.disabled).toBe(true);
    expect(card.textContent).toContain('Unavailable: uri_unavailable');
    button.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('opens only after an explicit click and passes the safe path', () => {
    const callbacks = host();
    const card = renderArtifactCard(
      record({ uri: 'docs/My%20File.md' }),
      context({ host: callbacks })
    );
    const button = openButton(card);

    expect(callbacks.openArtifact).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    button.click();
    expect(callbacks.openArtifact).toHaveBeenCalledWith(
      'art-1',
      'docs/My File.md'
    );
  });

  it('disables opening when artifact capability is unavailable', () => {
    const callbacks = host();
    const card = renderArtifactCard(
      record(),
      context({
        host: callbacks,
        capabilities: {
          artifacts: { status: 'unavailable', reason: 'runtime has none' }
        }
      })
    );
    const button = openButton(card);

    expect(button.disabled).toBe(true);
    expect(card.textContent).toContain('runtime has none');
    button.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('disables opening when artifact capability is only unverified', () => {
    const callbacks = host();
    const card = renderArtifactCard(
      record(),
      context({
        host: callbacks,
        capabilities: { artifacts: { status: 'unverified' } }
      })
    );
    const button = openButton(card);

    expect(button.disabled).toBe(true);
    expect(card.textContent).toContain('has not been verified');
    button.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('disables opening for traversal locators', () => {
    const callbacks = host();
    const card = renderArtifactCard(
      record({ uri: '../../etc/passwd' }),
      context({ host: callbacks })
    );
    const button = openButton(card);

    expect(button.disabled).toBe(true);
    expect(card.textContent).toContain('Path traversal');
    button.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('disables opening when the host hook is missing', () => {
    const card = renderArtifactCard(
      record(),
      context({ host: {} as RendererHostCallbacks })
    );

    expect(openButton(card).disabled).toBe(true);
    expect(card.textContent).toContain('no host hook');
  });

  it('shows a synchronous host failure in an alert without throwing', () => {
    const callbacks = host({
      openArtifact: jest.fn(() => {
        throw new Error('host crashed');
      })
    });
    const card = renderArtifactCard(record(), context({ host: callbacks }));
    const button = openButton(card);

    expect(() => button.click()).not.toThrow();
    const alert = card.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('host crashed');
  });

  it('shows an asynchronous host rejection without an unhandled rejection', async () => {
    const callbacks = host({
      openArtifact: jest.fn(() => Promise.reject(new Error('denied')))
    });
    const card = renderArtifactCard(record(), context({ host: callbacks }));
    openButton(card).click();

    await Promise.resolve();
    await Promise.resolve();

    const alert = card.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('denied');
  });

  it('renders one keyboard-accessible Open control and no diff/rollback action', () => {
    const card = renderArtifactCard(record(), context());
    const buttons = card.querySelectorAll('button');

    expect(buttons).toHaveLength(1);
    const button = openButton(card);
    expect(button.type).toBe('button');
    expect(button.getAttribute('tabindex')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Open report.md');
    expect(card.textContent).not.toMatch(/diff|rollback/i);
  });

  it('returns to the safe fallback when its handle is disposed', () => {
    const handle = registerArtifactRenderer(registry);
    handle.dispose();

    const output = registry.renderArtifact(artifactEvent(), context());
    expect(output.dataset.rendererFallback).toBe('artifact');
  });
});

describe('ArtifactView', () => {
  it('projects create/update/dedupe into one card', () => {
    const view = new ArtifactView(context());
    view.apply(artifactEvent());
    view.apply(artifactEvent());
    view.apply(
      artifactEvent({
        phase: 'updated',
        runtimeId: 'rt-2',
        name: 'final.md',
        uri: 'docs/final.md'
      })
    );

    expect(view.records).toHaveLength(1);
    expect(view.records[0].runtimeId).toBe('rt-2');
    expect(view.element.querySelectorAll('.jp-Dsh-artifactCard')).toHaveLength(
      1
    );
    expect(view.element.textContent).toContain('final.md');
  });

  it('removes deleted artifacts and tolerates duplicate deletes', () => {
    const view = new ArtifactView(context());
    view.apply(artifactEvent());
    view.apply(artifactEvent({ phase: 'deleted' }));
    view.apply(artifactEvent({ phase: 'deleted' }));

    expect(view.records).toHaveLength(0);
    expect(view.element.textContent).toContain('No artifacts reported');
  });

  it('rerenders when the host context changes', () => {
    const callbacks = host();
    const view = new ArtifactView(context({ host: callbacks }));
    view.apply(artifactEvent());
    expect(openButton(view.element).disabled).toBe(false);

    view.setContext(
      context({
        host: callbacks,
        capabilities: { artifacts: { status: 'unavailable' } }
      })
    );
    expect(openButton(view.element).disabled).toBe(true);
  });

  it('ignores a stale Open button after a context rerender', () => {
    const callbacks = host();
    const view = new ArtifactView(context({ host: callbacks }));
    view.apply(artifactEvent());
    const staleButton = openButton(view.element);

    view.setContext(
      context({
        host: callbacks,
        capabilities: { artifacts: { status: 'unavailable' } }
      })
    );

    staleButton.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('ignores a stale Open button after the artifact is deleted', () => {
    const callbacks = host();
    const view = new ArtifactView(context({ host: callbacks }));
    view.apply(artifactEvent());
    const staleButton = openButton(view.element);

    view.apply(artifactEvent({ phase: 'deleted' }));

    staleButton.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('disposes without leaving a live projection', () => {
    const view = new ArtifactView(context());
    view.apply(artifactEvent());
    view.dispose();

    expect(view.records).toHaveLength(0);
    expect(view.element.childElementCount).toBe(0);
  });

  it('ignores a stale Open button after dispose', () => {
    const callbacks = host();
    const view = new ArtifactView(context({ host: callbacks }));
    view.apply(artifactEvent());
    const staleButton = openButton(view.element);

    view.dispose();

    staleButton.click();
    expect(callbacks.openArtifact).not.toHaveBeenCalled();
  });

  it('ignores a late host rejection after the view is disposed', async () => {
    let rejectHost: (error: unknown) => void = () => {};
    const callbacks = host({
      openArtifact: jest.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectHost = reject;
          })
      )
    });
    const view = new ArtifactView(context({ host: callbacks }));
    view.apply(artifactEvent());
    const card = view.element.querySelector(
      '.jp-Dsh-artifactCard'
    ) as HTMLElement | null;
    if (!card) {
      throw new Error('expected a rendered artifact card');
    }
    openButton(card).click();
    expect(callbacks.openArtifact).toHaveBeenCalledTimes(1);

    view.dispose();
    rejectHost(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();

    const alert = card.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.hidden).toBe(true);
    expect(alert.textContent).toBe('');
  });
});
