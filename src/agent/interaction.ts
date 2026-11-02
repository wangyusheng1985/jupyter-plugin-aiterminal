import { nullTranslator } from '@jupyterlab/translation';

import type {
  DshCapabilityManifest,
  DshCapabilityName,
  DshInteractionCancelledEvent,
  DshInteractionKind,
  DshInteractionRequestedEvent,
  DshInteractionResolution,
  DshInteractionResolvedEvent
} from './protocol';
import { TRANSLATION_DOMAIN } from '../theme';

const trans = nullTranslator.load(TRANSLATION_DOMAIN);

/**
 * Interaction views for the DSH `question` and `approval` kinds.
 *
 * This module is DOM-only and self-contained: it never opens artifacts,
 * evaluates code, or talks to a network. The runtime contract exposes a single
 * `resolveInteraction(requestId, { optionId?, text? })` host callback with no
 * separate resolution argument, so approval option ids are an explicit,
 * documented handoff:
 *
 * - `APPROVAL_ALLOW_ONCE_OPTION_ID` (`approved`) means "allow this one
 *   request".
 * - `APPROVAL_REJECT_OPTION_ID` (`rejected`) means "reject this request".
 *
 * There is deliberately no permanent-approval option. A host that receives
 * one of these ids is responsible for mapping it to the runtime's `approved` /
 * `rejected` resolution.
 *
 * Sending a decision is not the same as the runtime resolving it. A host call
 * that returns normally (including `void`) only moves the view to `awaiting`;
 * the view reaches `resolved` solely when an `interaction.resolved` event
 * arrives. A rejected promise or a synchronous throw only proves the runtime
 * did *not confirm* the decision, not that it was never delivered. Without an
 * explicit "definitely not sent" error contract the outcome is unknown, so the
 * record is locked (`deliveryUnknown`) and cannot be re-selected or re-sent; a
 * user must never flip a possibly-delivered `approved` into a later `rejected`.
 * Only an authoritative `interaction.resolved` / `interaction.cancelled` event
 * clears an unknown outcome — never the host's own error, which is never
 * treated as approval, and there is no automatic retry. A resolved or cancelled
 * event is terminal and a late host result cannot reopen it.
 *
 * Note on naming: this module's `InteractionRenderer` is a *stateful* view
 * (it owns `update`/`dispose` and is driven by the coordinator's lifecycle). It
 * is deliberately distinct from `renderers.ts`'s stateless, one-shot
 * `InteractionRenderer` (`render(event, context): HTMLElement`), which cannot
 * drive `awaiting`/`resolved`. Do not cross-assign the two types. Step 9 wiring
 * must dispatch `interaction.requested` / `.resolved` / `.cancelled` directly to
 * `InteractionCoordinator.handleRequested` / `handleResolved` / `handleCancelled`.
 * `RendererRegistry` stays for activity/artifact only: interaction kinds,
 * including unknown ones, are handled solely by this coordinator, whose
 * fallback view is the single unknown-kind path (no double dispatch).
 */

export const APPROVAL_ALLOW_ONCE_OPTION_ID = 'approved' as const;
export const APPROVAL_REJECT_OPTION_ID = 'rejected' as const;

export interface InteractionResolutionInput {
  optionId?: string;
  text?: string;
}

/**
 * Host callback shape. It is structurally compatible with
 * `RendererHostCallbacks` (`void` is assignable to `void | Promise<void>`).
 * A Promise-returning host gets awaited for send completion only; it is still
 * not proof that the runtime approved anything.
 */
/** Session/run/request identity of one interaction. */
export interface InteractionScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly requestId: string;
}

/**
 * Host callback shape. It is structurally compatible with
 * `RendererHostCallbacks` (`void` is assignable to `void | Promise<void>`; the
 * extra optional `scope` is ignorable).
 *
 * `scope` is optional only for structural compatibility; this coordinator always
 * passes it. `requestId` alone is ambiguous because request ids repeat across
 * sessions, and only this coordinator knows the owning `(sessionId, runId)`, so
 * a host must route the decision using `scope` to avoid delivering it to the
 * wrong session.
 *
 * A Promise-returning host gets awaited for send completion only; it is still
 * not proof that the runtime approved anything.
 */
export interface InteractionHost {
  resolveInteraction(
    requestId: string,
    resolution: InteractionResolutionInput,
    scope?: InteractionScope
  ): void | Promise<void>;
}

export type InteractionPhase =
  'requested' | 'sending' | 'awaiting' | 'resolved' | 'cancelled' | 'failed';

export interface InteractionViewState {
  readonly phase: InteractionPhase;
  readonly capabilities: DshCapabilityManifest;
  readonly resolution?: DshInteractionResolution;
  readonly error?: string;
  /** True when a send failure may still have delivered the decision. */
  readonly deliveryUnknown?: boolean;
}

/** DOM produced by an interaction renderer; `update` is idempotent. */
export interface InteractionView {
  readonly element: HTMLElement;
  update(state: InteractionViewState): void;
  dispose(): void;
}

export interface InteractionActions {
  /** Only called from an explicit user click; the coordinator re-validates. */
  resolve(input: InteractionResolutionInput): void;
}

export interface InteractionRendererContext {
  readonly request: DshInteractionRequestedEvent;
  readonly capabilities: DshCapabilityManifest;
  readonly host: InteractionHost;
  readonly actions: InteractionActions;
}

/**
 * Renderer for one interaction kind. Matching is a predicate so callers can
 * replace or extend the built-in question/approval renderers without this
 * module inventing a fixed registry taxonomy.
 */
export interface InteractionRenderer {
  readonly id: string;
  readonly priority?: number;
  match(request: DshInteractionRequestedEvent): boolean;
  render(context: InteractionRendererContext): InteractionView;
}

export interface InteractionDisposable {
  readonly id: string;
  dispose(): void;
}

export interface InteractionRecord {
  readonly key: string;
  readonly request: DshInteractionRequestedEvent;
  readonly phase: InteractionPhase;
  readonly resolution?: DshInteractionResolution;
  readonly error?: string;
  /** The last decision handed to the host, kept as delivery evidence. */
  readonly lastInput?: InteractionResolutionInput;
  /** True when the last send's delivery outcome is unknown (locked). */
  readonly deliveryUnknown?: boolean;
}

export interface InteractionCoordinatorOptions {
  /** Only this coordinator's own roots are appended/removed here. */
  container: HTMLElement;
  host: InteractionHost;
  capabilities?: DshCapabilityManifest;
}

interface RendererEntry {
  readonly renderer: InteractionRenderer;
  readonly order: number;
}

interface InteractionEntry {
  readonly key: string;
  readonly request: DshInteractionRequestedEvent;
  phase: InteractionPhase;
  resolution?: DshInteractionResolution;
  error?: string;
  lastInput?: InteractionResolutionInput;
  deliveryUnknown?: boolean;
  view: InteractionView | null;
}

const DEFAULT_PRIORITY = 0;
const KEY_SEPARATOR = '\u0000';

let viewSequence = 0;

/** Correlates a request across session, run, and request id. */
export function interactionKey(scope: InteractionScope): string {
  return [scope.sessionId, scope.runId, scope.requestId].join(KEY_SEPARATOR);
}

function capabilityNameForKind(kind: DshInteractionKind): DshCapabilityName {
  return kind === 'question' ? 'questions' : 'approval';
}

function kindLabel(kind: DshInteractionKind): string {
  return kind === 'question' ? 'Questions' : 'Approval';
}

/**
 * Human-readable reason why an interaction may not be acted on. `unverified`
 * is intentionally not treated as `unavailable`, but both disable controls.
 */
export function capabilityBlockMessage(
  capabilities: DshCapabilityManifest,
  kind: DshInteractionKind
): string | null {
  const name = capabilityNameForKind(kind);
  const capability = capabilities[name];
  if (capability?.status === 'available') {
    return null;
  }
  const subject = kindLabel(kind);
  const verb = kind === 'question' ? 'are' : 'is';
  if (capability?.status === 'unverified') {
    return `${subject} ${verb} not verified for this runtime.`;
  }
  if (capability?.status === 'unavailable') {
    return `${subject} ${verb} not supported by this runtime.`;
  }
  return `${subject} ${verb} not available in this runtime.`;
}

/**
 * Validate a decision before it reaches the host. Returns a user-visible
 * message, or `null` when the input is legal for the request.
 */
export function validateInteractionResolution(
  request: DshInteractionRequestedEvent,
  input: InteractionResolutionInput
): string | null {
  const optionId = input.optionId;
  const text = input.text?.trim() ?? '';
  if (optionId && text) {
    return 'Choose an option or enter text, not both.';
  }
  if (request.kind === 'approval') {
    if (text) {
      return 'Approval decisions use the allow-once or reject button.';
    }
    if (
      optionId !== APPROVAL_ALLOW_ONCE_OPTION_ID &&
      optionId !== APPROVAL_REJECT_OPTION_ID
    ) {
      return 'Approval must be either allow once or reject.';
    }
    return null;
  }
  if (text && !request.allowFreeText) {
    return 'Free-text answers are not allowed for this request.';
  }
  if (optionId) {
    const known = request.options?.some(option => option.id === optionId);
    return known ? null : 'That answer option is not available.';
  }
  if (text) {
    return null;
  }
  if (!request.options?.length && !request.allowFreeText) {
    return 'No answer option is available for this request.';
  }
  return 'Choose an option or enter an answer.';
}

function textBlock(
  tag: 'p' | 'span',
  className: string,
  text: string
): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function createButton(
  label: string,
  className: string,
  onClick: () => void,
  signal: AbortSignal
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick, { signal });
  return button;
}

function nextElementId(prefix: string): string {
  viewSequence += 1;
  return `jp-Dsh-interaction-${prefix}-${viewSequence}`;
}

function isTerminal(phase: InteractionPhase): boolean {
  return phase === 'resolved' || phase === 'cancelled';
}

function isBlocked(phase: InteractionPhase): boolean {
  return (
    phase === 'sending' ||
    phase === 'awaiting' ||
    phase === 'resolved' ||
    phase === 'cancelled'
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'The decision could not be sent.';
}

function statusText(state: InteractionViewState): string {
  switch (state.phase) {
    case 'requested':
      return '';
    case 'sending':
      return 'Sending decision…';
    case 'awaiting':
      return 'Decision sent. Waiting for the runtime to confirm.';
    case 'resolved':
      return state.resolution ? `Resolved: ${state.resolution}.` : 'Resolved.';
    case 'cancelled':
      return 'Request cancelled by the runtime.';
    case 'failed':
      return state.deliveryUnknown
        ? 'The decision may not have reached the runtime.'
        : 'The decision was not sent. You can try again.';
  }
}

function applyStatus(
  status: HTMLElement,
  error: HTMLElement,
  state: InteractionViewState
): void {
  status.textContent = statusText(state);
  if (state.error) {
    error.hidden = false;
    error.textContent = state.error;
  } else {
    error.hidden = true;
    error.textContent = '';
  }
}

function createQuestionView(
  context: InteractionRendererContext
): InteractionView {
  const { request } = context;
  const controller = new AbortController();
  const root = document.createElement('section');
  root.className = 'jp-Dsh-interaction jp-Dsh-question';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', trans.__('Agent question'));
  root.dataset.requestId = request.requestId;
  root.dataset.interactionKind = 'question';
  root.append(textBlock('p', 'jp-Dsh-interactionPrompt', request.prompt));

  const note = textBlock('p', 'jp-Dsh-interactionNote', '');
  note.setAttribute('role', 'note');
  root.append(note);

  const options = request.options ?? [];
  const optionButtons: HTMLButtonElement[] = [];
  if (options.length) {
    const list = document.createElement('div');
    list.className = 'jp-Dsh-questionOptions';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', trans.__('Answer options'));
    for (const option of options) {
      const button = createButton(
        option.label,
        'jp-Dsh-questionOption',
        () => context.actions.resolve({ optionId: option.id }),
        controller.signal
      );
      button.dataset.optionId = option.id;
      optionButtons.push(button);
      list.append(button);
    }
    root.append(list);
  }

  let input: HTMLTextAreaElement | null = null;
  let send: HTMLButtonElement | null = null;
  if (request.allowFreeText) {
    const label = document.createElement('label');
    label.className = 'jp-Dsh-interactionFieldLabel';
    const inputId = nextElementId('answer');
    label.htmlFor = inputId;
    label.textContent = 'Your answer';
    input = document.createElement('textarea');
    input.id = inputId;
    input.className = 'jp-Dsh-interactionInput';
    input.rows = 2;
    send = createButton(
      'Send answer',
      'jp-Dsh-interactionSubmit',
      () => {
        const text = input?.value.trim() ?? '';
        if (text) {
          context.actions.resolve({ text });
        }
      },
      controller.signal
    );
    input.addEventListener(
      'input',
      () => {
        if (send) {
          send.disabled = !input?.value.trim();
        }
      },
      { signal: controller.signal }
    );
    root.append(label, input, send);
  }

  const status = textBlock('p', 'jp-Dsh-interactionStatus', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = textBlock('p', 'jp-Dsh-interactionError', '');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(status, error);

  return {
    element: root,
    update(state) {
      root.dataset.phase = state.phase;
      const blockMessage = capabilityBlockMessage(
        state.capabilities,
        'question'
      );
      const noAnswerPath = !options.length && !request.allowFreeText;
      note.textContent =
        blockMessage ??
        (noAnswerPath ? 'No answer option is available for this request.' : '');
      note.hidden = note.textContent === '';
      const blocked = blockMessage !== null || isBlocked(state.phase);
      // A failed send is only retryable when delivery is *known* to have failed;
      // an unknown outcome stays locked to avoid a contradictory second decision.
      const retryable =
        state.phase === 'requested' ||
        (state.phase === 'failed' && !state.deliveryUnknown);
      const enabled = !blocked && retryable;
      for (const button of optionButtons) {
        button.disabled = !enabled;
      }
      if (input) {
        input.disabled = !enabled;
      }
      if (send) {
        send.disabled = !enabled || !input?.value.trim();
      }
      applyStatus(status, error, state);
    },
    dispose() {
      controller.abort();
      root.remove();
    }
  };
}

function createApprovalMetadata(
  label: string,
  value: string,
  className: string
): HTMLElement {
  const row = document.createElement('div');
  row.className = `jp-Dsh-approvalMeta ${className}`;
  row.append(textBlock('span', 'jp-Dsh-approvalMetaLabel', label));
  row.append(textBlock('span', 'jp-Dsh-approvalMetaValue', value));
  return row;
}

function createApprovalView(
  context: InteractionRendererContext
): InteractionView {
  const { request } = context;
  const controller = new AbortController();
  const root = document.createElement('section');
  root.className = 'jp-Dsh-interaction jp-Dsh-approval';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', trans.__('Agent approval request'));
  root.dataset.requestId = request.requestId;
  root.dataset.interactionKind = 'approval';
  root.append(textBlock('p', 'jp-Dsh-interactionPrompt', request.prompt));

  const meta = document.createElement('div');
  meta.className = 'jp-Dsh-approvalDetails';
  if (request.action) {
    meta.append(
      createApprovalMetadata('Action', request.action, 'jp-Dsh-approvalAction')
    );
  }
  if (request.target) {
    meta.append(
      createApprovalMetadata('Target', request.target, 'jp-Dsh-approvalTarget')
    );
  }
  if (meta.childElementCount) {
    root.append(meta);
  }

  const note = textBlock('p', 'jp-Dsh-interactionNote', '');
  note.setAttribute('role', 'note');
  root.append(note);

  const actions = document.createElement('div');
  actions.className = 'jp-Dsh-approvalActions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', trans.__('Approval decision'));
  const allow = createButton(
    'Allow once',
    'jp-Dsh-approvalAllow',
    () => context.actions.resolve({ optionId: APPROVAL_ALLOW_ONCE_OPTION_ID }),
    controller.signal
  );
  const reject = createButton(
    'Reject',
    'jp-Dsh-approvalReject',
    () => context.actions.resolve({ optionId: APPROVAL_REJECT_OPTION_ID }),
    controller.signal
  );
  actions.append(allow, reject);
  root.append(actions);

  const status = textBlock('p', 'jp-Dsh-interactionStatus', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = textBlock('p', 'jp-Dsh-interactionError', '');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(status, error);

  return {
    element: root,
    update(state) {
      root.dataset.phase = state.phase;
      const blockMessage = capabilityBlockMessage(
        state.capabilities,
        'approval'
      );
      note.textContent =
        blockMessage ?? 'This decision applies to this request only.';
      note.hidden = false;
      const enabled =
        blockMessage === null &&
        (state.phase === 'requested' ||
          (state.phase === 'failed' && !state.deliveryUnknown));
      allow.disabled = !enabled;
      reject.disabled = !enabled;
      applyStatus(status, error, state);
    },
    dispose() {
      controller.abort();
      root.remove();
    }
  };
}

function createFallbackView(
  request: DshInteractionRequestedEvent
): InteractionView {
  const root = document.createElement('section');
  root.className = 'jp-Dsh-interaction jp-Dsh-interactionFallback';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', trans.__('Agent interaction request'));
  root.dataset.requestId = request.requestId;
  root.dataset.interactionKind = request.kind;
  root.append(textBlock('p', 'jp-Dsh-interactionPrompt', request.prompt));
  if (request.options?.length) {
    const list = document.createElement('ul');
    list.className = 'jp-Dsh-interactionFallbackOptions';
    for (const option of request.options) {
      const item = document.createElement('li');
      item.textContent = option.label;
      list.append(item);
    }
    root.append(list);
  }
  const status = textBlock(
    'p',
    'jp-Dsh-interactionStatus',
    'No interactive renderer is available for this request.'
  );
  status.setAttribute('role', 'status');
  root.append(status);
  return {
    element: root,
    update(state) {
      root.dataset.phase = state.phase;
    },
    dispose() {
      root.remove();
    }
  };
}

/** Built-in renderer for `question`; replaceable through registration. */
export function createQuestionRenderer(): InteractionRenderer {
  return {
    id: 'dsh-question',
    match: request => request.kind === 'question',
    render: context => createQuestionView(context)
  };
}

/** Built-in renderer for `approval`; replaceable through registration. */
export function createApprovalRenderer(): InteractionRenderer {
  return {
    id: 'dsh-approval',
    match: request => request.kind === 'approval',
    render: context => createApprovalView(context)
  };
}

/**
 * State coordinator for interaction requests. It owns one record per
 * `(sessionId, runId, requestId)` triple and one DOM root per record. Duplicate
 * requested/resolved/cancelled events cannot create or reopen a decision.
 */
export class InteractionCoordinator {
  private readonly container: HTMLElement;
  private readonly host: InteractionHost;
  private capabilities: DshCapabilityManifest;
  private readonly renderers: RendererEntry[] = [];
  private readonly entries = new Map<string, InteractionEntry>();
  private order = 0;
  private disposed = false;

  constructor(options: InteractionCoordinatorOptions) {
    this.container = options.container;
    this.host = options.host;
    this.capabilities = options.capabilities ?? {};
    this.registerRenderer(createQuestionRenderer());
    this.registerRenderer(createApprovalRenderer());
  }

  /** Register a renderer; disposing the handle removes only that renderer. */
  registerRenderer(renderer: InteractionRenderer): InteractionDisposable {
    if (!renderer.id) {
      throw new Error('interaction renderer id must be non-empty');
    }
    if (this.renderers.some(entry => entry.renderer.id === renderer.id)) {
      throw new Error(`Duplicate interaction renderer id: ${renderer.id}`);
    }
    const entry: RendererEntry = { renderer, order: this.order++ };
    this.renderers.push(entry);
    let disposed = false;
    return {
      id: renderer.id,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const index = this.renderers.indexOf(entry);
        if (index >= 0) {
          this.renderers.splice(index, 1);
        }
      }
    };
  }

  /** Replace the capability manifest and refresh non-terminal records. */
  setCapabilities(capabilities: DshCapabilityManifest): void {
    this.capabilities = capabilities;
    for (const entry of this.entries.values()) {
      if (!isTerminal(entry.phase)) {
        this.update(entry);
      }
    }
  }

  /** Create a view once. A repeated requested event is a no-op. */
  handleRequested(
    event: DshInteractionRequestedEvent
  ): InteractionRecord | null {
    if (this.disposed) {
      return null;
    }
    const key = interactionKey(event);
    const existing = this.entries.get(key);
    if (existing) {
      return this.snapshot(existing);
    }

    const entry: InteractionEntry = {
      key,
      request: event,
      phase: 'requested',
      view: null
    };
    const renderer = this.selectRenderer(event);
    const context: InteractionRendererContext = {
      request: event,
      capabilities: this.capabilities,
      host: this.host,
      actions: {
        resolve: input => {
          this.submit(entry, input);
        }
      }
    };
    let view: InteractionView;
    try {
      view = renderer ? renderer.render(context) : createFallbackView(event);
    } catch {
      view = createFallbackView(event);
    }
    entry.view = view;
    this.entries.set(key, entry);
    this.container.append(view.element);
    this.update(entry);
    return this.snapshot(entry);
  }

  /** Apply a runtime resolution. Terminal records are never reopened. */
  handleResolved(event: DshInteractionResolvedEvent): boolean {
    const entry = this.entries.get(interactionKey(event));
    if (!entry || isTerminal(entry.phase)) {
      return false;
    }
    entry.phase = 'resolved';
    entry.resolution = event.resolution;
    entry.error = undefined;
    this.update(entry);
    return true;
  }

  /** Apply a runtime cancellation. Terminal records are never reopened. */
  handleCancelled(event: DshInteractionCancelledEvent): boolean {
    const entry = this.entries.get(interactionKey(event));
    if (!entry || isTerminal(entry.phase)) {
      return false;
    }
    entry.phase = 'cancelled';
    entry.error = undefined;
    this.update(entry);
    return true;
  }

  getRecord(
    sessionId: string,
    runId: string,
    requestId: string
  ): InteractionRecord | null {
    const entry = this.entries.get(
      interactionKey({ sessionId, runId, requestId })
    );
    return entry ? this.snapshot(entry) : null;
  }

  /**
   * Remove a terminal record and its DOM. Only `resolved` / `cancelled` records
   * can be dismissed; a `failed` record whose delivery outcome is unknown is
   * never dropped into a resendable state. Returns true when a record was
   * removed. Step 9 can call this to reclaim terminal views in long sessions.
   */
  dismiss(sessionId: string, runId: string, requestId: string): boolean {
    const key = interactionKey({ sessionId, runId, requestId });
    const entry = this.entries.get(key);
    if (!entry || !isTerminal(entry.phase)) {
      return false;
    }
    entry.view?.dispose();
    this.entries.delete(key);
    return true;
  }

  /** Remove listeners and this coordinator's own roots; nothing else. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.view?.dispose();
    }
    this.entries.clear();
    this.renderers.length = 0;
    this.order = 0;
  }

  private submit(
    entry: InteractionEntry,
    rawInput: InteractionResolutionInput
  ): boolean {
    if (this.disposed) {
      return false;
    }
    // A possibly-delivered decision is locked for good. A custom renderer can
    // still hold `actions.resolve` after the UI disables its buttons, so this
    // entry guard — not only the disabled controls — must reject any resend.
    if (entry.deliveryUnknown) {
      return false;
    }
    if (entry.phase !== 'requested' && entry.phase !== 'failed') {
      return false;
    }
    const blockMessage = capabilityBlockMessage(
      this.capabilities,
      entry.request.kind
    );
    if (blockMessage) {
      entry.error = blockMessage;
      this.update(entry);
      return false;
    }
    const invalid = validateInteractionResolution(entry.request, rawInput);
    if (invalid) {
      entry.error = invalid;
      this.update(entry);
      return false;
    }
    const input = normalizeResolution(rawInput);

    // Record the decision before the host sees it so a later failure keeps
    // evidence of what may have been delivered.
    entry.lastInput = input;
    entry.phase = 'sending';
    entry.error = undefined;
    entry.deliveryUnknown = undefined;
    this.update(entry);

    let result: unknown;
    try {
      result = this.host.resolveInteraction(entry.request.requestId, input, {
        sessionId: entry.request.sessionId,
        runId: entry.request.runId,
        requestId: entry.request.requestId
      });
    } catch (error) {
      this.fail(entry, error);
      return true;
    }

    if (isPromiseLike(result)) {
      result.then(
        () => {
          this.markAwaiting(entry);
        },
        error => {
          this.fail(entry, error);
        }
      );
    } else {
      this.markAwaiting(entry);
    }
    return true;
  }

  private markAwaiting(entry: InteractionEntry): void {
    if (this.disposed || entry.phase !== 'sending') {
      return;
    }
    entry.phase = 'awaiting';
    entry.error = undefined;
    this.update(entry);
  }

  private fail(entry: InteractionEntry, error: unknown): void {
    if (this.disposed || isTerminal(entry.phase)) {
      return;
    }
    // No "definitely not sent" error contract exists, so both a rejected
    // promise and a synchronous throw leave the delivery outcome unknown. Lock
    // the record; only an authoritative resolved/cancelled event clears it.
    entry.phase = 'failed';
    entry.error = errorMessage(error);
    entry.deliveryUnknown = true;
    this.update(entry);
  }

  private update(entry: InteractionEntry): void {
    entry.view?.update({
      phase: entry.phase,
      capabilities: this.capabilities,
      resolution: entry.resolution,
      error: entry.error,
      deliveryUnknown: entry.deliveryUnknown
    });
  }

  private snapshot(entry: InteractionEntry): InteractionRecord {
    return {
      key: entry.key,
      request: entry.request,
      phase: entry.phase,
      resolution: entry.resolution,
      error: entry.error,
      lastInput: entry.lastInput,
      deliveryUnknown: entry.deliveryUnknown
    };
  }

  private selectRenderer(
    request: DshInteractionRequestedEvent
  ): InteractionRenderer | null {
    let best: RendererEntry | null = null;
    for (const entry of this.renderers) {
      let matched = false;
      try {
        matched = entry.renderer.match(request);
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
}

function normalizeResolution(
  input: InteractionResolutionInput
): InteractionResolutionInput {
  const normalized: InteractionResolutionInput = {};
  if (input.optionId) {
    normalized.optionId = input.optionId;
  }
  const text = input.text?.trim();
  if (text) {
    normalized.text = text;
  }
  return normalized;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
