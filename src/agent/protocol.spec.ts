import {
  applyServerEvent,
  isDshProductEvent,
  parseDshProductEvent,
  type ChatBlock
} from './protocol';

describe('applyServerEvent', () => {
  it('appends tool cards and fills their output', () => {
    let blocks: ChatBlock[] = [];
    blocks = applyServerEvent(blocks, {
      type: 'tool_start',
      turnId: 'run-1',
      id: 't1',
      name: 'Bash',
      input: { command: 'pwd' },
      startedAt: 100
    });
    blocks = applyServerEvent(blocks, {
      type: 'tool_end',
      turnId: 'run-1',
      id: 't1',
      name: 'Bash',
      output: '/root\n',
      durationMs: 12,
      lineCount: 1,
      byteCount: 6
    });
    expect(blocks).toEqual([
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'pwd' },
        output: '/root\n',
        status: 'done',
        startedAt: 100,
        durationMs: 12,
        lineCount: 1,
        byteCount: 6
      }
    ]);
  });

  it('coalesces assistant text for one runtime message', () => {
    let blocks = applyServerEvent([], {
      type: 'text',
      turnId: 'run-1',
      messageId: 'message-1',
      text: 'first'
    });
    blocks = applyServerEvent(blocks, {
      type: 'text',
      turnId: 'run-1',
      messageId: 'message-1',
      text: 'first and final'
    });
    expect(blocks).toEqual([
      {
        kind: 'text',
        id: 'text-message-1',
        messageId: 'message-1',
        text: 'first and final'
      }
    ]);
  });

  it('records thinking state and carries reasoning text', () => {
    let blocks = applyServerEvent([], {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm1:0',
      state: 'started',
      text: 'reasoning'
    });
    blocks = applyServerEvent(blocks, {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm1:0',
      state: 'finished',
      text: 'reasoning'
    });
    expect(blocks).toEqual([
      {
        kind: 'thinking',
        id: 'thinking-m1:0',
        status: 'finished',
        text: 'reasoning'
      }
    ]);
  });

  it('accumulates incremental thinking text without duplicating snapshots', () => {
    let blocks = applyServerEvent([], {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm2:0',
      state: 'started',
      text: 'step '
    });
    blocks = applyServerEvent(blocks, {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm2:0',
      state: 'started',
      text: 'one'
    });
    blocks = applyServerEvent(blocks, {
      type: 'thinking',
      turnId: 'run-1',
      id: 'm2:0',
      state: 'finished',
      text: 'step one'
    });
    expect(blocks).toEqual([
      {
        kind: 'thinking',
        id: 'thinking-m2:0',
        status: 'finished',
        text: 'step one'
      }
    ]);
  });

  it('records config errors without dropping earlier cards', () => {
    const blocks = applyServerEvent(
      [{ kind: 'user', id: 'u1', text: 'list files' }],
      {
        type: 'error',
        code: 'config',
        message: 'AI Terminal settings are missing'
      }
    );
    expect(blocks[1]).toEqual({
      kind: 'error',
      id: expect.stringContaining('error'),
      message: 'AI Terminal settings are missing',
      code: 'config'
    });
  });

  it('does not fold command-exec events into the AI transcript', () => {
    expect(
      applyServerEvent([], {
        type: 'exec_done',
        output: '/tmp\n',
        returncode: 0,
        cwd: '/tmp'
      })
    ).toEqual([]);
    expect(
      applyServerEvent([], { type: 'exec_output', text: 'pong\n' })
    ).toEqual([]);
    expect(
      applyServerEvent([], { type: 'exec_error', message: 'shell exited' })
    ).toEqual([]);
  });

  it('does not render a successful result recap as another text block', () => {
    const withTool = applyServerEvent([], {
      type: 'tool_end',
      id: 't1',
      name: 'Bash',
      output: 'pong\n'
    });
    expect(
      applyServerEvent(withTool, {
        type: 'result',
        turnId: 'run-1',
        text: '10.9.34.98 is reachable.',
        isError: false,
        durationMs: 1200,
        numTurns: 4,
        errors: []
      })
    ).toEqual(withTool);
  });

  it('keeps result diagnostics and accepts result metadata', () => {
    const blocks = applyServerEvent([], {
      type: 'result',
      turnId: 'run-1',
      text: 'command failed',
      isError: true,
      durationMs: 500,
      numTurns: 1,
      errors: ['command failed']
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'error',
      message: 'command failed'
    });
  });
});

describe('parseDshProductEvent', () => {
  it('parses a valid text delta from untrusted JSON', () => {
    const raw: unknown = JSON.parse(
      JSON.stringify({
        type: 'dsh/v1/text.delta',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        runId: 'run-7',
        messageId: 'msg-1',
        delta: 'hello',
        privateField: 'must-not-be-forwarded'
      })
    );
    const result = parseDshProductEvent(raw);
    expect(result).toEqual({
      ok: true,
      event: {
        type: 'dsh/v1/text.delta',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        runId: 'run-7',
        messageId: 'msg-1',
        delta: 'hello'
      }
    });
    expect(JSON.stringify(result)).not.toContain('privateField');
  });

  it('parses a text snapshot without a run id', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/text.snapshot',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      messageId: 'msg-1',
      text: 'restored'
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('dsh/v1/text.snapshot');
      expect(result.event).not.toHaveProperty('runId');
    }
  });

  it('keeps run identity separate from durable session identity', () => {
    const started = parseDshProductEvent({
      type: 'dsh/v1/run.started',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7'
    });
    const finished = parseDshProductEvent({
      type: 'dsh/v1/run.finished',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      status: 'failed'
    });
    expect(started.ok && started.event).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-7'
    });
    expect(finished.ok && finished.event).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-7',
      status: 'failed'
    });
    // A finished run only reports execution outcome, never goal acceptance.
    expect(JSON.stringify(finished)).not.toContain('accept');
  });

  it('parses interaction requested, resolved, and cancelled with one request id', () => {
    const base = {
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      requestId: 'request-9'
    };
    const requested = parseDshProductEvent({
      ...base,
      type: 'dsh/v1/interaction.requested',
      kind: 'approval',
      toolCallId: 'tool-2',
      prompt: 'allow rm?'
    });
    const resolved = parseDshProductEvent({
      ...base,
      type: 'dsh/v1/interaction.resolved',
      resolution: 'rejected'
    });
    const cancelled = parseDshProductEvent({
      ...base,
      type: 'dsh/v1/interaction.cancelled'
    });
    for (const result of [requested, resolved, cancelled]) {
      expect(result.ok && result.event).toMatchObject({
        requestId: 'request-9'
      });
    }
  });

  it('parses activity, artifact, and connection events', () => {
    const activity = parseDshProductEvent({
      type: 'dsh/v1/activity',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      activityId: 'activity-1',
      phase: 'started',
      toolCallId: 'tool-2',
      label: 'Bash'
    });
    const artifact = parseDshProductEvent({
      type: 'dsh/v1/artifact',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      artifactId: 'artifact-1',
      phase: 'created',
      name: 'report.md',
      uri: 'reports/report.md',
      mediaType: 'text/markdown',
      source: 'workspace_change'
    });
    const connection = parseDshProductEvent({
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-3',
      phase: 'disconnected'
    });
    expect(activity.ok).toBe(true);
    expect(artifact.ok).toBe(true);
    expect(connection.ok && connection.event).toEqual({
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-3',
      phase: 'disconnected'
    });
  });

  it('rejects events missing a required id', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/text.delta',
      runtimeId: 'runtime-3',
      messageId: 'msg-1',
      delta: 'hello'
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects a field with the wrong runtime type', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/text.delta',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      messageId: 'msg-1',
      delta: 42
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects an unsupported version before event dispatch', () => {
    expect(
      parseDshProductEvent({
        type: 'dsh/v2/text.delta',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        messageId: 'msg-1',
        delta: 'hello'
      })
    ).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  it('rejects unknown namespaces and unknown event kinds without throwing', () => {
    expect(parseDshProductEvent({ type: 'legacy/v1/text.delta' })).toEqual({
      ok: false,
      reason: 'unknown_namespace'
    });
    expect(
      parseDshProductEvent({
        type: 'dsh/v1/unknown.event',
        sessionId: 'session-1',
        runtimeId: 'runtime-3'
      })
    ).toEqual({ ok: false, reason: 'unknown_event' });
    expect(parseDshProductEvent('not-an-event')).toEqual({
      ok: false,
      reason: 'not_object'
    });
  });

  it('parses capability handshakes and preserves unverified with a reason', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/capabilities',
      runtimeId: 'runtime-3',
      capabilities: {
        text_stream: { status: 'available' },
        jobs: {
          status: 'unverified',
          reason: 'jobs tools disabled in isolated profile'
        },
        approval: { status: 'unavailable', reason: 'host did not enable it' },
        future_capability: { status: 'available' }
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === 'dsh/v1/capabilities') {
      expect(result.event.capabilities).toEqual({
        text_stream: { status: 'available' },
        approval: { status: 'unavailable', reason: 'host did not enable it' },
        jobs: {
          status: 'unverified',
          reason: 'jobs tools disabled in isolated profile'
        }
      });
      expect(result.event.capabilities.jobs?.status).not.toBe('unavailable');
    }
  });

  it('distinguishes a resumed session from a newer runtime generation', () => {
    const first = parseDshProductEvent({
      type: 'dsh/v1/session',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      phase: 'attached'
    });
    const disconnected = parseDshProductEvent({
      type: 'dsh/v1/connection',
      runtimeId: 'runtime-3',
      phase: 'disconnected'
    });
    const resumed = parseDshProductEvent({
      type: 'dsh/v1/session',
      sessionId: 'session-1',
      runtimeId: 'runtime-4',
      phase: 'resumed'
    });
    expect(first.ok).toBe(true);
    expect(disconnected.ok).toBe(true);
    expect(resumed.ok && resumed.event).toMatchObject({
      sessionId: 'session-1',
      runtimeId: 'runtime-4',
      phase: 'resumed'
    });
    if (first.ok && resumed.ok) {
      expect(first.event).not.toEqual(resumed.event);
    }
  });

  it('narrows with the runtime type guard, not a cast', () => {
    const raw: unknown = {
      type: 'dsh/v1/run.started',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7'
    };
    expect(isDshProductEvent(raw)).toBe(true);
    if (isDshProductEvent(raw) && raw.type === 'dsh/v1/run.started') {
      expect(raw.runId).toBe('run-7');
    }
    expect(isDshProductEvent({ type: 'dsh/v1/run.started' })).toBe(false);
  });

  it('parses a finished tool activity with a bounded outcome', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/activity',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      activityId: 'activity-1',
      phase: 'finished',
      toolCallId: 'tool-2',
      toolName: 'bash',
      status: 'error',
      outputSummary: 'command failed',
      durationMs: 42,
      rawOutput: 'must-not-be-forwarded'
    });
    expect(result).toEqual({
      ok: true,
      event: {
        type: 'dsh/v1/activity',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        runId: 'run-7',
        activityId: 'activity-1',
        phase: 'finished',
        toolCallId: 'tool-2',
        toolName: 'bash',
        status: 'error',
        outputSummary: 'command failed',
        durationMs: 42
      }
    });
    expect(JSON.stringify(result)).not.toContain('rawOutput');
  });

  it('rejects bad activity status and non-numeric or negative durations', () => {
    const base = {
      type: 'dsh/v1/activity',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      activityId: 'activity-1',
      phase: 'finished'
    };
    expect(parseDshProductEvent({ ...base, status: 'maybe' })).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
    expect(parseDshProductEvent({ ...base, durationMs: -1 })).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
    expect(parseDshProductEvent({ ...base, durationMs: 'fast' })).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
    expect(
      parseDshProductEvent({ ...base, durationMs: Number.POSITIVE_INFINITY })
    ).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
  });

  it('requires locator or explicit reason for created/updated artifacts only', () => {
    const base = {
      type: 'dsh/v1/artifact',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      artifactId: 'artifact-1'
    };
    expect(parseDshProductEvent({ ...base, phase: 'created' })).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
    const unavailable = parseDshProductEvent({
      ...base,
      phase: 'updated',
      unavailableReason: 'uri_unavailable',
      source: 'presented',
      mediaType: 'application/pdf'
    });
    expect(unavailable.ok && unavailable.event).toMatchObject({
      unavailableReason: 'uri_unavailable',
      source: 'presented'
    });
    const deleted = parseDshProductEvent({ ...base, phase: 'deleted' });
    expect(deleted.ok).toBe(true);
    expect(
      parseDshProductEvent({ ...base, phase: 'created', source: 'guessed' })
    ).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
  });

  it('parses interaction choices and approval summary', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/interaction.requested',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      requestId: 'request-9',
      toolCallId: 'tool-2',
      kind: 'question',
      prompt: 'Which environment?',
      options: [
        { id: 'staging', label: 'Staging' },
        { id: 'prod', label: 'Production' }
      ],
      allowFreeText: true
    });
    expect(result.ok && result.event).toMatchObject({
      prompt: 'Which environment?',
      allowFreeText: true,
      options: [
        { id: 'staging', label: 'Staging' },
        { id: 'prod', label: 'Production' }
      ]
    });
    const approval = parseDshProductEvent({
      type: 'dsh/v1/interaction.requested',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      requestId: 'request-9',
      kind: 'approval',
      prompt: 'Allow this command?',
      action: 'bash',
      target: 'delete build artifacts'
    });
    expect(approval.ok && approval.event).toMatchObject({
      kind: 'approval',
      action: 'bash',
      target: 'delete build artifacts'
    });
  });

  it('rejects empty option ids, duplicate option ids, and empty option lists', () => {
    const base = {
      type: 'dsh/v1/interaction.requested',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      requestId: 'request-9',
      kind: 'question',
      prompt: 'Pick one'
    };
    expect(
      parseDshProductEvent({
        ...base,
        options: [{ id: '', label: 'Empty' }]
      })
    ).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(
      parseDshProductEvent({
        ...base,
        options: [
          { id: 'same', label: 'One' },
          { id: 'same', label: 'Two' }
        ]
      })
    ).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(parseDshProductEvent({ ...base, options: [] })).toEqual({
      ok: false,
      reason: 'invalid_payload'
    });
  });

  it('requires a non-empty prompt and a run id on interaction requested', () => {
    const withoutPrompt = parseDshProductEvent({
      type: 'dsh/v1/interaction.requested',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      requestId: 'request-9',
      kind: 'question'
    });
    const emptyPrompt = parseDshProductEvent({
      type: 'dsh/v1/interaction.requested',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      runId: 'run-7',
      requestId: 'request-9',
      kind: 'question',
      prompt: ''
    });
    const withoutRun = parseDshProductEvent({
      type: 'dsh/v1/interaction.requested',
      sessionId: 'session-1',
      runtimeId: 'runtime-3',
      requestId: 'request-9',
      kind: 'question',
      prompt: 'Pick one'
    });
    for (const result of [withoutPrompt, emptyPrompt, withoutRun]) {
      expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
    }
  });

  it('requires a run id on execution events but not on snapshots', () => {
    const cases = [
      {
        type: 'dsh/v1/text.delta',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        messageId: 'msg-1',
        delta: 'hi'
      },
      {
        type: 'dsh/v1/activity',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        activityId: 'activity-1',
        phase: 'started'
      },
      {
        type: 'dsh/v1/artifact',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        artifactId: 'artifact-1',
        phase: 'deleted'
      },
      {
        type: 'dsh/v1/interaction.cancelled',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        requestId: 'request-9'
      }
    ];
    for (const raw of cases) {
      expect(parseDshProductEvent(raw)).toEqual({
        ok: false,
        reason: 'invalid_payload'
      });
    }
    expect(
      parseDshProductEvent({
        type: 'dsh/v1/text.snapshot',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        messageId: 'msg-1',
        text: 'restored'
      }).ok
    ).toBe(true);
  });

  it('rejects invalid enum values', () => {
    expect(
      parseDshProductEvent({
        type: 'dsh/v1/activity',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        runId: 'run-7',
        activityId: 'activity-1',
        phase: 'bogus'
      })
    ).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(
      parseDshProductEvent({
        type: 'dsh/v1/interaction.resolved',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        runId: 'run-7',
        requestId: 'request-9',
        resolution: 'maybe'
      })
    ).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(
      parseDshProductEvent({
        type: 'dsh/v1/run.finished',
        sessionId: 'session-1',
        runtimeId: 'runtime-3',
        runId: 'run-7',
        status: 'ok'
      })
    ).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects capability entries that are not objects', () => {
    const result = parseDshProductEvent({
      type: 'dsh/v1/capabilities',
      runtimeId: 'runtime-3',
      capabilities: { jobs: 'available' }
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('does not forward prototype-dangerous keys', () => {
    const raw = JSON.parse(
      '{"type":"dsh/v1/text.delta","sessionId":"session-1","runtimeId":"runtime-3","runId":"run-7","messageId":"msg-1","delta":"hi","__proto__":{"polluted":true}}'
    );
    const result = parseDshProductEvent(raw);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('polluted');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
