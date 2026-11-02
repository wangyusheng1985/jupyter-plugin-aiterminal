import type {
  DshArtifactEvent,
  DshArtifactPhase,
  DshArtifactSource
} from './protocol';
import {
  isCapabilityAvailable,
  type RendererContext,
  type RendererDisposable,
  type RendererHostCallbacks,
  type RendererRegistry
} from './renderers';

/**
 * One projected artifact. Identity intentionally excludes `runtimeId`: a
 * reconnect creates a new runtime generation but must not duplicate or drop
 * durable session artifacts. `runId` stays part of the identity because the
 * protocol scopes artifact events to one run.
 */
export interface ArtifactRecord {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly phase: DshArtifactPhase;
  readonly name?: string;
  readonly source?: DshArtifactSource;
  readonly mediaType?: string;
  readonly uri?: string;
  readonly unavailableReason?: string;
}

/** Stable map key; JSON encoding prevents separator collisions in untrusted ids. */
export function artifactIdentityKey(
  artifact: Pick<DshArtifactEvent, 'sessionId' | 'runId' | 'artifactId'>
): string {
  return JSON.stringify([
    artifact.sessionId,
    artifact.runId,
    artifact.artifactId
  ]);
}

/** Copy only declared fields from an event; never forward unknown payload data. */
export function artifactRecordFromEvent(
  event: DshArtifactEvent
): ArtifactRecord {
  return {
    sessionId: event.sessionId,
    runtimeId: event.runtimeId,
    runId: event.runId,
    artifactId: event.artifactId,
    phase: event.phase,
    ...(event.name === undefined ? {} : { name: event.name }),
    ...(event.source === undefined ? {} : { source: event.source }),
    ...(event.mediaType === undefined ? {} : { mediaType: event.mediaType }),
    ...(event.uri === undefined ? {} : { uri: event.uri }),
    ...(event.unavailableReason === undefined
      ? {}
      : { unavailableReason: event.unavailableReason })
  };
}

/**
 * Small state projection for artifact lifecycle events. Created/updated events
 * for the same session/run/artifact merge into one record; deletes remove it.
 * A new `runtimeId` updates the same record instead of appending a duplicate.
 */
export class ArtifactProjection {
  private readonly records = new Map<string, ArtifactRecord>();

  apply(event: DshArtifactEvent): ArtifactRecord | null {
    const key = artifactIdentityKey(event);
    if (event.phase === 'deleted') {
      this.records.delete(key);
      return null;
    }

    const previous = this.records.get(key);
    const unavailableReason =
      event.unavailableReason ??
      (event.uri === undefined ? previous?.unavailableReason : undefined);
    // An explicit unavailable reason supersedes a stale locator; a new locator
    // supersedes a stale reason. Never offer both at once.
    const uri =
      unavailableReason !== undefined
        ? undefined
        : (event.uri ?? previous?.uri);

    const name = event.name ?? previous?.name;
    const source = event.source ?? previous?.source;
    const mediaType = event.mediaType ?? previous?.mediaType;

    const record: ArtifactRecord = {
      sessionId: event.sessionId,
      runtimeId: event.runtimeId,
      runId: event.runId,
      artifactId: event.artifactId,
      phase: event.phase,
      ...(name === undefined ? {} : { name }),
      ...(source === undefined ? {} : { source }),
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(uri === undefined ? {} : { uri }),
      ...(unavailableReason === undefined ? {} : { unavailableReason })
    };
    this.records.set(key, record);
    return record;
  }

  get(
    artifact: Pick<DshArtifactEvent, 'sessionId' | 'runId' | 'artifactId'>
  ): ArtifactRecord | undefined {
    return this.records.get(artifactIdentityKey(artifact));
  }

  list(): ArtifactRecord[] {
    return Array.from(this.records.values());
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}

export type WorkspacePathRejection =
  | 'missing_uri'
  | 'nul_byte'
  | 'control_character'
  | 'backslash'
  | 'absolute_path'
  | 'protocol_relative'
  | 'scheme'
  | 'query_or_fragment'
  | 'traversal'
  | 'empty_segment'
  | 'malformed_escape'
  | 'nested_escape';

export type WorkspacePathCheck =
  { ok: true; path: string } | { ok: false; reason: WorkspacePathRejection };

const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const PATH_REJECTION_TEXT: Record<WorkspacePathRejection, string> = {
  missing_uri: 'No workspace path was provided.',
  nul_byte: 'Path contains a NUL byte.',
  control_character: 'Path contains control characters.',
  backslash:
    'Path uses backslashes; only workspace-relative forward-slash paths can be opened.',
  absolute_path: 'Absolute paths are not opened from the transcript.',
  protocol_relative: 'Protocol-relative URLs are not opened.',
  scheme: 'URL schemes are not opened from the transcript.',
  query_or_fragment: 'Paths with query or fragment components are not opened.',
  traversal: 'Path traversal ("..") is not allowed.',
  empty_segment: 'Path contains an empty segment.',
  malformed_escape: 'Path contains malformed percent-encoding.',
  nested_escape: 'Path contains nested percent-encoding.'
};

/**
 * Safe default for artifact locators: accept only a workspace-relative file
 * path. The protocol is text-validated only, so a syntactically valid URI is
 * not treated as proof that opening it is safe.
 *
 * This is a browser-side shape check, never an authorization check: it runs on
 * untrusted event text and proves nothing about the server. Absolute paths are
 * rejected because this module does not know the workspace root. A workspace-
 * relative path can still leave the root through a symbolic link, and this
 * function performs no symlink/realpath resolution; a host that resolves the
 * path must realpath it and verify the result stays inside its workspace root
 * before opening. Browser validation therefore never substitutes for server
 * authorization.
 *
 * Decode exactly once and reject any surviving `%` so double-encoded traversal
 * cannot reach the host. That conservative rule also refuses a legitimate file
 * whose decoded name contains a literal `%` (for example `a%b.md`); this is a
 * deliberate trade-off, not a policy to relax here.
 */
export function checkWorkspaceRelativePath(
  uri: string | undefined
): WorkspacePathCheck {
  if (typeof uri !== 'string' || uri.length === 0) {
    return { ok: false, reason: 'missing_uri' };
  }
  if (uri.includes('\u0000')) {
    return { ok: false, reason: 'nul_byte' };
  }
  if (hasControlCharacter(uri)) {
    return { ok: false, reason: 'control_character' };
  }
  if (uri.includes('\\')) {
    return { ok: false, reason: 'backslash' };
  }
  if (uri.startsWith('//')) {
    return { ok: false, reason: 'protocol_relative' };
  }
  if (uri.startsWith('/') || uri.startsWith('~')) {
    return { ok: false, reason: 'absolute_path' };
  }
  if (WINDOWS_ABSOLUTE.test(uri)) {
    return { ok: false, reason: 'absolute_path' };
  }
  if (URI_SCHEME.test(uri) || uri.includes(':')) {
    return { ok: false, reason: 'scheme' };
  }
  if (uri.includes('?') || uri.includes('#')) {
    return { ok: false, reason: 'query_or_fragment' };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return { ok: false, reason: 'malformed_escape' };
  }
  // Decode once, then reject a surviving escape marker so double-encoded
  // traversal/backslash payloads cannot reach the host.
  if (decoded.includes('%')) {
    return { ok: false, reason: 'nested_escape' };
  }
  if (decoded.includes('\u0000')) {
    return { ok: false, reason: 'nul_byte' };
  }
  if (hasControlCharacter(decoded)) {
    return { ok: false, reason: 'control_character' };
  }
  if (decoded.includes('\\')) {
    return { ok: false, reason: 'backslash' };
  }
  if (decoded.startsWith('//')) {
    return { ok: false, reason: 'protocol_relative' };
  }
  if (decoded.startsWith('/') || decoded.startsWith('~')) {
    return { ok: false, reason: 'absolute_path' };
  }
  if (WINDOWS_ABSOLUTE.test(decoded) || /^[a-zA-Z]:/.test(decoded)) {
    return { ok: false, reason: 'absolute_path' };
  }
  if (URI_SCHEME.test(decoded) || decoded.includes(':')) {
    return { ok: false, reason: 'scheme' };
  }
  if (decoded.includes('?') || decoded.includes('#')) {
    return { ok: false, reason: 'query_or_fragment' };
  }

  const segments = decoded.split('/');
  if (segments.some(segment => segment === '..')) {
    return { ok: false, reason: 'traversal' };
  }
  if (segments.some(segment => segment.length === 0)) {
    return { ok: false, reason: 'empty_segment' };
  }
  return { ok: true, path: decoded };
}

export type ArtifactOpenBlockCode =
  | 'deleted'
  | 'no_uri'
  | 'unavailable'
  | 'unsafe_path'
  | 'capability_unavailable'
  | 'capability_unverified'
  | 'missing_host';

export type ArtifactOpenDecision =
  | { canOpen: true; path: string }
  | { canOpen: false; code: ArtifactOpenBlockCode; reason: string };

/**
 * Decide whether this module may hand an artifact to the host. Every gate must
 * pass: the artifact is current, it has a safe workspace-relative path, the
 * runtime advertises `artifacts: available`, and the host exposes a callback.
 */
export function artifactOpenDecision(
  record: ArtifactRecord,
  context: RendererContext
): ArtifactOpenDecision {
  if (record.phase === 'deleted') {
    return {
      canOpen: false,
      code: 'deleted',
      reason: 'This artifact was deleted.'
    };
  }
  if (record.unavailableReason !== undefined) {
    return {
      canOpen: false,
      code: 'unavailable',
      reason: record.unavailableReason
    };
  }
  if (record.uri === undefined) {
    return {
      canOpen: false,
      code: 'no_uri',
      reason: 'No workspace path was provided for this artifact.'
    };
  }

  const pathCheck = checkWorkspaceRelativePath(record.uri);
  if (!pathCheck.ok) {
    return {
      canOpen: false,
      code: 'unsafe_path',
      reason: PATH_REJECTION_TEXT[pathCheck.reason]
    };
  }

  if (!isCapabilityAvailable(context, 'artifacts')) {
    const status = context.capabilities.artifacts;
    return status?.status === 'unavailable'
      ? {
          canOpen: false,
          code: 'capability_unavailable',
          reason:
            status.reason ?? 'Artifact support is unavailable for this runtime.'
        }
      : {
          canOpen: false,
          code: 'capability_unverified',
          reason: 'Artifact support has not been verified for this runtime.'
        };
  }

  const host: Partial<RendererHostCallbacks> | undefined = context.host;
  if (!host || typeof host.openArtifact !== 'function') {
    return {
      canOpen: false,
      code: 'missing_host',
      reason: 'This view has no host hook for opening artifacts.'
    };
  }

  return { canOpen: true, path: pathCheck.path };
}

export function artifactDisplayName(
  record: Pick<ArtifactRecord, 'name' | 'artifactId'>
): string {
  return record.name ?? record.artifactId;
}

export function artifactSourceLabel(
  source: DshArtifactSource | undefined
): string {
  switch (source) {
    case 'presented':
      return 'Presented';
    case 'workspace_change':
      return 'Workspace change';
    default:
      return 'Source unknown';
  }
}

const PHASE_LABEL: Record<DshArtifactPhase, string> = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted'
};

const NOT_VERIFIED_NOTE = 'Reported by runtime; contents not verified.';
let artifactCardCounter = 0;

function nextCardId(): string {
  artifactCardCounter += 1;
  return `jp-Dsh-artifact-${artifactCardCounter}`;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  // textContent only: runtime names and reasons are never parsed as HTML.
  element.textContent = text;
  return element;
}

function describeHostError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'the host rejected the request';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Render one artifact as inert text plus a single explicit Open control. It
 * never fetches, stats, or otherwise verifies the file, and it never renders
 * the locator as an anchor. Host errors stay visible in the card instead of
 * becoming unhandled rejections.
 */
export function renderArtifactCard(
  record: ArtifactRecord,
  context: RendererContext
): HTMLElement {
  const decision = artifactOpenDecision(record, context);
  const name = artifactDisplayName(record);
  const root = document.createElement('article');
  root.className = `jp-Dsh-artifactCard jp-Dsh-artifactCard--${record.phase}`;
  root.dataset.artifactId = record.artifactId;
  root.dataset.artifactPhase = record.phase;
  root.dataset.artifactVerified = 'false';
  root.dataset.artifactOpenable = String(decision.canOpen);
  if (record.source !== undefined) {
    root.dataset.artifactSource = record.source;
  }
  root.setAttribute('aria-label', `Artifact ${name}`);

  const cardId = nextCardId();
  const header = document.createElement('div');
  header.className = 'jp-Dsh-artifactHeader';
  header.append(textElement('span', 'jp-Dsh-artifactName', name));
  root.append(header);

  const meta = document.createElement('div');
  meta.className = 'jp-Dsh-artifactMeta';
  const sourceLabel = textElement(
    'span',
    'jp-Dsh-artifactSource',
    artifactSourceLabel(record.source)
  );
  if (record.source === undefined) {
    sourceLabel.dataset.sourceUnknown = 'true';
  }
  meta.append(
    sourceLabel,
    textElement(
      'span',
      'jp-Dsh-artifactMediaType',
      record.mediaType ?? 'Media type unknown'
    ),
    textElement('span', 'jp-Dsh-artifactPhase', PHASE_LABEL[record.phase])
  );
  root.append(meta);

  const note = textElement(
    'p',
    'jp-Dsh-artifactVerification',
    NOT_VERIFIED_NOTE
  );
  note.id = `${cardId}-note`;
  root.append(note);

  if (record.unavailableReason !== undefined) {
    root.append(
      textElement(
        'p',
        'jp-Dsh-artifactUnavailable',
        `Unavailable: ${record.unavailableReason}`
      )
    );
  }

  let reason: HTMLElement | null = null;
  if (!decision.canOpen) {
    reason = textElement(
      'p',
      'jp-Dsh-artifactOpenBlocked',
      `Cannot open: ${decision.reason}`
    );
    reason.id = `${cardId}-reason`;
    root.append(reason);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jp-Dsh-artifactOpen';
  button.textContent = 'Open';
  button.disabled = !decision.canOpen;
  button.setAttribute('aria-label', `Open ${name}`);
  const describedBy = reason ? `${note.id} ${reason.id}` : note.id;
  button.setAttribute('aria-describedby', describedBy);
  root.append(button);

  const error = document.createElement('p');
  error.className = 'jp-Dsh-artifactOpenError';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(error);

  // A card can outlive the view (external refs, registry reuse). Once disposed,
  // the Open listener is removed and any late host outcome is ignored so a
  // stale button or a settled Promise can never reach the host or mutate a
  // destroyed card.
  const lifecycle: CardLifecycle = { disposed: false, dispose: () => {} };

  const showHostError = (hostError: unknown): void => {
    if (lifecycle.disposed) {
      return;
    }
    error.hidden = false;
    error.textContent = `Could not open artifact: ${describeHostError(hostError)}`;
  };

  const handleOpenClick = (): void => {
    if (lifecycle.disposed || !decision.canOpen) {
      return;
    }
    error.hidden = true;
    error.textContent = '';
    let outcome: unknown;
    try {
      outcome = context.host.openArtifact(record.artifactId, decision.path);
    } catch (hostError) {
      showHostError(hostError);
      return;
    }
    if (isThenable(outcome)) {
      void Promise.resolve(outcome).catch(showHostError);
    }
  };
  button.addEventListener('click', handleOpenClick);

  lifecycle.dispose = () => {
    if (lifecycle.disposed) {
      return;
    }
    lifecycle.disposed = true;
    button.removeEventListener('click', handleOpenClick);
  };
  cardLifecycles.set(root, lifecycle);

  return root;
}

interface CardLifecycle {
  disposed: boolean;
  dispose: () => void;
}

const cardLifecycles = new WeakMap<HTMLElement, CardLifecycle>();

/**
 * Detach the Open control from a card returned by `renderArtifactCard`. Callers
 * that own a rendered card (the view, or a registry integration) must call this
 * before dropping their reference so an externally held Open button can no
 * longer call `host.openArtifact`. Calling it more than once is a no-op.
 */
export function disposeArtifactCard(card: HTMLElement): void {
  cardLifecycles.get(card)?.dispose();
}

/**
 * Register the default artifact renderer. The returned handle is disposable so
 * the workspace integration can detach it without clearing the registry.
 */
export function registerArtifactRenderer(
  registry: RendererRegistry
): RendererDisposable {
  return registry.registerArtifact({
    id: 'artifact-card',
    match: () => true,
    render: (event, context) =>
      renderArtifactCard(artifactRecordFromEvent(event), context)
  });
}

/**
 * Minimal list view backed by `ArtifactProjection`. It keeps the latest record
 * per session/run/artifact and rerenders on each accepted lifecycle event.
 */
export class ArtifactView {
  readonly element: HTMLDivElement;
  readonly projection = new ArtifactProjection();
  private context: RendererContext;
  private cards: HTMLElement[] = [];

  constructor(context: RendererContext) {
    this.context = context;
    this.element = document.createElement('div');
    this.element.className = 'jp-Dsh-artifactList';
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', 'Artifacts'); // eslint-disable-line jupyter/no-untranslated-string
    this.render();
  }

  apply(event: DshArtifactEvent): ArtifactRecord | null {
    const record = this.projection.apply(event);
    this.render();
    return record;
  }

  get records(): readonly ArtifactRecord[] {
    return this.projection.list();
  }

  setContext(context: RendererContext): void {
    this.context = context;
    this.render();
  }

  dispose(): void {
    this.disposeCards();
    this.projection.clear();
    this.element.replaceChildren();
    this.element.remove();
  }

  private disposeCards(): void {
    for (const card of this.cards) {
      disposeArtifactCard(card);
    }
    this.cards = [];
  }

  private render(): void {
    // Every accepted event, context change, and dispose replaces the cards;
    // detach the previous Open controls first so stale buttons go inert.
    this.disposeCards();
    const records = this.projection.list();
    if (records.length === 0) {
      this.element.replaceChildren(
        textElement(
          'p',
          'jp-Dsh-artifactEmpty',
          'No artifacts reported for this session.'
        )
      );
      return;
    }
    const cards = records.map(record =>
      renderArtifactCard(record, this.context)
    );
    this.cards = cards;
    this.element.replaceChildren(...cards);
  }
}
