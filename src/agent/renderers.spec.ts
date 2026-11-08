import type {
  DshActivityEvent,
  DshArtifactEvent,
  DshInteractionRequestedEvent
} from './protocol';
import {
  RendererRegistry,
  isCapabilityAvailable,
  type ArtifactRenderer,
  type RendererContext,
  type RendererHostCallbacks
} from './renderers';

function activity(overrides: Partial<DshActivityEvent> = {}): DshActivityEvent {
  return {
    type: 'dsh/v1/activity',
    sessionId: 's-1',
    runtimeId: 'rt-1',
    runId: 'run-1',
    activityId: 'a-1',
    phase: 'finished',
    ...overrides
  };
}

function artifact(overrides: Partial<DshArtifactEvent> = {}): DshArtifactEvent {
  return {
    type: 'dsh/v1/artifact',
    sessionId: 's-1',
    runtimeId: 'rt-1',
    runId: 'run-1',
    artifactId: 'art-1',
    phase: 'created',
    ...overrides
  };
}

function interaction(
  overrides: Partial<DshInteractionRequestedEvent> = {}
): DshInteractionRequestedEvent {
  return {
    type: 'dsh/v1/interaction.requested',
    sessionId: 's-1',
    runtimeId: 'rt-1',
    runId: 'run-1',
    requestId: 'req-1',
    kind: 'question',
    prompt: 'Pick one',
    ...overrides
  };
}

function host(): RendererHostCallbacks {
  return {
    openArtifact: jest.fn(),
    resolveInteraction: jest.fn()
  };
}

function context(overrides: Partial<RendererContext> = {}): RendererContext {
  return {
    capabilities: {},
    host: host(),
    ...overrides
  };
}

function labelled(text: string): HTMLElement {
  const element = document.createElement('div');
  element.textContent = text;
  return element;
}

describe('RendererRegistry', () => {
  let registry: RendererRegistry;

  beforeEach(() => {
    registry = new RendererRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('matches activity renderers by toolName', () => {
    registry.registerActivity({
      id: 'bash',
      match: event => event.toolName === 'bash',
      render: () => labelled('bash view')
    });

    expect(
      registry.renderActivity(activity({ toolName: 'bash' }), context())
        .textContent
    ).toBe('bash view');
  });

  it('uses unknown-tool fallback for tool-less activity without innerHTML', () => {
    const output = registry.renderActivity(activity(), context());

    expect(output.dataset.rendererFallback).toBe('activity');
    expect(output.dataset.toolName).toBeUndefined();
    expect(output.textContent).toContain('activity');
  });

  it('prefers the highest priority match', () => {
    registry.registerActivity({
      id: 'low',
      priority: 1,
      match: () => true,
      render: () => labelled('low')
    });
    registry.registerActivity({
      id: 'high',
      priority: 10,
      match: () => true,
      render: () => labelled('high')
    });

    expect(registry.renderActivity(activity(), context()).textContent).toBe(
      'high'
    );
  });

  it('keeps the earliest registration on equal priority', () => {
    registry.registerActivity({
      id: 'first',
      match: () => true,
      render: () => labelled('first')
    });
    registry.registerActivity({
      id: 'second',
      match: () => true,
      render: () => labelled('second')
    });

    expect(registry.renderActivity(activity(), context()).textContent).toBe(
      'first'
    );
  });

  it('removes a renderer when its handle is disposed', () => {
    const handle = registry.registerActivity({
      id: 'bash',
      match: () => true,
      render: () => labelled('bash view')
    });

    handle.dispose();
    handle.dispose(); // idempotent

    const output = registry.renderActivity(activity(), context());
    expect(output.dataset.rendererFallback).toBe('activity');
    expect(output.textContent).not.toBe('bash view');
  });

  it('rejects duplicate ids within a kind', () => {
    const renderer = {
      id: 'dup',
      match: () => true,
      render: () => labelled('x')
    };
    registry.registerActivity(renderer);

    expect(() => registry.registerActivity({ ...renderer })).toThrow(
      'Duplicate activity renderer id: dup'
    );
  });

  it('falls back when a renderer throws, without recursing', () => {
    const broken = jest.fn(() => {
      throw new Error('boom');
    });
    registry.registerActivity({
      id: 'broken',
      match: () => true,
      render: broken
    });

    const output = registry.renderActivity(
      activity({ toolName: 'bash' }),
      context()
    );

    expect(broken).toHaveBeenCalledTimes(1);
    expect(output.dataset.rendererFallback).toBe('activity');
    expect(output.textContent).toContain('bash');
  });

  it('treats a throwing match as a non-match', () => {
    registry.registerActivity({
      id: 'thrower',
      match: () => {
        throw new Error('match boom');
      },
      render: () => labelled('never')
    });

    const output = registry.renderActivity(activity(), context());
    expect(output.dataset.rendererFallback).toBe('activity');
  });

  it('renders untrusted activity text as inert text (no XSS)', () => {
    const output = registry.renderActivity(
      activity({
        label: '<img src=x onerror="alert(1)">',
        outputSummary: '<script>alert(1)</script>'
      }),
      context()
    );

    expect(output.querySelector('img')).toBeNull();
    expect(output.querySelector('script')).toBeNull();
    expect(output.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(output.textContent).toContain('<script>alert(1)</script>');
  });

  it('matches artifact renderers by mediaType and source', () => {
    const renderer: ArtifactRenderer = {
      id: 'notebook',
      match: event =>
        event.mediaType === 'application/x-ipynb+json' &&
        event.source === 'workspace_change',
      render: () => labelled('notebook artifact')
    };
    registry.registerArtifact(renderer);

    expect(
      registry.renderArtifact(
        artifact({
          mediaType: 'application/x-ipynb+json',
          source: 'workspace_change'
        }),
        context()
      ).textContent
    ).toBe('notebook artifact');

    const other = registry.renderArtifact(
      artifact({ mediaType: 'text/plain', source: 'presented' }),
      context()
    );
    expect(other.dataset.rendererFallback).toBe('artifact');
  });

  it('shows fallback artifact identity but never a clickable URI', () => {
    const output = registry.renderArtifact(
      artifact({
        name: 'report.html',
        mediaType: 'text/html',
        uri: 'javascript:alert(1)'
      }),
      context()
    );

    expect(output.dataset.rendererFallback).toBe('artifact');
    expect(output.querySelector('a')).toBeNull();
    expect(output.textContent).toContain('report.html');
    expect(output.textContent).not.toContain('javascript:');
  });

  it('matches interaction renderers by kind', () => {
    registry.registerInteraction({
      id: 'approval',
      match: event => event.kind === 'approval',
      render: () => labelled('approval request')
    });

    expect(
      registry.renderInteraction(interaction({ kind: 'approval' }), context())
        .textContent
    ).toBe('approval request');
  });

  it('gates interaction actions on capability status via context', () => {
    registry.registerInteraction({
      id: 'gated',
      match: () => true,
      render: (event, ctx) =>
        isCapabilityAvailable(ctx, 'approval')
          ? labelled('approval action enabled')
          : labelled('approval action disabled')
    });

    const enabled = registry.renderInteraction(
      interaction({ kind: 'approval' }),
      context({ capabilities: { approval: { status: 'available' } } })
    );
    expect(enabled.textContent).toBe('approval action enabled');

    const unverified = registry.renderInteraction(
      interaction({ kind: 'approval' }),
      context({ capabilities: { approval: { status: 'unverified' } } })
    );
    expect(unverified.textContent).toBe('approval action disabled');

    const absent = registry.renderInteraction(
      interaction({ kind: 'approval' }),
      context()
    );
    expect(absent.textContent).toBe('approval action disabled');
  });

  it('renders interaction fallback options as inert text', () => {
    const output = registry.renderInteraction(
      interaction({
        kind: 'question',
        prompt: 'Choose',
        options: [{ id: 'a', label: '<b>one</b>' }]
      }),
      context()
    );

    expect(output.dataset.rendererFallback).toBe('interaction');
    expect(output.querySelector('button')).toBeNull();
    expect(output.querySelector('b')).toBeNull();
    expect(output.textContent).toContain('<b>one</b>');
  });
});
