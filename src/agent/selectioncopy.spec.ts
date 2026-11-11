import {
  copyButtonPosition,
  copyTextToClipboard,
  resolveSelectedText,
  selectedTextFromInput,
  selectedTextFromWindow,
  SelectionCopyButton,
  writeClipboardText
} from './selectioncopy';

describe('selection copy', () => {
  it('reads a textarea selection inside the root', () => {
    const root = document.createElement('div');
    const editor = document.createElement('textarea');
    editor.value = 'ping 10.9.34.84';
    editor.selectionStart = 5;
    editor.selectionEnd = 15;
    root.append(editor);
    expect(selectedTextFromInput(editor, root)).toBe('10.9.34.84');
    expect(resolveSelectedText(editor, root)).toBe('10.9.34.84');
  });

  it('ignores input selection outside the root', () => {
    const root = document.createElement('div');
    const editor = document.createElement('textarea');
    editor.value = 'pwd';
    editor.selectionStart = 0;
    editor.selectionEnd = 3;
    expect(selectedTextFromInput(editor, root)).toBe('');
  });

  it('reads a DOM selection whose range is inside the root', () => {
    const root = document.createElement('div');
    const output = document.createElement('pre');
    output.append(document.createTextNode('hello world'));
    root.append(output);
    const range = {
      commonAncestorContainer: output.firstChild as Text
    };
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => 'world'
    } as unknown as Selection;
    expect(selectedTextFromWindow(selection, root)).toBe('world');
    expect(resolveSelectedText(output, root, selection)).toBe('world');
  });

  it('places the button at the mouse with a small offset', () => {
    expect(copyButtonPosition(100, 200, { width: 800, height: 600 })).toEqual({
      left: 102,
      top: 202
    });
  });

  it('keeps the button inside the viewport', () => {
    expect(copyButtonPosition(790, 590, { width: 800, height: 600 })).toEqual({
      left: 772,
      top: 572
    });
  });

  it('shows the notebook copy icon after a cell selection and copies on click', () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const root = document.createElement('div');
    document.body.append(root);
    const editor = document.createElement('textarea');
    editor.value = 'nc -zv 10.9.34.84 22';
    editor.selectionStart = 0;
    editor.selectionEnd = editor.value.length;
    root.append(editor);
    const button = new SelectionCopyButton(root);

    editor.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 80 })
    );
    expect(button.node.parentElement).toBe(document.body);
    expect(button.node.hidden).toBe(false);
    expect(button.node.style.left).toBe('42px');
    expect(button.node.style.top).toBe('82px');
    expect(button.node.querySelector('svg .jp-icon3')).not.toBeNull();

    button.node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(writeText).toHaveBeenCalledWith('nc -zv 10.9.34.84 22');
    expect(button.node.hidden).toBe(true);

    button.dispose();
    root.remove();
  });

  it('falls back to execCommand when clipboard API is missing', () => {
    Object.assign(navigator, { clipboard: undefined });
    const exec = jest.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec
    });
    copyTextToClipboard('pwd');
    expect(exec).toHaveBeenCalledWith('copy');
  });

  describe('writeClipboardText', () => {
    afterEach(() => {
      Object.assign(navigator, { clipboard: undefined });
    });

    it('resolves true when the async clipboard accepts the text', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      await expect(writeClipboardText('# title')).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith('# title');
    });

    it('falls back to execCommand when the clipboard rejects', async () => {
      Object.assign(navigator, {
        clipboard: {
          writeText: jest.fn().mockRejectedValue(new Error('denied'))
        }
      });
      const exec = jest.fn().mockReturnValue(true);
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: exec
      });
      await expect(writeClipboardText('- one\n- two')).resolves.toBe(true);
      expect(exec).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('resolves false when no copy path succeeds', async () => {
      Object.assign(navigator, { clipboard: undefined });
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: jest.fn().mockReturnValue(false)
      });
      await expect(writeClipboardText('pwd')).resolves.toBe(false);
    });

    it('preserves the previous focus and selection around the fallback', async () => {
      Object.assign(navigator, { clipboard: undefined });
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: jest.fn().mockReturnValue(true)
      });
      const root = document.createElement('div');
      const field = document.createElement('textarea');
      field.value = 'keep me';
      root.append(field);
      document.body.append(root);
      field.focus();
      field.setSelectionRange(0, 4);

      await expect(writeClipboardText('copied')).resolves.toBe(true);

      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(4);
      root.remove();
    });
  });
});
