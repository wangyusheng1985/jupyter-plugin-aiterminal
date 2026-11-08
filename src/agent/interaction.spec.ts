import type {
  DshCapabilityManifest,
  DshInteractionCancelledEvent,
  DshInteractionRequestedEvent,
  DshInteractionResolvedEvent
} from './protocol';
import {
  APPROVAL_ALLOW_ONCE_OPTION_ID,
  APPROVAL_REJECT_OPTION_ID,
  InteractionCoordinator,
  validateInteractionResolution,
  type InteractionHost,
  type InteractionRenderer,
  type InteractionResolutionInput
} from './interaction';

function requested(
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

function resolved(
  overrides: Partial<DshInteractionResolvedEvent> = {}
): DshInteractionResolvedEvent {
  return {
    type: 'dsh/v1/interaction.resolved',
    sessionId: 's-1',
    runtimeId: 'rt-1',
    runId: 'run-1',
    requestId: 'req-1',
    resolution: 'answered',
    ...overrides
  };
}

function cancelled(
  overrides: Partial<DshInteractionCancelledEvent> = {}
): DshInteractionCancelledEvent {
  return {
    type: 'dsh/v1/interaction.cancelled',
    sessionId: 's-1',
    runtimeId: 'rt-1',
    runId: 'run-1',
    requestId: 'req-1',
    ...overrides
  };
}

function capabilities(
  overrides: DshCapabilityManifest = {}
): DshCapabilityManifest {
  return {
    questions: { status: 'available' },
    approval: { status: 'available' },
    ...overrides
  };
}

function host(
  resolve: InteractionHost['resolveInteraction'] = jest.fn()
): InteractionHost {
  return { resolveInteraction: resolve };
}

function questionButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('.jp-Dsh-questionOption')
  );
}

describe('InteractionCoordinator question view', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders the prompt, options, and free-text field and sends an option', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });

    const record = coordinator.handleRequested(
      requested({
        prompt: 'Choose a branch',
        options: [
          { id: 'main', label: 'main' },
          { id: 'dev', label: 'dev' }
        ],
        allowFreeText: true
      })
    );

    expect(record?.phase).toBe('requested');
    expect(container.textContent).toContain('Choose a branch');
    expect(
      questionButtons(container).map(button => button.textContent)
    ).toEqual(['main', 'dev']);
    expect(
      container.querySelector<HTMLTextAreaElement>('.jp-Dsh-interactionInput')
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('.jp-Dsh-interactionSubmit')
    ).not.toBeNull();

    questionButtons(container)[0].click();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      'req-1',
      { optionId: 'main' },
      { sessionId: 's-1', runId: 'run-1', requestId: 'req-1' }
    );
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'awaiting'
    );
    expect(container.textContent).toContain(
      'Waiting for the runtime to confirm'
    );
    // A void host result is not treated as a runtime resolution.
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).not.toBe(
      'resolved'
    );
    coordinator.dispose();
  });

  it('submits only non-empty free text and disables the send button otherwise', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ allowFreeText: true, options: undefined })
    );

    const input = container.querySelector<HTMLTextAreaElement>(
      '.jp-Dsh-interactionInput'
    ) as HTMLTextAreaElement;
    const send = container.querySelector<HTMLButtonElement>(
      '.jp-Dsh-interactionSubmit'
    ) as HTMLButtonElement;

    expect(send.disabled).toBe(true);
    input.value = '   \n\t ';
    input.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(true);
    send.click();
    expect(resolve).not.toHaveBeenCalled();

    input.value = '  use main  ';
    input.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(false);
    send.click();

    expect(resolve).toHaveBeenCalledWith(
      'req-1',
      { text: 'use main' },
      { sessionId: 's-1', runId: 'run-1', requestId: 'req-1' }
    );
    coordinator.dispose();
  });

  it('re-validates a renderer decision and rejects an unknown option', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    const broken: InteractionRenderer = {
      id: 'broken-question',
      priority: 10,
      match: event => event.kind === 'question',
      render: context => {
        const root = document.createElement('section');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Bogus';
        button.addEventListener('click', () =>
          context.actions.resolve({ optionId: 'not-there' })
        );
        root.append(button);
        return {
          element: root,
          update: () => undefined,
          dispose: () => root.remove()
        };
      }
    };
    const handle = coordinator.registerRenderer(broken);
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    container.querySelector<HTMLButtonElement>('button')?.click();

    expect(resolve).not.toHaveBeenCalled();
    const record = coordinator.getRecord('s-1', 'run-1', 'req-1');
    expect(record?.error).toContain('That answer option is not available');
    expect(record?.phase).toBe('requested');
    handle.dispose();
    coordinator.dispose();
  });

  it('marks a resolved event and renders the resolution', () => {
    const coordinator = new InteractionCoordinator({
      container,
      host: host(),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    expect(
      coordinator.handleResolved(resolved({ resolution: 'answered' }))
    ).toBe(true);
    const record = coordinator.getRecord('s-1', 'run-1', 'req-1');
    expect(record?.phase).toBe('resolved');
    expect(record?.resolution).toBe('answered');
    expect(container.textContent).toContain('Resolved: answered');
    coordinator.dispose();
  });
});

describe('InteractionCoordinator approval view', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  function approvalRequested(
    overrides: Partial<DshInteractionRequestedEvent> = {}
  ): DshInteractionRequestedEvent {
    return requested({
      kind: 'approval',
      requestId: 'approval-1',
      prompt: 'Approve this tool call?',
      action: 'bash',
      target: 'run the test suite',
      ...overrides
    });
  }

  it('shows action/target and sends explicit allow-once or reject only', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(approvalRequested());

    expect(container.textContent).toContain('bash');
    expect(container.textContent).toContain('run the test suite');
    expect(container.textContent).not.toMatch(/always|permanent/i);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map(button => button.textContent)).toEqual([
      'Allow once',
      'Reject'
    ]);

    buttons[0].click();
    expect(resolve).toHaveBeenCalledWith(
      'approval-1',
      { optionId: APPROVAL_ALLOW_ONCE_OPTION_ID },
      { sessionId: 's-1', runId: 'run-1', requestId: 'approval-1' }
    );
    expect(coordinator.getRecord('s-1', 'run-1', 'approval-1')?.phase).toBe(
      'awaiting'
    );

    coordinator.handleResolved(
      resolved({ requestId: 'approval-1', resolution: 'approved' })
    );
    expect(coordinator.getRecord('s-1', 'run-1', 'approval-1')?.phase).toBe(
      'resolved'
    );
    expect(container.textContent).toContain('Resolved: approved');
    coordinator.dispose();
  });

  it('sends a rejected decision for the reject button', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(approvalRequested({ requestId: 'approval-2' }));

    const reject = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent === 'Reject'
    );
    reject?.click();

    expect(resolve).toHaveBeenCalledWith(
      'approval-2',
      { optionId: APPROVAL_REJECT_OPTION_ID },
      { sessionId: 's-1', runId: 'run-1', requestId: 'approval-2' }
    );
    coordinator.dispose();
  });
});

describe('InteractionCoordinator capability gating', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('disables questions while unverified and explains why', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities({ questions: { status: 'unverified' } })
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    const button = questionButtons(container)[0];
    expect(button.disabled).toBe(true);
    button.click();
    expect(resolve).not.toHaveBeenCalled();
    expect(container.textContent).toContain('not verified for this runtime');
    coordinator.dispose();
  });

  it('enables questions after capabilities become available', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities({ questions: { status: 'unverified' } })
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    coordinator.setCapabilities(capabilities());
    const button = questionButtons(container)[0];
    expect(button.disabled).toBe(false);
    button.click();
    expect(resolve).toHaveBeenCalledWith(
      'req-1',
      { optionId: 'main' },
      { sessionId: 's-1', runId: 'run-1', requestId: 'req-1' }
    );
    coordinator.dispose();
  });

  it('disables approval while unverified and does not fake availability', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities({ approval: { status: 'unverified' } })
    });
    coordinator.handleRequested(
      requested({ kind: 'approval', requestId: 'approval-1' })
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    expect(buttons.every(button => button.disabled)).toBe(true);
    buttons[0].click();
    expect(resolve).not.toHaveBeenCalled();
    expect(container.textContent).toContain('not verified for this runtime');
    coordinator.dispose();
  });

  it('disables approval when the capability is unavailable', () => {
    const coordinator = new InteractionCoordinator({
      container,
      host: host(),
      capabilities: capabilities({ approval: { status: 'unavailable' } })
    });
    coordinator.handleRequested(
      requested({ kind: 'approval', requestId: 'approval-1' })
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every(button => button.disabled)).toBe(true);
    expect(container.textContent).toContain('not supported by this runtime');
    coordinator.dispose();
  });
});

describe('InteractionCoordinator duplicate, cancellation, and failure handling', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('prevents a renderer from submitting the same decision twice', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    const doubleSubmit: InteractionRenderer = {
      id: 'double-submit',
      priority: 10,
      match: event => event.kind === 'question',
      render: context => {
        const root = document.createElement('section');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Once';
        button.addEventListener('click', () => {
          context.actions.resolve({ optionId: 'main' });
          context.actions.resolve({ optionId: 'main' });
        });
        root.append(button);
        return {
          element: root,
          update: () => undefined,
          dispose: () => root.remove()
        };
      }
    };
    coordinator.registerRenderer(doubleSubmit);
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    container.querySelector<HTMLButtonElement>('button')?.click();

    expect(resolve).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('ignores a late host result after cancellation', async () => {
    const pending: { release?: () => void } = {};
    const resolve = jest.fn(
      () =>
        new Promise<void>(done => {
          pending.release = done;
        })
    );
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    questionButtons(container)[0].click();
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'sending'
    );
    expect(coordinator.handleCancelled(cancelled())).toBe(true);
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'cancelled'
    );

    pending.release?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'cancelled'
    );
    expect(coordinator.handleResolved(resolved())).toBe(false);
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'cancelled'
    );
    coordinator.dispose();
  });

  it('locks a synchronous host failure as an unknown delivery and does not resend', () => {
    const resolve = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('offline');
      })
      .mockImplementation(() => undefined);
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    questionButtons(container)[0].click();
    const record = coordinator.getRecord('s-1', 'run-1', 'req-1');
    expect(record?.phase).toBe('failed');
    expect(record?.deliveryUnknown).toBe(true);
    expect(record?.lastInput).toEqual({ optionId: 'main' });
    expect(container.textContent).toContain('offline');
    expect(container.textContent).toContain('may not have reached');
    expect(questionButtons(container)[0].disabled).toBe(true);

    questionButtons(container)[0].click();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'failed'
    );
    coordinator.dispose();
  });

  it('locks a rejected host promise as unknown and never resolves it by itself', async () => {
    const resolve = jest.fn(() => Promise.reject(new Error('send failed')));
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    questionButtons(container)[0].click();
    await Promise.resolve();
    await Promise.resolve();

    const record = coordinator.getRecord('s-1', 'run-1', 'req-1');
    expect(record?.phase).toBe('failed');
    expect(record?.deliveryUnknown).toBe(true);
    expect(record?.error).toContain('send failed');
    expect(container.textContent).toContain('send failed');
    expect(container.textContent).toContain('may not have reached');
    expect(container.textContent).not.toContain('You can try again');
    expect(questionButtons(container)[0].disabled).toBe(true);

    // Only an authoritative runtime event clears the unknown outcome.
    expect(
      coordinator.handleResolved(resolved({ resolution: 'answered' }))
    ).toBe(true);
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'resolved'
    );
    coordinator.dispose();
  });

  it('never turns a possibly-delivered approval into a contradictory reject', async () => {
    const resolve = jest.fn(() => Promise.reject(new Error('ack lost')));
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ kind: 'approval', requestId: 'approval-1' })
    );

    const buttons = () => Array.from(container.querySelectorAll('button'));
    const allow = buttons().find(button => button.textContent === 'Allow once');
    const reject = buttons().find(button => button.textContent === 'Reject');
    allow?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(buttons().every(button => button.disabled)).toBe(true);
    reject?.click();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      'approval-1',
      { optionId: APPROVAL_ALLOW_ONCE_OPTION_ID },
      { sessionId: 's-1', runId: 'run-1', requestId: 'approval-1' }
    );
    coordinator.dispose();
  });

  it('blocks a custom renderer from resending after an unknown delivery', async () => {
    const resolve = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('ack lost')))
      .mockImplementation(() => undefined);
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    const captured: {
      submit: ((input: InteractionResolutionInput) => void) | null;
    } = { submit: null };
    const adversarial: InteractionRenderer = {
      id: 'adversarial-approval',
      priority: 10,
      match: event => event.kind === 'approval',
      render: context => {
        // Hold the raw action so later calls bypass the disabled UI controls.
        captured.submit = input => context.actions.resolve(input);
        const root = document.createElement('section');
        return {
          element: root,
          update: () => undefined,
          dispose: () => root.remove()
        };
      }
    };
    coordinator.registerRenderer(adversarial);
    coordinator.handleRequested(
      requested({ kind: 'approval', requestId: 'approval-1' })
    );

    captured.submit?.({ optionId: APPROVAL_ALLOW_ONCE_OPTION_ID });
    await Promise.resolve();
    await Promise.resolve();

    const failed = coordinator.getRecord('s-1', 'run-1', 'approval-1');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(failed?.phase).toBe('failed');
    expect(failed?.deliveryUnknown).toBe(true);

    // A custom renderer holding actions.resolve bypasses the disabled buttons,
    // but the coordinator must still reject a contradictory second decision.
    captured.submit?.({ optionId: APPROVAL_ALLOW_ONCE_OPTION_ID });
    captured.submit?.({ optionId: APPROVAL_REJECT_OPTION_ID });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(
      coordinator.getRecord('s-1', 'run-1', 'approval-1')?.lastInput
    ).toEqual({ optionId: APPROVAL_ALLOW_ONCE_OPTION_ID });
    coordinator.dispose();
  });

  it('is idempotent for a repeated requested event', () => {
    const coordinator = new InteractionCoordinator({
      container,
      host: host(),
      capabilities: capabilities()
    });
    const first = coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );
    const second = coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );

    expect(second).toEqual(first);
    expect(container.querySelectorAll('.jp-Dsh-question')).toHaveLength(1);
    coordinator.dispose();
  });

  it('ignores a late host result after dispose', async () => {
    const pending: { release?: () => void } = {};
    const resolve = jest.fn(
      () =>
        new Promise<void>(done => {
          pending.release = done;
        })
    );
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );
    questionButtons(container)[0].click();

    coordinator.dispose();
    pending.release?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')).toBeNull();
  });
});

describe('InteractionCoordinator identity, cleanup, and safety', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('keeps requests with the same requestId isolated across sessions', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({
        sessionId: 's-1',
        options: [{ id: 'main', label: 'main' }]
      })
    );
    coordinator.handleRequested(
      requested({
        sessionId: 's-2',
        options: [{ id: 'main', label: 'main' }]
      })
    );

    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')).not.toBeNull();
    expect(coordinator.getRecord('s-2', 'run-1', 'req-1')).not.toBeNull();
    expect(container.querySelectorAll('.jp-Dsh-question')).toHaveLength(2);

    questionButtons(container)[0].click();
    expect(resolve).toHaveBeenCalledWith(
      'req-1',
      { optionId: 'main' },
      { sessionId: 's-1', runId: 'run-1', requestId: 'req-1' }
    );
    coordinator.handleResolved(resolved({ sessionId: 's-1' }));

    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'resolved'
    );
    expect(coordinator.getRecord('s-2', 'run-1', 'req-1')?.phase).toBe(
      'requested'
    );
    coordinator.dispose();
  });

  it('passes the owning session scope for a cross-session repeated requestId', () => {
    const resolve = jest.fn();
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({
        sessionId: 's-1',
        options: [{ id: 'main', label: 'main' }]
      })
    );
    coordinator.handleRequested(
      requested({
        sessionId: 's-2',
        options: [{ id: 'main', label: 'main' }]
      })
    );

    questionButtons(container)[1].click();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      'req-1',
      { optionId: 'main' },
      { sessionId: 's-2', runId: 'run-1', requestId: 'req-1' }
    );
    coordinator.dispose();
  });

  it('dismisses only terminal records and never drops an unknown delivery', async () => {
    const resolve = jest.fn(() => Promise.reject(new Error('ack lost')));
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );
    questionButtons(container)[0].click();
    await Promise.resolve();
    await Promise.resolve();

    // Unknown-delivery (failed) records cannot be dismissed into a resend.
    expect(coordinator.dismiss('s-1', 'run-1', 'req-1')).toBe(false);
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')?.phase).toBe(
      'failed'
    );

    // A terminal record can be reclaimed, removing its DOM.
    coordinator.handleResolved(resolved({ resolution: 'answered' }));
    expect(coordinator.dismiss('s-1', 'run-1', 'req-1')).toBe(true);
    expect(coordinator.getRecord('s-1', 'run-1', 'req-1')).toBeNull();
    expect(container.querySelector('.jp-Dsh-question')).toBeNull();
    coordinator.dispose();
  });

  it('disposes listeners and own roots without touching unrelated drafts', () => {
    const resolve = jest.fn();
    const draft = document.createElement('input');
    draft.value = 'keep this draft';
    container.append(draft);
    const coordinator = new InteractionCoordinator({
      container,
      host: host(resolve),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({ options: [{ id: 'main', label: 'main' }] })
    );
    const button = questionButtons(container)[0];

    coordinator.dispose();

    expect(container.querySelector('.jp-Dsh-interaction')).toBeNull();
    expect(draft.value).toBe('keep this draft');
    button.click();
    expect(resolve).not.toHaveBeenCalled();
    expect(
      coordinator.handleRequested(
        requested({ requestId: 'req-2', options: [] })
      )
    ).toBeNull();
  });

  it('removes a registered renderer without affecting the built-ins', () => {
    const coordinator = new InteractionCoordinator({
      container,
      host: host(),
      capabilities: capabilities()
    });
    const custom: InteractionRenderer = {
      id: 'custom-question',
      priority: 10,
      match: event => event.kind === 'question',
      render: () => {
        const root = document.createElement('section');
        root.className = 'custom-question';
        return {
          element: root,
          update: () => undefined,
          dispose: () => root.remove()
        };
      }
    };
    const handle = coordinator.registerRenderer(custom);
    coordinator.handleRequested(
      requested({ requestId: 'req-custom', options: [] })
    );
    expect(container.querySelector('.custom-question')).not.toBeNull();

    handle.dispose();
    coordinator.handleRequested(
      requested({ requestId: 'req-builtin', options: [] })
    );
    expect(container.querySelectorAll('.jp-Dsh-question')).toHaveLength(1);
    coordinator.dispose();
  });

  it('renders untrusted text as inert text', () => {
    const coordinator = new InteractionCoordinator({
      container,
      host: host(),
      capabilities: capabilities()
    });
    coordinator.handleRequested(
      requested({
        prompt: '<img src=x onerror="alert(1)">',
        options: [{ id: 'main', label: '<script>alert(1)</script>' }]
      })
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain('<script>alert(1)</script>');
    coordinator.dispose();
  });
});

describe('validateInteractionResolution', () => {
  it('accepts legal question options and non-empty free text', () => {
    expect(
      validateInteractionResolution(
        requested({ options: [{ id: 'main', label: 'main' }] }),
        { optionId: 'main' }
      )
    ).toBeNull();
    expect(
      validateInteractionResolution(requested({ allowFreeText: true }), {
        text: 'answer'
      })
    ).toBeNull();
  });

  it('rejects unknown options, empty text, and approval text', () => {
    expect(
      validateInteractionResolution(
        requested({ options: [{ id: 'main', label: 'main' }] }),
        { optionId: 'other' }
      )
    ).toContain('not available');
    expect(
      validateInteractionResolution(requested({ allowFreeText: true }), {
        text: '   '
      })
    ).toContain('Choose an option');
    expect(
      validateInteractionResolution(requested({ kind: 'approval' }), {
        text: 'yes'
      })
    ).toContain('allow-once or reject');
    expect(
      validateInteractionResolution(requested({ kind: 'approval' }), {
        optionId: 'always'
      })
    ).toContain('allow once or reject');
  });
});
