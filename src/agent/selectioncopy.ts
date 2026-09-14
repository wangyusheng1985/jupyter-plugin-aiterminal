const COPY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 18 18" aria-hidden="true">
  <path fill="#616161" d="M11.9 1H3.2c-.8 0-1.5.7-1.5 1.5v10.2h1.5V2.5h8.7zm2.2 2.9h-8c-.8 0-1.5.7-1.5 1.5v10.2c0 .8.7 1.5 1.5 1.5h8c.8 0 1.5-.7 1.5-1.5V5.4c-.1-.8-.7-1.5-1.5-1.5m0 11.6h-8V5.4h8z" class="jp-icon3"/>
</svg>`;

export function selectedTextFromInput(
  target: EventTarget | null,
  root: Node
): string {
  if (
    !(
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement
    ) ||
    !root.contains(target)
  ) {
    return '';
  }
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  if (end <= start) return '';
  return target.value.slice(start, end);
}

export function selectedTextFromWindow(
  selection: Selection | null,
  root: Node
): string {
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return '';
  }
  const ancestor = selection.getRangeAt(0).commonAncestorContainer;
  if (!root.contains(ancestor)) return '';
  return selection.toString();
}

export function resolveSelectedText(
  target: EventTarget | null,
  root: Node,
  selection: Selection | null = null
): string {
  const fromInput = selectedTextFromInput(target, root);
  if (fromInput) return fromInput;
  return selectedTextFromWindow(
    selection ?? (typeof window === 'undefined' ? null : window.getSelection()),
    root
  );
}

const COPY_BUTTON_SIZE = 28;
const COPY_BUTTON_GAP = 2;

export function copyButtonPosition(
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number } = {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight
  }
): { left: number; top: number } {
  return {
    left: clamp(
      clientX + COPY_BUTTON_GAP,
      0,
      Math.max(0, viewport.width - COPY_BUTTON_SIZE)
    ),
    top: clamp(
      clientY + COPY_BUTTON_GAP,
      0,
      Math.max(0, viewport.height - COPY_BUTTON_SIZE)
    )
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function copyTextToClipboard(text: string): void {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    void clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.append(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}

export class SelectionCopyButton {
  readonly node: HTMLButtonElement;
  private text = '';
  private pointer = { x: 0, y: 0 };
  private tracking = false;

  constructor(private readonly root: HTMLElement) {
    this.node = document.createElement('button');
    this.node.type = 'button';
    this.node.className = 'jp-AgentWorkspace-copyButton';
    // SelectionCopyButton has no translator; match the Lab copy tooltip.
    this.node.title = 'Copy'; // eslint-disable-line jupyter/no-untranslated-string
    this.node.setAttribute('aria-label', 'Copy'); // eslint-disable-line jupyter/no-untranslated-string
    this.node.tabIndex = -1;
    this.node.hidden = true;
    this.node.innerHTML = COPY_SVG;
    document.body.append(this.node);
    this.root.addEventListener('mousedown', this.onRootMouseDown);
    this.root.addEventListener('mouseup', this.onMouseUp);
    this.root.addEventListener('scroll', this.hide, true);
    document.addEventListener('mousemove', this.onMouseMove, true);
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    this.node.addEventListener('mousedown', this.onButtonMouseDown);
    this.node.addEventListener('click', this.onClick);
  }

  dispose(): void {
    this.stopTracking();
    this.root.removeEventListener('mousedown', this.onRootMouseDown);
    this.root.removeEventListener('mouseup', this.onMouseUp);
    this.root.removeEventListener('scroll', this.hide, true);
    document.removeEventListener('mousemove', this.onMouseMove, true);
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    this.node.remove();
  }

  hide = (): void => {
    this.text = '';
    this.node.hidden = true;
  };

  private readonly onRootMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.node.contains(event.target as Node)) return;
    this.tracking = true;
    this.rememberPointer(event);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.tracking) return;
    this.rememberPointer(event);
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.node.contains(event.target as Node)) return;
    this.rememberPointer(event);
    this.stopTracking();
    const text = resolveSelectedText(event.target, this.root);
    if (!text) {
      this.hide();
      return;
    }
    this.text = text;
    const { left, top } = copyButtonPosition(this.pointer.x, this.pointer.y);
    this.node.style.left = `${left}px`;
    this.node.style.top = `${top}px`;
    this.node.hidden = false;
  };

  private rememberPointer(event: MouseEvent): void {
    this.pointer = { x: event.clientX, y: event.clientY };
  }

  private stopTracking(): void {
    this.tracking = false;
  }

  private readonly onDocumentMouseDown = (event: MouseEvent): void => {
    if (this.node.contains(event.target as Node)) return;
    this.hide();
  };

  private readonly onButtonMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.text) {
      this.hide();
      return;
    }
    copyTextToClipboard(this.text);
    this.hide();
  };
}
