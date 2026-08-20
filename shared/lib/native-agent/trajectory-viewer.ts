import { readFileSync } from 'node:fs';

import {
  parseSessionEventJsonl,
  type ArtifactRef,
  type SessionEvent,
} from './session-stream.schema.ts';

export type TrajectoryStepKind = 'model-turn' | 'tool-interaction' | 'lifecycle' | 'policy' | 'recovery' | 'other';

export interface TrajectoryStep {
  stepId: string;
  turnIndex: number | null;
  kind: TrajectoryStepKind;
  events: SessionEvent[];
  startSeq: number;
  endSeq: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMs: number;
  isError: boolean;
  tool?: string;
  model?: string;
  tokens?: { input?: number; output?: number; total?: number };
  redacted: boolean;
}

export interface TrajectoryProjection {
  sessionId: string;
  schemaVersion: string;
  totalEvents: number;
  totalSteps: number;
  turns: number;
  toolNames: string[];
  modelIds: string[];
  phases: string[];
  steps: TrajectoryStep[];
  lineage: {
    parentSessionId?: string;
    childForks: { childSessionId: string; eventId: string; reason: string }[];
    resumes: { fromEventId?: string; reason: string; seq: number }[];
  };
}

interface MutableStep {
  stepId: string;
  firstSeq: number;
  events: SessionEvent[];
}

const MODEL_EVENT_TYPES = new Set<SessionEvent['type']>(['model_request', 'model_response']);
const TOOL_EVENT_TYPES = new Set<SessionEvent['type']>(['tool_policy_decision', 'tool_call', 'tool_result']);

export function readTrajectoryFile(path: string): SessionEvent[] {
  return parseSessionEventJsonl(readFileSync(path, 'utf8'));
}

export function projectTrajectory(events: SessionEvent[]): TrajectoryProjection {
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const stepsByKey = new Map<string, MutableStep>();
  const eventStepKeys = new Map<string, string>();
  const toolTurnByCallId = new Map<string, number>();
  const modelTurnByCallId = new Map<string, number>();
  const modelCallByResponseEventId = new Map<string, string>();
  const lineage: TrajectoryProjection['lineage'] = { childForks: [], resumes: [] };

  let sessionId = sortedEvents[0]?.sessionId ?? 'unknown-session';
  let schemaVersion = sortedEvents[0]?.schemaVersion ?? 'unknown';

  for (const event of sortedEvents) {
    sessionId = event.sessionId || sessionId;
    schemaVersion = event.schemaVersion || schemaVersion;

    if (event.type === 'session_started' && event.parentSessionId) {
      lineage.parentSessionId = event.parentSessionId;
    }
    if (event.type === 'session_fork') {
      lineage.childForks.push({
        childSessionId: event.childSessionId,
        eventId: event.eventId,
        reason: event.reason,
      });
    }
    if (event.type === 'session_resume') {
      lineage.resumes.push({
        fromEventId: event.lastCommittedEventId,
        reason: event.reason,
        seq: event.seq,
      });
    }

    if (event.type === 'model_request') {
      modelTurnByCallId.set(event.callId, event.turnIndex);
    }
    if (event.type === 'model_response') {
      modelCallByResponseEventId.set(event.eventId, event.callId);
    }

    const stepKey = stepKeyForEvent(event, eventStepKeys);
    let step = stepsByKey.get(stepKey);
    if (!step) {
      step = { stepId: stepIdForEvent(event), firstSeq: event.seq, events: [] };
      stepsByKey.set(stepKey, step);
    }
    step.events.push(event);
    eventStepKeys.set(event.eventId, stepKey);

    if (event.type === 'tool_policy_decision' || event.type === 'tool_call' || event.type === 'tool_result') {
      const turn = inferToolTurn(event, modelTurnByCallId, modelCallByResponseEventId);
      if (turn !== null) {
        toolTurnByCallId.set(event.callId, turn);
      }
    }
  }

  const steps = [...stepsByKey.values()]
    .map((step) => finalizeStep(step, modelTurnByCallId, toolTurnByCallId))
    .sort((a, b) => a.startSeq - b.startSeq);

  const turnIndexes = new Set<number>();
  const toolNames = new Set<string>();
  const modelIds = new Set<string>();
  const phases = new Set<string>();
  for (const step of steps) {
    if (step.turnIndex !== null) turnIndexes.add(step.turnIndex);
    if (step.tool) toolNames.add(step.tool);
    if (step.model) modelIds.add(step.model);
    for (const event of step.events) phases.add(event.phase);
  }

  return {
    sessionId,
    schemaVersion,
    totalEvents: sortedEvents.length,
    totalSteps: steps.length,
    turns: turnIndexes.size,
    toolNames: sorted(toolNames),
    modelIds: sorted(modelIds),
    phases: sorted(phases),
    steps,
    lineage,
  };
}

export function renderTrajectoryHtml(projection: TrajectoryProjection, opts: { title?: string } = {}): string {
  const title = escapeHtml(opts.title ?? `Trajectory: ${projection.sessionId}`);
  const data = safeJsonForScript(projection);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f4ed;
      --panel: #fffdfa;
      --ink: #171512;
      --muted: #6d665c;
      --line: #d8d0c2;
      --accent: #0f6f6b;
      --accent-2: #b13f23;
      --danger: #d13a2f;
      --shadow: 0 12px 32px rgba(54, 45, 31, .12);
      --mono: "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
      --body: ui-serif, Georgia, Cambria, "Times New Roman", serif;
    }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; --bg: #171512; --panel: #22201c; --ink: #f5efe4; --muted: #beb5a7; --line: #3a352d; --accent: #5ec0b9; --accent-2: #f08b65; --danger: #ff6b5f; --shadow: 0 14px 38px rgba(0,0,0,.32); }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--body); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(23,21,18,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(23,21,18,.035) 1px, transparent 1px); background-size: 28px 28px; }
    header { position: sticky; top: 0; z-index: 20; padding: 18px 28px 16px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 10px; font-size: clamp(26px, 3vw, 42px); letter-spacing: 0; font-weight: 760; }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 9px; background: var(--panel); }
    .filters { display: grid; grid-template-columns: minmax(220px, 1.8fr) repeat(4, minmax(120px, 1fr)) auto; gap: 10px; margin-top: 14px; align-items: end; }
    label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; font-family: var(--mono); }
    input, select, button { min-height: 36px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 7px; padding: 7px 9px; font: 13px var(--mono); }
    button { cursor: pointer; color: var(--accent); font-weight: 700; }
    main { height: calc(100vh - 168px); overflow: auto; position: relative; }
    #spacer { position: relative; min-height: 100%; }
    #window { position: absolute; inset-inline: 0; top: 0; }
    .row { position: absolute; left: 28px; right: 28px; min-height: 82px; padding: 12px 14px 12px 18px; background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--accent); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; }
    .row.error { border-left-color: var(--danger); }
    .row.flash { outline: 3px solid var(--accent-2); }
    .row-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .row-title { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; min-width: 0; }
    .kind { font: 700 11px var(--mono); text-transform: uppercase; letter-spacing: 0; }
    .source { border-radius: 999px; padding: 2px 7px; font: 700 11px var(--mono); }
    .source.user, .source.model_request { background: #d8edf2; color: #135263; }
    .source.assistant, .source.model_response { background: #dff0dc; color: #245b2a; }
    .source.tool_call, .source.tool_result { background: #f6dfaa; color: #715113; }
    .source.tool_policy_decision, .source.approval { background: #eadcf5; color: #5d3278; }
    .source.retry, .source.session_resume { background: #ffdcca; color: #873816; }
    .source.lifecycle, .source.session_started, .source.session_ended, .source.session_fork, .source.compaction, .source.tool_menu, .source.provider_tools, .source.mutation_outcome { background: #e5e0d6; color: #4d473e; }
    .meta { color: var(--muted); font: 12px var(--mono); display: flex; gap: 8px; flex-wrap: wrap; }
    .events { display: grid; gap: 6px; font: 12px var(--mono); }
    .event { display: grid; grid-template-columns: 138px 1fr; gap: 10px; align-items: start; border-top: 1px dashed var(--line); padding-top: 6px; }
    .event a { color: var(--accent); text-decoration: none; }
    .detail { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 44px 28px; color: var(--muted); }
    mark { background: #ffe47a; color: #1f1a10; padding: 0 2px; border-radius: 2px; }
    @media (max-width: 860px) {
      header { padding: 14px 14px 12px; }
      .filters { grid-template-columns: 1fr 1fr; }
      .filters label:first-child { grid-column: 1 / -1; }
      .row { left: 12px; right: 12px; }
      main { height: calc(100vh - 246px); }
      .event { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <div class="summary" id="summary"></div>
    <div class="filters">
      <label>Search<input id="search" type="search" autocomplete="off" placeholder="event id, tool, summary, digest"></label>
      <label>Source<select id="source"><option value="">All</option></select></label>
      <label>Tool<select id="tool"><option value="">All</option></select></label>
      <label>Model<select id="model"><option value="">All</option></select></label>
      <label>Status<select id="status"><option value="">All</option><option value="error">Failures</option><option value="redacted">Redacted</option></select></label>
      <label>Phase<select id="phase"><option value="">All</option></select></label>
      <button id="clear" type="button" title="Clear filters">Clear</button>
    </div>
  </header>
  <nav id="trajectory-anchors" hidden>${renderStaticAnchors(projection)}</nav>
  <main id="timeline" aria-label="Trajectory timeline"><div id="spacer"><div id="window"></div></div></main>
  <script id="trajectory-data" type="application/json">${data}</script>
  <script>
  (() => {
    const projection = JSON.parse(document.getElementById('trajectory-data').textContent);
    const steps = projection.steps;
    const rowHeight = 102;
    const overscan = 600;
    const el = {
      summary: document.getElementById('summary'), timeline: document.getElementById('timeline'),
      spacer: document.getElementById('spacer'), window: document.getElementById('window'),
      search: document.getElementById('search'), source: document.getElementById('source'),
      tool: document.getElementById('tool'), model: document.getElementById('model'),
      status: document.getElementById('status'), phase: document.getElementById('phase'),
      clear: document.getElementById('clear')
    };
    const sources = [...new Set(steps.flatMap(s => s.events.map(e => e.type)))].sort();
    const haystacks = steps.map(step => JSON.stringify(step).toLowerCase());
    let filtered = steps.map((_, i) => i);
    let lastRange = '';

    el.summary.innerHTML = [
      pill(projection.sessionId), pill(projection.totalEvents + ' events'), pill(projection.totalSteps + ' steps'),
      pill(projection.turns + ' turns'), pill('schema ' + projection.schemaVersion),
      projection.lineage.parentSessionId ? pill('parent ' + esc(projection.lineage.parentSessionId)) : '',
      ...projection.lineage.childForks.map(f => pill('fork ' + esc(f.childSessionId)))
    ].join('');
    fill(el.source, sources); fill(el.tool, projection.toolNames); fill(el.model, projection.modelIds); fill(el.phase, projection.phases);

    function pill(text) { return '<span class="pill">' + text + '</span>'; }
    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function fill(select, values) {
      for (const value of values) {
        const option = document.createElement('option');
        option.value = value; option.textContent = value; select.appendChild(option);
      }
    }
    function stepSources(step) { return new Set(step.events.map(e => e.type)); }
    function applyFilters() {
      const q = el.search.value.trim().toLowerCase();
      filtered = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (q && !haystacks[i].includes(q)) continue;
        if (el.source.value && !stepSources(step).has(el.source.value)) continue;
        if (el.tool.value && step.tool !== el.tool.value) continue;
        if (el.model.value && step.model !== el.model.value) continue;
        if (el.phase.value && !step.events.some(e => e.phase === el.phase.value)) continue;
        if (el.status.value === 'error' && !step.isError) continue;
        if (el.status.value === 'redacted' && !step.redacted) continue;
        filtered.push(i);
      }
      el.spacer.style.height = Math.max(filtered.length * rowHeight, el.timeline.clientHeight) + 'px';
      lastRange = '';
      render();
    }
    function render() {
      const start = Math.max(0, Math.floor((el.timeline.scrollTop - overscan) / rowHeight));
      const end = Math.min(filtered.length, Math.ceil((el.timeline.scrollTop + el.timeline.clientHeight + overscan) / rowHeight));
      const range = start + ':' + end + ':' + filtered.join(',');
      if (range === lastRange) return;
      lastRange = range;
      el.window.innerHTML = filtered.length ? '' : '<div class="empty">No matching trajectory steps.</div>';
      for (let visible = start; visible < end; visible++) {
        const stepIndex = filtered[visible];
        const step = steps[stepIndex];
        const row = document.createElement('article');
        row.className = 'row' + (step.isError ? ' error' : '');
        row.id = 'step-' + safeId(step.stepId);
        row.style.transform = 'translateY(' + (visible * rowHeight + 10) + 'px)';
        row.innerHTML = renderStep(step);
        el.window.appendChild(row);
      }
    }
    function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '-'); }
    function highlight(text) {
      const q = el.search.value.trim();
      const escaped = esc(text);
      if (!q) return escaped;
      return escaped.replace(new RegExp(escapeRegExp(q), 'ig'), m => '<mark>' + m + '</mark>');
    }
    function escapeRegExp(value) {
      return value.split('').map(ch => '\\\\^$.*+?()[]{}|'.includes(ch) ? '\\\\' + ch : ch).join('');
    }
    function eventSummary(event) {
      const parts = [event.eventId, event.phase, event.causedByEventId ? 'caused by ' + event.causedByEventId : ''];
      if (event.callId) parts.push('callId ' + event.callId);
      if (event.toolName) parts.push(event.toolName);
      if (event.modelId) parts.push(event.modelId);
      if (event.actualModel) parts.push(event.actualModel);
      if (event.argumentsSummary) parts.push(event.argumentsSummary);
      if (event.contentSummary) parts.push(typeof event.contentSummary === 'string' ? event.contentSummary : JSON.stringify(event.contentSummary));
      if (event.stopReason) parts.push('stop ' + event.stopReason);
      if (event.reason) parts.push(event.reason);
      if (event.denialReason) parts.push(event.denialReason);
      if (event.notes) parts.push(event.notes);
      if (event.artifactRef) parts.push('artifact ' + artifactSummary(event.artifactRef));
      if (event.redaction) parts.push('redaction ' + JSON.stringify(event.redaction));
      if (event.usage) parts.push('tokens ' + JSON.stringify(event.usage));
      if (event.failedEventId) parts.push('retry failed ' + event.failedEventId);
      return parts.filter(Boolean).join(' | ');
    }
    function artifactSummary(ref) {
      return [ref.digest, ref.byteSize + ' bytes', ref.truncated ? 'truncated' : '', ref.originalByteSize ? 'original ' + ref.originalByteSize : ''].filter(Boolean).join(' ');
    }
    function renderStep(step) {
      const duration = step.durationMs ? step.durationMs + ' ms' : 'instant';
      const token = step.tokens ? 'tokens ' + [step.tokens.input, step.tokens.output, step.tokens.total].filter(v => v !== undefined).join('/') : '';
      const meta = ['seq ' + step.startSeq + '-' + step.endSeq, step.turnIndex === null ? 'session' : 'turn ' + step.turnIndex, duration, token, step.tool, step.model].filter(Boolean).map(esc).join(' · ');
      const events = step.events.map(event => '<div class="event" id="event-' + esc(event.eventId) + '"><a href="#event-' + esc(event.eventId) + '">' + esc(event.type) + '</a><div class="detail">' + highlight(eventSummary(event)) + causalLink(event) + '</div></div>').join('');
      return '<div class="row-head"><div class="row-title"><span class="kind">' + esc(step.kind) + '</span><span class="source ' + esc(step.events[0].type) + '">' + esc(step.events[0].type) + '</span>' + (step.redacted ? '<span title="Content redacted / stored as artifact - not shown in trajectory view.">locked</span>' : '') + '</div><div class="meta">' + meta + '</div></div><div class="events">' + events + '</div>';
    }
    function causalLink(event) {
      const target = event.failedEventId || event.causedByEventId || event.requestEventId;
      return target ? ' <a href="#event-' + esc(target) + '">from ' + esc(target.slice(0, 12)) + '</a>' : '';
    }
    function scrollToHash() {
      const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (!raw) return;
      let stepIndex = -1;
      if (raw.startsWith('step-')) stepIndex = steps.findIndex(s => 'step-' + safeId(s.stepId) === raw);
      if (raw.startsWith('event-')) stepIndex = steps.findIndex(s => s.events.some(e => 'event-' + e.eventId === raw));
      if (stepIndex < 0) return;
      let visible = filtered.indexOf(stepIndex);
      if (visible < 0) { clearFilters(); visible = filtered.indexOf(stepIndex); }
      el.timeline.scrollTop = visible * rowHeight;
      render();
      requestAnimationFrame(() => {
        const row = document.getElementById('step-' + safeId(steps[stepIndex].stepId));
        if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200); }
      });
    }
    function clearFilters() { el.search.value = el.source.value = el.tool.value = el.model.value = el.status.value = el.phase.value = ''; applyFilters(); }
    for (const control of [el.search, el.source, el.tool, el.model, el.status, el.phase]) control.addEventListener('input', applyFilters);
    el.clear.addEventListener('click', clearFilters);
    el.timeline.addEventListener('scroll', render, { passive: true });
    window.addEventListener('resize', applyFilters);
    window.addEventListener('hashchange', scrollToHash);
    window.addEventListener('keydown', event => {
      if (event.key === '/' && document.activeElement !== el.search) { event.preventDefault(); el.search.focus(); }
      if (event.key === 'Escape') clearFilters();
      if (event.key === 'n' || event.key === 'p') {
        const next = Math.max(0, Math.min(filtered.length - 1, Math.round(el.timeline.scrollTop / rowHeight) + (event.key === 'n' ? 1 : -1)));
        el.timeline.scrollTop = next * rowHeight;
      }
    });
    applyFilters();
    scrollToHash();
  })();
  </script>
</body>
</html>`;
}

function stepKeyForEvent(event: SessionEvent, eventStepKeys: Map<string, string>): string {
  if (MODEL_EVENT_TYPES.has(event.type) && 'callId' in event) return `model:${event.callId}`;
  if (TOOL_EVENT_TYPES.has(event.type) && 'callId' in event) return `tool:${event.callId}`;
  if (event.type === 'mutation_outcome' && event.toolCallId) return `tool:${event.toolCallId}`;
  if (event.causedByEventId) {
    const causedStepKey = eventStepKeys.get(event.causedByEventId);
    if (causedStepKey && event.type !== 'retry' && event.type !== 'session_resume') return causedStepKey;
  }
  return `event:${event.eventId}`;
}

function stepIdForEvent(event: SessionEvent): string {
  if ('callId' in event) return event.callId;
  if (event.type === 'mutation_outcome' && event.toolCallId) return event.toolCallId;
  return event.eventId;
}

function inferToolTurn(
  event: Extract<SessionEvent, { type: 'tool_policy_decision' | 'tool_call' | 'tool_result' }>,
  modelTurnByCallId: Map<string, number>,
  modelCallByResponseEventId: Map<string, string>,
): number | null {
  if (event.causedByEventId) {
    const modelCallId = modelCallByResponseEventId.get(event.causedByEventId);
    if (modelCallId) return modelTurnByCallId.get(modelCallId) ?? null;
  }
  return null;
}

function finalizeStep(
  step: MutableStep,
  modelTurnByCallId: Map<string, number>,
  toolTurnByCallId: Map<string, number>,
): TrajectoryStep {
  const events = [...step.events].sort((a, b) => a.seq - b.seq);
  const start = events[0];
  const end = events[events.length - 1];
  const kind = kindForEvents(events);
  const callId = 'callId' in start ? start.callId : undefined;
  const turnIndex = kind === 'model-turn' && callId
    ? modelTurnByCallId.get(callId) ?? null
    : kind === 'tool-interaction' && callId
      ? toolTurnByCallId.get(callId) ?? null
      : null;
  const tokens = tokensForEvents(events);
  return {
    stepId: step.stepId,
    turnIndex,
    kind,
    events,
    startSeq: start.seq,
    endSeq: end.seq,
    startTimestamp: timestampMs(start.timestamp),
    endTimestamp: timestampMs(end.timestamp),
    durationMs: Math.max(0, timestampMs(end.timestamp) - timestampMs(start.timestamp)),
    isError: events.some((event) => ('isError' in event && event.isError) || (event.type === 'tool_policy_decision' && event.decision === 'deny')),
    tool: toolForEvents(events),
    model: modelForEvents(events),
    ...(tokens ? { tokens } : {}),
    redacted: events.some(hasRedactionOrArtifact),
  };
}

function kindForEvents(events: SessionEvent[]): TrajectoryStepKind {
  if (events.some((event) => MODEL_EVENT_TYPES.has(event.type))) return 'model-turn';
  if (events.some((event) => TOOL_EVENT_TYPES.has(event.type) || event.type === 'mutation_outcome')) return 'tool-interaction';
  if (events.some((event) => event.type === 'tool_policy_decision' || event.type === 'approval')) return 'policy';
  if (events.some((event) => event.type === 'retry' || event.type === 'session_resume')) return 'recovery';
  if (events.some((event) => event.type === 'session_started' || event.type === 'session_ended' || event.type === 'session_fork' || event.type === 'compaction')) return 'lifecycle';
  return 'other';
}

function tokensForEvents(events: SessionEvent[]): TrajectoryStep['tokens'] | undefined {
  const input = sum(events, (event) => event.type === 'model_response' ? event.usage?.inputTokens : undefined);
  const output = sum(events, (event) => event.type === 'model_response' ? event.usage?.outputTokens : undefined);
  const total = input + output;
  if (input === 0 && output === 0) return undefined;
  return {
    ...(input > 0 ? { input } : {}),
    ...(output > 0 ? { output } : {}),
    total,
  };
}

function sum(events: SessionEvent[], pick: (event: SessionEvent) => number | undefined): number {
  return events.reduce((total, event) => total + (pick(event) ?? 0), 0);
}

function toolForEvents(events: SessionEvent[]): string | undefined {
  return events.find((event) => 'toolName' in event)?.toolName;
}

function modelForEvents(events: SessionEvent[]): string | undefined {
  const response = events.find((event) => event.type === 'model_response');
  if (response?.type === 'model_response' && response.actualModel) return response.actualModel;
  const request = events.find((event) => event.type === 'model_request');
  return request?.type === 'model_request' ? request.modelId : undefined;
}

function hasRedactionOrArtifact(event: SessionEvent): boolean {
  return Boolean(
    ('redaction' in event && event.redaction?.redacted === true)
    || ('artifactRef' in event && (event.artifactRef as ArtifactRef | undefined)),
  );
}

function timestampMs(timestamp: string | number): number {
  return typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('</script>', '<\\/script>')
    .replace(/<(?!\\\/script>)/g, '\\u003c')
    .replaceAll('&', '\\u0026');
}

function renderStaticAnchors(projection: TrajectoryProjection): string {
  return projection.steps.map((step) => {
    const stepAnchor = `<a id="step-${escapeHtml(safeId(step.stepId))}"></a>`;
    const eventAnchors = step.events.map((event) => `<a id="event-${escapeHtml(event.eventId)}"></a>`).join('');
    return `${stepAnchor}${eventAnchors}`;
  }).join('');
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
