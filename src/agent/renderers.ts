import type {
  DshActivityEvent,
  DshArtifactEvent,
  DshCapabilityManifest,
  DshCapabilityName,
  DshInteractionRequestedEvent
} from './protocol';

/**
 * Presenter registry for DSH product events (activity / artifact /
 * interaction). This module is deliberately DOM-only: every renderer returns
 * an `HTMLElement`, never a Lumino widget, so the registry does not couple to
 * a particular React or Lumino view stack. It performs no dynamic code
 * evaluation, no plugin loading, and no network access; callers register
 * renderers explicitly.
 *
 * Renderers never open artifacts or resolve interactions themselves. Host
 * behavior (opening a URI, delivering an answer) is injected through
 * `RendererContext.host`, and whether a given action is offered is decided by
 * `RendererContext.capabilities` rather than hard-coded assumptions.
 */

/** Unified renderer output: DOM nodes only, never widgets. */
export type RendererOutput = HTMLElement;

/** Host callbacks injected into every renderer; this module invokes none. */
export interface RendererHostCallbacks {
  /** Open an artifact the runtime already surfaced; URI safety is host-owned. */
  openArtifact(artifactId: string, uri?: string): void;
  /** Deliver a user's interaction decision; correlation is host-owned. */
  resolveInteraction(
    requestId: string,
    resolution: { optionId?: string; text?: string }
  ): void;
}

/** Per-render context. Capabilities gate which actions may be offered. */
export interface RendererContext {
  capabilities: DshCapabilityManifest;
  host: RendererHostCallbacks;
}

/**
 * True only when a capability is positively `available`. Both `unavailable`
 * and `unverified` return false: an unexercised capability must never be
 * presented as usable.
 */
export function isCapabilityAvailable(
  context: RendererContext,
  name: DshCapabilityName
): boolean {
  return context.capabilities[name]?.status === 'available';
}

/** A renderer that returns DOM for one event shape. */
export interface Renderer<TEvent> {
  /** Stable identity, unique within its kind. Used for removal and tests. */
  readonly id: string;
  /** Higher wins over lower; ties keep the earliest registration. */
  readonly priority?: number;
  /** Whether this renderer claims the event. */
  match(event: TEvent): boolean;
  /** Produce the event's DOM. Throwing falls back safely (never recurses). */
  render(event: TEvent, context: RendererContext): HTMLElement;
}

export type ActivityRenderer = Renderer<DshActivityEvent>;
export type ArtifactRenderer = Renderer<DshArtifactEvent>;
export type InteractionRenderer = Renderer<DshInteractionRequestedEvent>;

/** Handle returned by every registration; `dispose` removes that renderer. */
export interface RendererDisposable {
  readonly id: string;
  dispose(): void;
}

interface RendererEntry<TEvent> {
  readonly renderer: Renderer<TEvent>;
  readonly order: number;
}

const DEFAULT_PRIORITY = 0;

type Fallback<TEvent> = (event: TEvent) => HTMLElement;

/**
 * Registry of presenters keyed by kind. Matching is a predicate supplied on
 * each renderer, so activity renderers key on `toolName`, artifact renderers
 * on `mediaType`/`source`, and interaction renderers on `kind` — without this
 * module inventing a fixed taxonomy.
 *
 * Conflict resolution is deterministic: among all matching renderers the one
 * with the highest `priority` wins; equal priorities keep the earliest
 * registered renderer. Duplicate ids within a kind are rejected eagerly.
 */
export class RendererRegistry {
  private readonly activity: RendererEntry<DshActivityEvent>[] = [];
  private readonly artifact: RendererEntry<DshArtifactEvent>[] = [];
  private readonly interaction: RendererEntry<DshInteractionRequestedEvent>[] =
    [];
  private order = 0;

  registerActivity(renderer: ActivityRenderer): RendererDisposable {
    return this.add(this.activity, renderer, 'activity');
  }

  registerArtifact(renderer: ArtifactRenderer): RendererDisposable {
    return this.add(this.artifact, renderer, 'artifact');
  }

  registerInteraction(renderer: InteractionRenderer): RendererDisposable {
    return this.add(this.interaction, renderer, 'interaction');
  }

  renderActivity(
    event: DshActivityEvent,
    context: RendererContext
  ): HTMLElement {
    return renderWithFallback(
      selectRenderer(this.activity, event),
      event,
      context,
      activityFallback
    );
  }

  renderArtifact(
    event: DshArtifactEvent,
    context: RendererContext
  ): HTMLElement {
    return renderWithFallback(
      selectRenderer(this.artifact, event),
      event,
      context,
      artifactFallback
    );
  }

  renderInteraction(
    event: DshInteractionRequestedEvent,
    context: RendererContext
  ): HTMLElement {
    return renderWithFallback(
      selectRenderer(this.interaction, event),
      event,
      context,
      interactionFallback
    );
  }

  /** Remove every registered renderer; the registry remains usable. */
  dispose(): void {
    this.activity.length = 0;
    this.artifact.length = 0;
    this.interaction.length = 0;
    this.order = 0;
  }

  private add<TEvent>(
    entries: RendererEntry<TEvent>[],
    renderer: Renderer<TEvent>,
    kind: string
  ): RendererDisposable {
    if (!renderer.id) {
      throw new Error(`${kind} renderer id must be non-empty`);
    }
    if (entries.some(entry => entry.renderer.id === renderer.id)) {
      throw new Error(`Duplicate ${kind} renderer id: ${renderer.id}`);
    }
    const entry: RendererEntry<TEvent> = { renderer, order: this.order++ };
    entries.push(entry);
    let disposed = false;
    return {
      id: renderer.id,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const index = entries.indexOf(entry);
        if (index >= 0) {
          entries.splice(index, 1);
        }
      }
    };
  }
}

/**
 * Pick the winning renderer. A throwing `match` is treated as "does not
 * match" so one broken renderer cannot break resolution for the others.
 */
function selectRenderer<TEvent>(
  entries: readonly RendererEntry<TEvent>[],
  event: TEvent
): Renderer<TEvent> | null {
  let best: RendererEntry<TEvent> | null = null;
  for (const entry of entries) {
    let matched = false;
    try {
      matched = entry.renderer.match(event);
    } catch {
      matched = false;
    }
    if (!matched) {
      continue;
    }
    if (
      !best ||
      (entry.renderer.priority ?? DEFAULT_PRIORITY) >
        (best.renderer.priority ?? DEFAULT_PRIORITY)
    ) {
      best = entry;
    }
  }
  return best ? best.renderer : null;
}

/**
 * Run the winning renderer, falling back on throw or a non-element result.
 * The fallback is a plain function, never a registered renderer, so a failing
 * renderer can never re-enter rendering.
 */
function renderWithFallback<TEvent>(
  renderer: Renderer<TEvent> | null,
  event: TEvent,
  context: RendererContext,
  fallback: Fallback<TEvent>
): HTMLElement {
  if (renderer) {
    try {
      const output = renderer.render(event, context);
      if (output instanceof HTMLElement) {
        return output;
      }
    } catch {
      // Fall through to the safe fallback.
    }
  }
  return fallback(event);
}

function textLine(
  tag: 'div' | 'li' | 'p' | 'span',
  className: string,
  text: string
): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  // textContent only: untrusted event text is never parsed as HTML or a URI.
  element.textContent = text;
  return element;
}

function fallbackRoot(className: string, kind: string): HTMLElement {
  const root = document.createElement('div');
  root.className = `jp-Dsh-rendererFallback ${className}`;
  root.dataset.rendererFallback = kind;
  return root;
}

/** Unknown/tool-less activity: label + phase/status/output as inert text. */
function activityFallback(event: DshActivityEvent): HTMLElement {
  const root = fallbackRoot('jp-Dsh-activityFallback', 'activity');
  root.dataset.activityId = event.activityId;
  if (event.toolName) {
    root.dataset.toolName = event.toolName;
  }
  root.append(
    textLine(
      'span',
      'jp-Dsh-fallbackTitle',
      event.toolName ?? event.label ?? 'activity'
    )
  );
  const meta: string[] = [event.phase];
  if (event.status) {
    meta.push(event.status);
  }
  root.append(textLine('span', 'jp-Dsh-fallbackMeta', meta.join(' · ')));
  if (event.outputSummary) {
    root.append(textLine('p', 'jp-Dsh-fallbackText', event.outputSummary));
  }
  return root;
}

/**
 * Artifact fallback shows identity only. `uri` is deliberately never rendered
 * as an anchor or clickable target: the protocol treats it as text, not proof
 * of a safe scheme.
 */
function artifactFallback(event: DshArtifactEvent): HTMLElement {
  const root = fallbackRoot('jp-Dsh-artifactFallback', 'artifact');
  root.dataset.artifactId = event.artifactId;
  root.append(
    textLine('span', 'jp-Dsh-fallbackTitle', event.name ?? event.artifactId)
  );
  const meta: string[] = [event.phase];
  if (event.mediaType) {
    meta.push(event.mediaType);
  }
  if (event.source) {
    meta.push(event.source);
  }
  root.append(textLine('span', 'jp-Dsh-fallbackMeta', meta.join(' · ')));
  if (event.unavailableReason) {
    root.append(textLine('p', 'jp-Dsh-fallbackText', event.unavailableReason));
  }
  return root;
}

/**
 * Interaction fallback shows the prompt and option labels as inert text. It
 * offers no controls: this step does not decide concrete interaction views, so
 * no action is presented without an explicit renderer + host wiring.
 */
function interactionFallback(event: DshInteractionRequestedEvent): HTMLElement {
  const root = fallbackRoot('jp-Dsh-interactionFallback', 'interaction');
  root.dataset.requestId = event.requestId;
  root.dataset.interactionKind = event.kind;
  root.append(textLine('span', 'jp-Dsh-fallbackTitle', event.kind));
  root.append(textLine('p', 'jp-Dsh-fallbackText', event.prompt));
  if (event.options && event.options.length) {
    const list = document.createElement('ul');
    list.className = 'jp-Dsh-fallbackOptions';
    event.options.forEach(option => {
      list.append(textLine('li', 'jp-Dsh-fallbackOption', option.label));
    });
    root.append(list);
  }
  return root;
}
