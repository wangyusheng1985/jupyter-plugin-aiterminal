import { AgentComposer } from './composer';

describe('AgentComposer', () => {
  it('initializes with default agent mode and handles mode switching', () => {
    const onModeChange = jest.fn();
    const composer = new AgentComposer({
      onModeChange
    });

    expect(composer.mode).toBe('agent');
    expect(composer.kind).toBe('ai');
    expect(
      composer.node
        .querySelector('.jp-AgentComposer-modeAgent')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(
      composer.node
        .querySelector('.jp-AgentComposer-modeShell')
        ?.getAttribute('aria-pressed')
    ).toBe('false');

    // Click shell button
    const shellBtn = composer.node.querySelector(
      '.jp-AgentComposer-modeShell'
    ) as HTMLButtonElement;
    shellBtn.click();

    expect(composer.mode).toBe('shell');
    expect(composer.kind).toBe('command');
    expect(onModeChange).toHaveBeenCalledWith('shell', 'command');
    expect(shellBtn.getAttribute('aria-pressed')).toBe('true');
    expect(
      composer.node
        .querySelector('.jp-AgentComposer-modeAgent')
        ?.getAttribute('aria-pressed')
    ).toBe('false');

    // Click agent button
    const agentBtn = composer.node.querySelector(
      '.jp-AgentComposer-modeAgent'
    ) as HTMLButtonElement;
    agentBtn.click();

    expect(composer.mode).toBe('agent');
    expect(composer.kind).toBe('ai');
    expect(onModeChange).toHaveBeenCalledWith('agent', 'ai');

    composer.dispose();
  });

  it('renders Agent/Shell header and textarea without a footer action bar', () => {
    const composer = new AgentComposer({ initialDraft: 'draft' });

    expect(composer.node.querySelector('.jp-AgentComposer-header')).not.toBe(
      null
    );
    expect(composer.node.querySelector('.jp-AgentComposer-body')).not.toBe(
      null
    );
    expect(composer.textarea).toBeInstanceOf(HTMLTextAreaElement);

    // Footer (Run/Interrupt) is owned by the workspace toolbar now.
    expect(composer.node.querySelector('.jp-AgentComposer-footer')).toBeNull();
    expect(composer.node.querySelector('.jp-AgentComposer-submitButton')).toBe(
      null
    );
    expect(
      composer.node.querySelector('.jp-AgentComposer-interruptButton')
    ).toBeNull();

    composer.dispose();
  });

  it('supports two submission snapshots: Agent (ai) and Shell (command)', () => {
    const onSubmit = jest.fn();
    const composer = new AgentComposer({
      initialDraft: 'echo 123',
      onSubmit
    });

    // 1. Submit in agent mode
    expect(composer.submit()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith({
      source: 'echo 123',
      kind: 'ai',
      mode: 'agent'
    });

    // 2. Switch to shell mode and submit
    composer.setMode('shell');
    composer.setDraft('ls -la');
    expect(composer.submit()).toBe(true);

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({
      source: 'ls -la',
      kind: 'command',
      mode: 'shell'
    });

    composer.dispose();
  });

  it('rejects empty or whitespace-only drafts', () => {
    const onSubmit = jest.fn();
    const composer = new AgentComposer({
      initialDraft: '',
      onSubmit
    });

    expect(composer.submit()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    // Set whitespace only
    composer.textarea.value = '   \n  \t  ';
    composer.textarea.dispatchEvent(new Event('input'));
    expect(composer.submit()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    // Type valid text
    composer.textarea.value = 'hello';
    composer.textarea.dispatchEvent(new Event('input'));
    expect(composer.submit()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    composer.dispose();
  });

  it('exposes busy/queue state in the meta line and still submits for queueing', () => {
    const onSubmit = jest.fn();
    const composer = new AgentComposer({
      initialDraft: 'task 1',
      busy: true,
      queueCount: 2,
      onSubmit
    });

    expect(composer.isBusy).toBe(true);
    expect(composer.queueCount).toBe(2);
    expect(
      composer.node.querySelector('.jp-AgentComposer-metaQueue')?.textContent
    ).toBe('Queued: 2');

    // Submitting while busy still emits the snapshot so the workspace can queue it
    expect(composer.submit()).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({
      source: 'task 1',
      kind: 'ai',
      mode: 'agent'
    });

    composer.updateState({ busy: false, queueCount: 0 });
    expect(composer.isBusy).toBe(false);
    expect(composer.queueCount).toBe(0);
    expect(
      composer.node.querySelector('.jp-AgentComposer-metaQueue')?.textContent
    ).toBe('');

    composer.dispose();
  });

  it('handles Shift+Enter for submission, Enter for newline, and blocks IME composing', () => {
    const onSubmit = jest.fn();
    const composer = new AgentComposer({
      initialDraft: 'input text',
      onSubmit
    });

    // 1. Normal Enter -> does not submit
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      bubbles: true,
      cancelable: true
    });
    composer.textarea.dispatchEvent(enterEvent);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(enterEvent.defaultPrevented).toBe(false);

    // 2. Shift+Enter -> submits and prevents default
    const shiftEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    composer.textarea.dispatchEvent(shiftEnterEvent);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(shiftEnterEvent.defaultPrevented).toBe(true);

    // 3. IME composing -> Shift+Enter does not submit
    composer.textarea.dispatchEvent(new Event('compositionstart'));
    const imeShiftEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    composer.textarea.dispatchEvent(imeShiftEnterEvent);
    expect(onSubmit).toHaveBeenCalledTimes(1); // Still 1

    composer.textarea.dispatchEvent(new Event('compositionend'));
    const postImeShiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    composer.textarea.dispatchEvent(postImeShiftEnter);
    expect(onSubmit).toHaveBeenCalledTimes(2);

    composer.dispose();
  });

  it('preserves draft, cursor/selection, mode, and kind when updating external state', () => {
    const composer = new AgentComposer({
      initialMode: 'shell',
      initialDraft: 'my sensitive draft',
      cwd: '/workspace/dir'
    });

    // Set cursor selection in textarea
    composer.textarea.setSelectionRange(3, 8);
    expect(composer.textarea.selectionStart).toBe(3);
    expect(composer.textarea.selectionEnd).toBe(8);

    // External state update (status refresh)
    composer.updateState({
      cwd: '/workspace/dir2',
      queueCount: 3,
      busy: true
    });

    // Draft, selection, and mode must be preserved
    expect(composer.draft).toBe('my sensitive draft');
    expect(composer.textarea.value).toBe('my sensitive draft');
    expect(composer.textarea.selectionStart).toBe(3);
    expect(composer.textarea.selectionEnd).toBe(8);
    expect(composer.mode).toBe('shell');
    expect(composer.kind).toBe('command');

    // External state updated
    expect(composer.cwd).toBe('/workspace/dir2');
    expect(composer.queueCount).toBe(3);
    expect(composer.isBusy).toBe(true);
    expect(
      composer.node.querySelector('.jp-AgentComposer-metaCwd')?.textContent
    ).toBe('cwd: /workspace/dir2');
    expect(
      composer.node.querySelector('.jp-AgentComposer-metaQueue')?.textContent
    ).toBe('Queued: 3');

    // Explicit setDraft can clear or modify draft
    composer.setDraft('');
    expect(composer.draft).toBe('');
    expect(composer.submit()).toBe(false);

    composer.dispose();
  });

  it('unbinds event listeners and cleans callbacks on dispose', () => {
    const onSubmit = jest.fn();
    const composer = new AgentComposer({
      initialDraft: 'test',
      busy: true,
      onSubmit
    });

    composer.dispose();
    expect(composer.isDisposed).toBe(true);

    // After dispose, neither typing nor programmatic submit triggers callbacks
    const shiftEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    composer.textarea.dispatchEvent(shiftEnterEvent);
    composer.submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
