import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  projectTrajectory,
  readTrajectoryFile,
  renderTrajectoryHtml,
} from './trajectory-viewer.ts';
import {
  SessionStreamParseError,
  type SessionEvent,
} from './session-stream.schema.ts';

const FIXTURE = 'shared/lib/native-agent/fixtures/sample-trajectory.jsonl';

function fixtureEvents(): SessionEvent[] {
  return readTrajectoryFile(FIXTURE);
}

describe('trajectory parsing', () => {
  it('reads the sample fixture', () => {
    const events = fixtureEvents();
    assert.equal(events.length, 21);
    assert.equal(events[0].type, 'session_started');
    assert.equal(events.at(-1)?.type, 'session_ended');
  });

  it('raises SessionStreamParseError with line number for malformed JSONL', () => {
    const path = join(tmpdir(), `bad-trajectory-${process.pid}-${Date.now()}.jsonl`);
    writeFileSync(path, '{"type":"session_started"}\n{bad json}\n', 'utf8');
    assert.throws(
      () => readTrajectoryFile(path),
      (error: unknown) => error instanceof SessionStreamParseError && error.lineNumber === 2,
    );
  });
});

describe('trajectory projection', () => {
  it('groups model request and response by callId', () => {
    const projection = projectTrajectory(fixtureEvents());
    const step = projection.steps.find((candidate) => candidate.stepId === 'model-call-turn-0');
    assert(step);
    assert.equal(step.kind, 'model-turn');
    assert.deepEqual(step.events.map((event) => event.type), ['model_request', 'model_response']);
  });

  it('groups tool policy, call, result, and mutation outcome by callId', () => {
    const projection = projectTrajectory(fixtureEvents());
    const step = projection.steps.find((candidate) => candidate.stepId === 'tool-call-read');
    assert(step);
    assert.equal(step.kind, 'tool-interaction');
    assert.deepEqual(step.events.map((event) => event.type), [
      'tool_policy_decision',
      'tool_call',
      'tool_result',
      'mutation_outcome',
    ]);
  });

  it('keeps turn indexing on turn-scoped steps and null for session-level steps', () => {
    const projection = projectTrajectory(fixtureEvents());
    assert.equal(projection.steps.find((step) => step.stepId === 'model-call-turn-1')?.turnIndex, 1);
    assert.equal(projection.steps.find((step) => step.stepId === 'tool-call-bash')?.turnIndex, 1);
    assert.equal(projection.steps.find((step) => step.events[0].type === 'compaction')?.turnIndex, null);
    assert.equal(projection.turns, 2);
  });

  it('localizes tool failure to the tool step', () => {
    const projection = projectTrajectory(fixtureEvents());
    assert.equal(projection.steps.find((step) => step.stepId === 'tool-call-bash')?.isError, true);
    assert.equal(projection.steps.find((step) => step.stepId === 'model-call-turn-1')?.isError, false);
  });

  it('aggregates token usage from model steps and degrades gracefully', () => {
    const projection = projectTrajectory(fixtureEvents());
    assert.deepEqual(projection.steps.find((step) => step.stepId === 'model-call-turn-0')?.tokens, {
      input: 1200,
      output: 180,
      total: 1380,
    });
    assert.equal(projection.steps.find((step) => step.stepId === 'tool-call-read')?.tokens, undefined);
  });

  it('preserves redaction and artifact metadata without resolving artifact contents', () => {
    const projection = projectTrajectory(fixtureEvents());
    const redacted = projection.steps.find((step) => step.stepId === 'tool-call-bash');
    assert.equal(redacted?.redacted, true);
    assert.equal(JSON.stringify(redacted).includes('redacted-bash-output'), true);
    assert.equal(JSON.stringify(redacted).includes('SECRET_ARTIFACT_CONTENT'), false);

    const compacted = projection.steps.find((step) => step.events[0].type === 'compaction');
    assert.equal(compacted?.redacted, true);
  });

  it('surfaces lineage from session lifecycle events', () => {
    const projection = projectTrajectory(fixtureEvents());
    assert.equal(projection.lineage.parentSessionId, 'parent-session-01');
    assert.deepEqual(projection.lineage.childForks, [{
      childSessionId: 'session-trajectory-subagent',
      eventId: 'evt-0020-fork',
      reason: 'delegate fixture validation',
    }]);
    assert.deepEqual(projection.lineage.resumes, [{
      fromEventId: 'evt-0018-approval-approved',
      reason: 'manual continuation after approval',
      seq: 19,
    }]);
  });

  it('exposes sorted, deduped filter surfaces', () => {
    const projection = projectTrajectory(fixtureEvents());
    assert.deepEqual(projection.toolNames, ['Bash', 'Read']);
    assert.deepEqual(projection.modelIds, ['gpt-5-codex']);
    assert.deepEqual(projection.phases, ['coding']);

    const empty = projectTrajectory([baseEvent('session_started', 1), baseEvent('session_ended', 2)]);
    assert.deepEqual(empty.toolNames, []);
    assert.deepEqual(empty.modelIds, []);
    assert.deepEqual(empty.phases, ['coding']);
  });
});

describe('trajectory rendering', () => {
  it('emits a self-contained document', () => {
    const html = renderTrajectoryHtml(projectTrajectory(fixtureEvents()));
    assert.equal(html.includes('<link'), false);
    assert.equal(html.includes('<script src'), false);
    assert.equal(html.includes('http:'), false);
    assert.equal(html.includes('https:'), false);
    assert.equal(html.includes('file://'), false);
  });

  it('escapes JSON-in-script closing sequences', () => {
    const projection = projectTrajectory(fixtureEvents());
    const html = renderTrajectoryHtml(projection);
    const dataBlock = html.match(/<script id="trajectory-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert(dataBlock);
    assert.equal(dataBlock[1].includes('<\\/script>'), true);
    assert.equal(dataBlock[1].includes('</script>'), false);
  });

  it('renders stable step and event anchor ids', () => {
    const projection = projectTrajectory(fixtureEvents());
    const html = renderTrajectoryHtml(projection);
    for (const step of projection.steps) {
      assert.match(html, new RegExp(`id="step-${escapeRegExp(step.stepId)}"`));
      assert.match(html, new RegExp(`id="event-${escapeRegExp(step.events[0].eventId)}"`));
    }
  });

  it('keeps hostile markup as escaped JSON text', () => {
    const html = renderTrajectoryHtml(projectTrajectory(fixtureEvents()));
    const dataBlock = html.match(/<script id="trajectory-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert(dataBlock);
    assert.equal(dataBlock[1].includes('<img onerror=alert(1)>'), false);
    assert.equal(dataBlock[1].includes('\\u003cimg onerror=alert(1)>'), true);
    assert.equal(html.includes('&lt;img onerror=alert(1)&gt;'), false);
    const parsed = JSON.parse(dataBlock[1].replaceAll('<\\/', '</'));
    assert.equal(JSON.stringify(parsed).includes('<img onerror=alert(1)>'), true);
  });

  it('can render a fixture generated through the CLI input path', () => {
    const events = readTrajectoryFile(FIXTURE);
    const projection = projectTrajectory(events);
    const html = renderTrajectoryHtml(projection, { title: 'Custom Trajectory' });
    assert.match(html, /Custom Trajectory/);
    assert.match(html, /trajectory-data/);
  });
});

function baseEvent(type: 'session_started' | 'session_ended', seq: number): SessionEvent {
  if (type === 'session_started') {
    return {
      type,
      eventId: `evt-empty-${seq}`,
      seq,
      timestamp: seq,
      sessionId: 'empty-session',
      traceId: 'trace-empty',
      phase: 'coding',
      schemaVersion: '1',
      initialConfigDigest: 'sha256:empty',
    };
  }
  return {
    type,
    eventId: `evt-empty-${seq}`,
    seq,
    timestamp: seq,
    sessionId: 'empty-session',
    traceId: 'trace-empty',
    phase: 'coding',
    schemaVersion: '1',
    stopReason: 'completion',
    totalTurns: 0,
    totalToolCalls: 0,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
