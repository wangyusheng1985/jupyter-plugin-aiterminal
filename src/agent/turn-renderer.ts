import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import { renderMarkdownSource } from './markdown';
import { formatToolInput } from './tool';
import {
  isTraceExpanded,
  type ChatTurn,
  type TurnActivity,
  type TurnDiagnostic
} from './turn';

export interface TurnRenderHandlers {
  onToggleTrace: (turnId: string) => void;
  onToggleActivity: (turnId: string, activityId: string) => void;
  onToggleEvidence: (turnId: string, activityId: string) => void;
  onToggleOutcome: (turnId: string) => void;
  onRevealFailure: (turnId: string, activityId: string) => void;
  onRetry: (turnId: string) => void;
}

export interface TurnRenderOptions {
  rendermime?: IRenderMimeRegistry | null;
  handlers: TurnRenderHandlers;
}

const OUTCOME_PREVIEW_LENGTH = 1800;
const OUTCOME_PREVIEW_LINES = 24;
const RUNNING_ACTIVITY_WINDOW = 3;

export function renderTurn(
  turn: ChatTurn,
  options: TurnRenderOptions
): HTMLElement {
  const root = document.createElement('div');
  root.className = `jp-AgentWorkspace-turn is-${turn.status}`;
  root.dataset.turnId = turn.id;
  root.dataset.turnRevision = String(turn.revision);

  if (turn.outcome) {
    root.append(renderOutcome(turn, options));
  }
  if (turn.timeline.length) {
    root.append(renderAuditSummary(turn, options));
  }
  if (isRetryableTurn(turn)) {
    root.append(renderRetryControl(turn, options));
  }
  return root;
}

function renderRetryControl(
  turn: ChatTurn,
  options: TurnRenderOptions
): HTMLElement {
  const region = document.createElement('div');
  region.className = 'jp-AgentWorkspace-retryRegion';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'jp-AgentWorkspace-turnControl jp-AgentWorkspace-retryTurn';
  retry.dataset.turnControl = '';
  retry.textContent = 'Retry as new turn';
  retry.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    options.handlers.onRetry(turn.id);
  });
  retry.addEventListener('mousedown', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  region.append(retry);
  return region;
}

function isRetryableTurn(turn: ChatTurn): boolean {
  return (
    turn.status === 'interrupted' ||
    turn.status === 'error' ||
    turn.diagnostics.length > 0
  );
}

export function turnSummary(turn: ChatTurn): string {
  return auditMetricParts(turn).join(' | ');
}

function renderOutcome(
  turn: ChatTurn,
  options: TurnRenderOptions
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'jp-AgentWorkspace-outcome';

  const long = isLongOutcome(turn.outcome);
  const expanded = turn.presentation.outcomeExpanded;
  const body = document.createElement('div');
  body.className = 'jp-AgentWorkspace-outcomeBody';
  body.dataset.turnScrollKey = `outcome:${turn.id}`;
  if (long && !expanded) {
    body.classList.add('is-preview');
    renderMarkdownSource(
      body,
      boundedOutcomePreview(turn.outcome),
      options.rendermime ?? null
    );
  } else {
    renderMarkdownSource(body, turn.outcome, options.rendermime ?? null);
  }
  section.append(body);

  if (long) {
    section.append(
      disclosureButton(
        expanded ? 'Show less' : 'Show full result',
        expanded,
        `outcome:${turn.id}`,
        () => options.handlers.onToggleOutcome(turn.id)
      )
    );
  }
  return section;
}

function renderAuditSummary(
  turn: ChatTurn,
  options: TurnRenderOptions
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'jp-AgentWorkspace-auditSummary';
  const expanded = isTraceExpanded(turn);
  const recordId = `jp-AgentWorkspace-record-${turn.id}`;
  const toggle = disclosureButton(
    expanded ? 'Hide execution record' : 'Show execution record',
    expanded,
    `trace:${turn.id}`,
    () => options.handlers.onToggleTrace(turn.id)
  );
  toggle.classList.add('jp-AgentWorkspace-auditToggle');
  toggle.setAttribute('aria-controls', recordId);
  section.append(toggle);

  const failures = failureActivityIds(turn);
  const firstFailure = failures[0];
  if (firstFailure) {
    const failure = document.createElement('button');
    failure.type = 'button';
    failure.className =
      'jp-AgentWorkspace-turnControl jp-AgentWorkspace-failureNavigation';
    failure.dataset.turnControl = '';
    failure.dataset.failureNavigation = '';
    failure.textContent = `${failures.length} ${
      failures.length === 1 ? 'step' : 'steps'
    } failed`;
    failure.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      options.handlers.onRevealFailure(turn.id, firstFailure);
    });
    failure.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    section.append(failure);
  }

  const metrics = document.createElement('div');
  metrics.className = 'jp-AgentWorkspace-auditStats';
  auditMetricParts(turn).forEach(part => {
    const item = document.createElement('span');
    item.textContent = part;
    metrics.append(item);
  });
  if (metrics.childElementCount) section.append(metrics);

  if (expanded) {
    section.append(renderExecutionRecord(turn, recordId, options));
  }
  return section;
}

function renderExecutionRecord(
  turn: ChatTurn,
  recordId: string,
  options: TurnRenderOptions
): HTMLElement {
  const record = document.createElement('div');
  record.id = recordId;
  record.className = 'jp-AgentWorkspace-executionRecord';
  record.setAttribute('role', 'list');

  const heading = document.createElement('div');
  heading.className = 'jp-AgentWorkspace-recordHeading';
  const title = document.createElement('span');
  title.className = 'jp-AgentWorkspace-recordTitle';
  title.textContent = 'Execution record';
  const note = document.createElement('span');
  note.className = 'jp-AgentWorkspace-recordNote';
  note.textContent = 'Chronological, original evidence preserved';
  heading.append(title, note);
  record.append(heading);

  const runningStart =
    turn.status === 'running'
      ? Math.max(0, turn.timeline.length - RUNNING_ACTIVITY_WINDOW)
      : 0;
  if (runningStart > 0) {
    const earlier = document.createElement('div');
    earlier.className = 'jp-AgentWorkspace-earlierActivities';
    earlier.textContent = `${runningStart} earlier ${
      runningStart === 1 ? 'activity' : 'activities'
    }`;
    record.append(earlier);
  }
  turn.timeline.forEach((activity, index) => {
    record.append(renderActivity(turn, activity, index, runningStart, options));
  });
  return record;
}

function renderActivity(
  turn: ChatTurn,
  activity: TurnActivity,
  index: number,
  runningStart: number,
  options: TurnRenderOptions
): HTMLElement {
  const item = document.createElement('div');
  item.className = `jp-AgentWorkspace-activity is-${activity.kind}`;
  item.dataset.activityId = activity.id;
  item.setAttribute('role', 'listitem');
  if (activity.status === 'error' || activity.status === 'failed') {
    item.classList.add('is-failed');
  }
  const userExpanded = turn.presentation.expandedActivityIds.includes(
    activity.id
  );
  const compact =
    turn.status === 'running' && index < runningStart && !userExpanded;
  if (compact) item.classList.add('is-compact');
  const autoExpanded = shouldAutoExpandActivity(turn, activity, index);
  const expanded = userExpanded || (autoExpanded && !compact);
  const summary = activitySummary(activity);
  const header = document.createElement('button');
  header.type = 'button';
  header.className =
    'jp-AgentWorkspace-disclosure jp-AgentWorkspace-turnControl jp-AgentWorkspace-activityHeader';
  header.dataset.turnActivityId = activity.id;
  configureDisclosure(header, expanded, `activity:${activity.id}`, () =>
    options.handlers.onToggleActivity(turn.id, activity.id)
  );
  const marker = document.createElement('span');
  marker.className = `jp-AgentWorkspace-disclosureMarker jp-MaterialIcon ${
    expanded ? 'jp-CaretDownIcon' : 'jp-CaretRightIcon'
  }`;
  marker.setAttribute('aria-hidden', 'true');
  const sequence = document.createElement('span');
  sequence.className = 'jp-AgentWorkspace-stepNumber';
  sequence.textContent = String(index + 1);
  const operation = document.createElement('span');
  operation.className = 'jp-AgentWorkspace-stepOperation';
  const action = document.createElement('strong');
  action.textContent = activityAction(activity, summary.title);
  operation.append(action);
  const target = activityTarget(activity, summary.title);
  if (target) {
    const targetNode = document.createElement('span');
    targetNode.textContent = target;
    targetNode.title = target;
    operation.append(targetNode);
  }
  const result = document.createElement('span');
  result.className = `jp-AgentWorkspace-stepResult is-${activity.status}`;
  result.textContent = activityResult(activity, summary.detail);
  const duration = document.createElement('span');
  duration.className = 'jp-AgentWorkspace-stepDuration';
  duration.textContent =
    activity.kind === 'tool' ? formatDuration(activity.durationMs) : '';
  header.append(marker, sequence, operation, result, duration);
  item.append(header);

  if (expanded) {
    item.append(renderActivityDetails(turn, activity, options));
  }
  if (
    turn.status === 'running' &&
    index === turn.timeline.length - 1 &&
    !compact
  ) {
    item.classList.add('is-current');
  }
  return item;
}

function renderActivityDetails(
  turn: ChatTurn,
  activity: TurnActivity,
  options: TurnRenderOptions
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'jp-AgentWorkspace-activityBody';

  switch (activity.kind) {
    case 'text':
      renderMarkdownSource(body, activity.text, options.rendermime ?? null);
      break;
    case 'thinking':
      body.textContent = 'Reasoning activity';
      break;
    case 'install':
    case 'denied':
    case 'error':
    case 'unknown':
      body.textContent = activity.detail || activity.title;
      break;
    case 'tool':
      renderToolDetails(turn, activity, body, options);
      break;
  }

  if (activity.kind === 'tool' || activity.kind === 'install') {
    appendActivityDiagnostics(
      body,
      turn.diagnostics.filter(diagnostic => {
        return diagnostic.activityId === activity.id;
      })
    );
  }
  return body;
}

function renderToolDetails(
  turn: ChatTurn,
  activity: Extract<TurnActivity, { kind: 'tool' }>,
  body: HTMLElement,
  options: TurnRenderOptions
): HTMLElement {
  const evidenceContainer = document.createElement('div');
  evidenceContainer.className = 'jp-AgentWorkspace-activityEvidence';
  const input = document.createElement('pre');
  input.className = 'jp-AgentWorkspace-toolInput';
  input.textContent = formatToolInput(activity.name, activity.input);
  input.dataset.turnScrollKey = `input:${activity.id}`;
  if (input.textContent) {
    evidenceContainer.append(evidenceLabel('Input'), input);
  }

  const full = turn.presentation.fullEvidenceActivityIds.includes(activity.id);
  if (activity.output) {
    const output = document.createElement('pre');
    output.className = 'jp-AgentWorkspace-toolOutput';
    output.dataset.turnScrollKey = `output:${activity.id}`;
    output.textContent = full ? activity.output : activity.presentation.preview;
    evidenceContainer.append(
      evidenceLabel(activity.status === 'error' ? 'Output tail' : 'Output'),
      output
    );
  }

  const hasHiddenEvidence =
    activity.presentation.hiddenLineCount > 0 ||
    activity.presentation.hiddenCharacterCount > 0;
  if (!full && hasHiddenEvidence) {
    const hidden = document.createElement('div');
    hidden.className = 'jp-AgentWorkspace-hiddenEvidence';
    hidden.textContent = activity.presentation.hiddenLineCount
      ? `${activity.presentation.hiddenLineCount} more output lines`
      : `${formatCount(activity.presentation.hiddenCharacterCount)} more characters`;
    evidenceContainer.append(hidden);
  }
  if (activity.output && hasHiddenEvidence) {
    const evidenceToggle = disclosureButton(
      full ? 'Show preview' : 'Show full output',
      full,
      `evidence:${activity.id}`,
      () => options.handlers.onToggleEvidence(turn.id, activity.id)
    );
    evidenceToggle.classList.add('jp-AgentWorkspace-evidenceToggle');
    evidenceContainer.append(evidenceToggle);
  }
  if (evidenceContainer.childElementCount) body.append(evidenceContainer);
  return body;
}

function evidenceLabel(text: string): HTMLElement {
  const label = document.createElement('div');
  label.className = 'jp-AgentWorkspace-evidenceLabel';
  label.textContent = text;
  return label;
}

function appendActivityDiagnostics(
  body: HTMLElement,
  diagnostics: TurnDiagnostic[]
): void {
  if (!diagnostics.length) return;
  const list = document.createElement('div');
  list.className = 'jp-AgentWorkspace-activityDiagnostics';
  diagnostics.forEach(diagnostic => {
    const item = document.createElement('div');
    item.className = `jp-AgentWorkspace-activityDiagnostic is-${diagnostic.tone}`;
    const title = document.createElement('strong');
    title.textContent = diagnostic.title;
    const detail = document.createElement('span');
    detail.textContent = diagnostic.detail;
    item.append(title, detail);
    list.append(item);
  });
  body.append(list);
}

function disclosureButton(
  label: string,
  expanded: boolean,
  focusKey: string,
  onClick: () => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jp-AgentWorkspace-disclosure';
  configureDisclosure(button, expanded, focusKey, onClick);
  const marker = document.createElement('span');
  marker.className = `jp-AgentWorkspace-disclosureMarker jp-MaterialIcon ${
    expanded ? 'jp-CaretDownIcon' : 'jp-CaretRightIcon'
  }`;
  marker.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'jp-AgentWorkspace-disclosureText';
  text.textContent = label;
  button.append(marker, text);
  return button;
}

function configureDisclosure(
  button: HTMLButtonElement,
  expanded: boolean,
  focusKey: string,
  onClick: () => void
): void {
  button.dataset.turnFocusKey = focusKey;
  button.dataset.turnControl = '';
  button.setAttribute('aria-expanded', String(expanded));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  button.addEventListener('mousedown', event => {
    event.preventDefault();
    event.stopPropagation();
  });
}

function activitySummary(activity: TurnActivity): {
  title: string;
  detail: string;
} {
  switch (activity.kind) {
    case 'text':
      return {
        title: 'Assistant note',
        detail: firstLine(activity.text)
      };
    case 'thinking':
      return {
        title: activity.status === 'started' ? 'Thinking' : 'Thought',
        detail: ''
      };
    case 'tool':
      return {
        title: activity.presentation.title,
        detail: activity.presentation.detail
      };
    case 'install':
      return { title: activity.title, detail: activity.status };
    case 'denied':
    case 'error':
    case 'unknown':
      return { title: activity.title, detail: activity.detail };
  }
}

function activityAction(activity: TurnActivity, title: string): string {
  switch (activity.kind) {
    case 'tool':
      return activity.name || title;
    case 'install':
      return 'Install';
    case 'denied':
      return 'Denied';
    case 'error':
      return activity.title;
    case 'unknown':
      return 'Unknown tool';
    case 'thinking':
      return title;
    case 'text':
      return 'Assistant note';
  }
}

function activityTarget(activity: TurnActivity, title: string): string {
  switch (activity.kind) {
    case 'tool':
      return activity.name && title.startsWith(`${activity.name} `)
        ? title.slice(activity.name.length + 1)
        : title;
    case 'text':
      return firstLine(activity.text);
    case 'thinking':
      return 'Reasoning';
    case 'install':
    case 'denied':
    case 'error':
    case 'unknown':
      return activity.detail || activity.title;
  }
}

function activityResult(activity: TurnActivity, fallback: string): string {
  if (activity.kind === 'tool') {
    if (activity.status === 'error') {
      const failure = firstLine(activity.presentation.preview);
      return failure ? `Failed: ${failure}` : 'Failed';
    }
    if (activity.status === 'running') {
      return fallback ? `Running: ${fallback}` : 'Running';
    }
    return fallback || 'Completed';
  }
  if (activity.status === 'failed' || activity.status === 'error') {
    return 'Failed';
  }
  if (activity.status === 'started') {
    return 'Running';
  }
  if (activity.status === 'info') return 'Recorded';
  return 'Completed';
}

function shouldAutoExpandActivity(
  turn: ChatTurn,
  activity: TurnActivity,
  index: number
): boolean {
  if (turn.status !== 'running' || index !== turn.timeline.length - 1) {
    return false;
  }
  return activity.kind === 'tool' || activity.kind === 'text';
}

function auditMetricParts(turn: ChatTurn): string[] {
  const parts = [
    `${turn.timeline.length} ${turn.timeline.length === 1 ? 'step' : 'steps'}`
  ];
  const duration = formatDuration(turn.metrics.durationMs);
  if (duration) parts.push(duration);
  if (turn.changes.length) {
    parts.push(
      `${turn.changes.length} ${
        turn.changes.length === 1 ? 'file changed' : 'files changed'
      }`
    );
  }
  return parts;
}

function failureActivityIds(turn: ChatTurn): string[] {
  const timelineIds = new Set(turn.timeline.map(activity => activity.id));
  const failed = new Set(
    turn.timeline
      .filter(activity => {
        return activity.status === 'error' || activity.status === 'failed';
      })
      .map(activity => activity.id)
  );
  turn.diagnostics.forEach(diagnostic => {
    if (timelineIds.has(diagnostic.activityId)) {
      failed.add(diagnostic.activityId);
    }
  });
  return turn.timeline
    .filter(activity => failed.has(activity.id))
    .map(activity => activity.id);
}

function firstLine(value: string): string {
  const line = value.trim().split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function isLongOutcome(value: string): boolean {
  return (
    value.length > OUTCOME_PREVIEW_LENGTH ||
    value.split('\n').length > OUTCOME_PREVIEW_LINES
  );
}

function boundedOutcomePreview(value: string): string {
  const lines = value.split('\n');
  const lineBounded =
    lines.length > OUTCOME_PREVIEW_LINES
      ? lines.slice(0, OUTCOME_PREVIEW_LINES).join('\n')
      : value;
  return lineBounded.length > OUTCOME_PREVIEW_LENGTH
    ? lineBounded.slice(0, OUTCOME_PREVIEW_LENGTH)
    : lineBounded;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
