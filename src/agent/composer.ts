import { Widget } from '@lumino/widgets';
import { nullTranslator } from '@jupyterlab/translation';

import type { WorkspaceMode } from './protocol';
import { TRANSLATION_DOMAIN } from '../theme';

const trans = nullTranslator.load(TRANSLATION_DOMAIN);

export type ComposerMode = 'agent' | 'shell';

export interface ComposerSubmitPayload {
  readonly source: string;
  readonly kind: WorkspaceMode;
  readonly mode: ComposerMode;
}

export interface AgentComposerOptions {
  initialMode?: ComposerMode;
  initialDraft?: string;
  cwd?: string;
  queueCount?: number;
  busy?: boolean;
  onModeChange?: (mode: ComposerMode, kind: WorkspaceMode) => void;
  onSource?: (draft: string) => void;
  onSubmit?: (payload: ComposerSubmitPayload) => void;
  /**
   * Accepted for wiring compatibility with `workspace.ts`; the composer has no
   * interrupt affordance of its own. Interrupt is owned by the workspace
   * toolbar (`src/agent/toolbar.ts`).
   */
  onInterrupt?: () => void;
}

export interface ComposerExternalState {
  cwd?: string;
  queueCount?: number;
  busy?: boolean;
}

export class AgentComposer extends Widget {
  private _mode: ComposerMode;
  private _cwd: string;
  private _queueCount: number;
  private _busy: boolean;
  private _isComposing = false;

  private _onModeChange?: (mode: ComposerMode, kind: WorkspaceMode) => void;
  private _onSource?: (draft: string) => void;
  private _onSubmit?: (payload: ComposerSubmitPayload) => void;

  private _modeAgentButton: HTMLButtonElement;
  private _modeShellButton: HTMLButtonElement;
  private _metaCwd: HTMLElement;
  private _metaQueue: HTMLElement;
  private _textarea: HTMLTextAreaElement;

  constructor(options: AgentComposerOptions = {}) {
    super();
    this.addClass('jp-AgentComposer');

    this._mode = options.initialMode ?? 'agent';
    this._cwd = options.cwd ?? '';
    this._queueCount = Math.max(0, options.queueCount ?? 0);
    this._busy = options.busy ?? false;

    this._onModeChange = options.onModeChange;
    this._onSource = options.onSource;
    this._onSubmit = options.onSubmit;

    // Header / Toolbar
    const header = document.createElement('div');
    header.className = 'jp-AgentComposer-header';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'jp-AgentComposer-modeGroup';
    modeGroup.setAttribute('role', 'group');
    modeGroup.setAttribute('aria-label', trans.__('Composer Mode'));

    this._modeAgentButton = document.createElement('button');
    this._modeAgentButton.type = 'button';
    this._modeAgentButton.className =
      'jp-AgentComposer-modeButton jp-AgentComposer-modeAgent';
    this._modeAgentButton.textContent = 'Agent';

    this._modeShellButton = document.createElement('button');
    this._modeShellButton.type = 'button';
    this._modeShellButton.className =
      'jp-AgentComposer-modeButton jp-AgentComposer-modeShell';
    this._modeShellButton.textContent = 'Shell';

    modeGroup.appendChild(this._modeAgentButton);
    modeGroup.appendChild(this._modeShellButton);

    const meta = document.createElement('div');
    meta.className = 'jp-AgentComposer-meta';

    this._metaCwd = document.createElement('span');
    this._metaCwd.className = 'jp-AgentComposer-metaCwd';

    this._metaQueue = document.createElement('span');
    this._metaQueue.className = 'jp-AgentComposer-metaQueue';

    meta.appendChild(this._metaCwd);
    meta.appendChild(this._metaQueue);

    header.appendChild(modeGroup);
    header.appendChild(meta);

    // Body: Textarea
    const body = document.createElement('div');
    body.className = 'jp-AgentComposer-body';

    this._textarea = document.createElement('textarea');
    this._textarea.className = 'jp-AgentComposer-textarea';
    this._textarea.placeholder =
      this._mode === 'agent'
        ? 'Ask Agent instructions... (Shift+Enter to send)'
        : 'Enter shell command... (Shift+Enter to send)';
    if (options.initialDraft !== undefined) {
      this._textarea.value = options.initialDraft;
    }
    body.appendChild(this._textarea);

    this.node.appendChild(header);
    this.node.appendChild(body);

    this._bindEvents();
    this._renderStaticState();
    this._updateModeButtons();
  }

  get mode(): ComposerMode {
    return this._mode;
  }

  get kind(): WorkspaceMode {
    return this._mode === 'agent' ? 'ai' : 'command';
  }

  get draft(): string {
    return this._textarea.value;
  }

  get cwd(): string {
    return this._cwd;
  }

  get queueCount(): number {
    return this._queueCount;
  }

  get isBusy(): boolean {
    return this._busy;
  }

  get textarea(): HTMLTextAreaElement {
    return this._textarea;
  }

  setMode(mode: ComposerMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this._updateModeButtons();
    this._updatePlaceholder();
    if (this._onModeChange) {
      this._onModeChange(this._mode, this.kind);
    }
  }

  setDraft(draft: string): void {
    this._textarea.value = draft;
    if (this._onSource) {
      this._onSource(this._textarea.value);
    }
  }

  focus(): void {
    this._textarea.focus();
  }

  /**
   * Updates non-draft state (cwd, queueCount, busy).
   * Does NOT modify draft, cursor/selection, mode, or kind.
   */
  updateState(state: ComposerExternalState): void {
    if (state.cwd !== undefined) {
      this._cwd = state.cwd;
    }
    if (state.queueCount !== undefined) {
      this._queueCount = Math.max(0, state.queueCount);
    }
    if (state.busy !== undefined) {
      this._busy = state.busy;
    }
    this._renderStaticState();
  }

  private _bindEvents(): void {
    this._modeAgentButton.addEventListener('click', this._handleAgentClick);
    this._modeShellButton.addEventListener('click', this._handleShellClick);
    this._textarea.addEventListener('input', this._handleTextareaInput);
    this._textarea.addEventListener('keydown', this._handleTextareaKeydown);
    this._textarea.addEventListener(
      'compositionstart',
      this._handleCompositionStart
    );
    this._textarea.addEventListener(
      'compositionend',
      this._handleCompositionEnd
    );
  }

  private _unbindEvents(): void {
    this._modeAgentButton.removeEventListener('click', this._handleAgentClick);
    this._modeShellButton.removeEventListener('click', this._handleShellClick);
    this._textarea.removeEventListener('input', this._handleTextareaInput);
    this._textarea.removeEventListener('keydown', this._handleTextareaKeydown);
    this._textarea.removeEventListener(
      'compositionstart',
      this._handleCompositionStart
    );
    this._textarea.removeEventListener(
      'compositionend',
      this._handleCompositionEnd
    );
  }

  private _handleAgentClick = (): void => {
    this.setMode('agent');
  };

  private _handleShellClick = (): void => {
    this.setMode('shell');
  };

  private _handleTextareaInput = (): void => {
    if (this._onSource) {
      this._onSource(this._textarea.value);
    }
  };

  private _handleCompositionStart = (): void => {
    this._isComposing = true;
  };

  private _handleCompositionEnd = (): void => {
    this._isComposing = false;
  };

  private _handleTextareaKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      if (this._isComposing || event.isComposing) {
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
      // Normal Enter: natural newline insertion by browser, do not submit
    }
  };

  submit(): boolean {
    const raw = this._textarea.value;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return false;
    }
    const payload: ComposerSubmitPayload = {
      source: raw,
      kind: this.kind,
      mode: this._mode
    };
    if (this._onSubmit) {
      this._onSubmit(payload);
    }
    return true;
  }

  private _renderStaticState(): void {
    this._metaCwd.textContent = this._cwd ? `cwd: ${this._cwd}` : '';
    this._metaCwd.style.display = this._cwd ? '' : 'none';

    this._metaQueue.textContent =
      this._queueCount > 0 ? `Queued: ${this._queueCount}` : '';
    this._metaQueue.style.display = this._queueCount > 0 ? '' : 'none';
  }

  private _updateModeButtons(): void {
    const isAgent = this._mode === 'agent';
    this._modeAgentButton.setAttribute(
      'aria-pressed',
      isAgent ? 'true' : 'false'
    );
    this._modeShellButton.setAttribute(
      'aria-pressed',
      !isAgent ? 'true' : 'false'
    );
    if (isAgent) {
      this._modeAgentButton.classList.add('is-active');
      this._modeShellButton.classList.remove('is-active');
    } else {
      this._modeAgentButton.classList.remove('is-active');
      this._modeShellButton.classList.add('is-active');
    }
  }

  private _updatePlaceholder(): void {
    this._textarea.placeholder =
      this._mode === 'agent'
        ? 'Ask Agent instructions... (Shift+Enter to send)'
        : 'Enter shell command... (Shift+Enter to send)';
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._unbindEvents();
    this._onModeChange = undefined;
    this._onSource = undefined;
    this._onSubmit = undefined;
    super.dispose();
  }
}
