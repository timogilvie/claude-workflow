import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    taskId: 'HOK-1_c',
    category: 'model_task_harness_outcome',
    severity: 'high',
    confidence: 'definite',
    lifecycle: 'observed',
    rootCauseClass: 'turn_limit',
    summary: 'Planning failed with turn_limit for HOK-1_c.',
    operatorAction: 'Retry with more planning budget.',
    evidence: [{
      type: 'planning_result',
      source: '.planning-result.json',
      timestamp: '2026-08-03T12:00:00.000Z',
      redactedData: 'status=failed failureReason=turn_limit',
      key: 'turn_limit',
    }],
    metadata: {},
    ...overrides,
  });
}

function incidentEvent(timestamp: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return incident({
    evidence: [{
      type: 'planning_result',
      source: '.planning-result.json',
      timestamp,
      redactedData: 'status=failed failureReason=turn_limit',
      key: 'turn_limit',
    }],
    ...overrides,
  });
}

test('incident store deduplicates by deterministic fingerprint and counts distinct events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-store-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const first = await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    const second = await store.upsert(incidentEvent('2026-08-03T13:00:00.000Z'));

    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(second.occurrenceCount, 2);
    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-polling an unchanged event is a no-op for count and liveness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-repoll-'));
  try {
    let clock = Date.parse('2026-08-03T12:00:00.000Z');
    const store = new IncidentStore(dir, {
      escalationThreshold: 3,
      now: () => new Date((clock += 120_000)),
    });
    const first = await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    // Same terminal event re-detected on later poll cycles (e.g. an un-reaped
    // failed job in workflow-state.json) must not inflate the count.
    const repollA = await store.upsertDetailed(incidentEvent('2026-08-03T12:00:00.000Z'));
    const repollB = await store.upsertDetailed(incidentEvent('2026-08-03T12:00:00.000Z'));

    assert.equal(repollA.freshEvent, false);
    assert.equal(repollB.freshEvent, false);
    assert.equal(repollB.record.occurrenceCount, 1);
    assert.equal(repollB.record.lastObservedAt, first.lastObservedAt);
    assert.equal(repollB.record.lifecycle, 'observed');

    const evidence = await store.getEvidenceForIncident(first.fingerprint);
    assert.equal(evidence.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store escalates on distinct events at configured threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-threshold-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    await store.upsert(incidentEvent('2026-08-03T13:00:00.000Z'));
    const third = await store.upsert(incidentEvent('2026-08-03T14:00:00.000Z'));

    assert.equal(third.lifecycle, 'active');
    assert.equal(third.metadata.thresholdTriggered, true);
    assert.ok(third.metadata.escalatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store handles concurrent identical upserts as one distinct event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-concurrent-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 20 });
    await Promise.all(Array.from({ length: 10 }, () => store.upsert(incident())));

    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 1);

    const evidence = await store.getEvidenceForIncident(incidents[0].fingerprint);
    assert.equal(evidence.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store sets firstObservedAt on creation and backfills legacy records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-first-observed-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());
    assert.ok(created.firstObservedAt);
    assert.equal(created.firstObservedAt, created.createdAt);

    // Simulate a legacy record written before firstObservedAt existed.
    const indexPath = join(dir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, IncidentRecord>;
    const legacy = index[created.fingerprint] as Record<string, unknown>;
    delete legacy.firstObservedAt;
    (legacy.metadata as Record<string, unknown>).seenEventKeys = [];
    writeFileSync(indexPath, JSON.stringify(index));

    const touched = await store.upsert(incident());
    // Backfilled from the earliest trustworthy stored timestamp (evidence).
    assert.equal(touched.firstObservedAt, '2026-08-03T12:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parse errors differing only in token offset produce one record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-parse-dedup-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const shared = {
      taskId: null,
      category: 'configuration_operator_condition' as const,
      evidence: [{
        type: 'backstage_health' as const,
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=parse failure',
        key: 'queue_planner_fallback',
      }],
    };
    const first = await store.upsert(incident({
      ...shared,
      rootCauseClass: 'error_failed_to_parse_backlog_json_from_stdin_unexpected_token_h' as IncidentRecord['rootCauseClass'],
    }));
    const second = await store.upsert(incident({
      ...shared,
      rootCauseClass: 'error_failed_to_parse_backlog_json_from_stdin_unexpected_token_i' as IncidentRecord['rootCauseClass'],
      evidence: [{ ...shared.evidence[0], timestamp: '2026-08-03T13:00:00.000Z' }],
    }));

    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(second.rootCauseClass, 'local_parse_failure');
    assert.equal(second.occurrenceCount, 2);
    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolution sweep resolves records missing for N cycles and keeps fresh ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-sweep-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3, resolutionAfterCycles: 2 });
    const stale = await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    const fresh = await store.upsert(incident({
      taskId: 'HOK-2_c',
      rootCauseClass: 'orphaned_completion_marker',
      category: 'stale_orphaned_state',
      summary: 'HOK-2_c has a coding completion marker without a result artifact.',
      evidence: [{
        type: 'workflow_state',
        source: '.wavemill/workflow-state.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'stage=coding resultMissing=true',
        key: 'orphaned_coding_marker',
      }],
    }));

    const sweep1 = await store.runResolutionSweep([fresh.fingerprint]);
    assert.equal(sweep1.length, 0);
    const sweep2 = await store.runResolutionSweep([fresh.fingerprint]);
    assert.equal(sweep2.length, 1);
    assert.equal(sweep2[0].fingerprint, stale.fingerprint);
    assert.equal(sweep2[0].lifecycle, 'resolved');
    assert.equal(sweep2[0].metadata.resolution?.action, 'auto_resolved');

    const remaining = await store.getIncidents();
    assert.deepEqual(remaining.map((record) => record.fingerprint), [fresh.fingerprint]);
    assert.equal(remaining[0].metadata.missedCycles, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator resolve and archive transition lifecycle with audit metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-operator-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const created = await store.upsert(incident());

    const resolved = await store.resolve(created.fingerprint, { reason: 'fixed upstream' });
    assert.equal(resolved?.lifecycle, 'resolved');
    assert.equal(resolved?.metadata.resolution?.action, 'operator_resolved');
    assert.equal(resolved?.metadata.resolution?.reason, 'fixed upstream');

    const archived = await store.archive(created.fingerprint);
    assert.equal(archived?.lifecycle, 'archived');
    assert.equal(archived?.metadata.resolution?.action, 'operator_archived');

    assert.equal(await store.resolve('unknown-fingerprint'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archived incident that recurs reopens with recurrence metadata and can re-escalate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-recurrence-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    await store.upsert(incidentEvent('2026-08-03T12:00:00.000Z'));
    const second = await store.upsert(incidentEvent('2026-08-03T13:00:00.000Z'));
    await store.archive(second.fingerprint, { reason: 'manual backlog clear' });

    // Re-poll of an already-counted event does not reopen an archived record.
    const repoll = await store.upsertDetailed(incidentEvent('2026-08-03T13:00:00.000Z'));
    assert.equal(repoll.freshEvent, false);
    assert.equal(repoll.record.lifecycle, 'archived');

    // A genuinely new distinct event reopens it and re-escalates past threshold.
    const recurred = await store.upsert(incidentEvent('2026-08-04T09:00:00.000Z'));
    assert.equal(recurred.lifecycle, 'active');
    assert.equal(recurred.occurrenceCount, 3);
    assert.equal(recurred.metadata.recurrence?.count, 1);
    assert.equal(recurred.metadata.recurrence?.reopenedFrom, 'archived');
    assert.equal(recurred.metadata.resolution?.action, 'operator_archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store consolidates legacy fanned-out records under canonical attribution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-legacy-fanout-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const first = await store.upsert(incident({
      taskId: 'HOK-2841',
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: [{
        type: 'backstage_health',
        source: '.wavemill/queue-health.json',
        timestamp: '2026-08-03T12:00:00.000Z',
        redactedData: 'reason=timeout',
        key: 'queue_planner_fallback',
      }],
    }));
    await store.recordLinearSync(first.fingerprint, {
      linearIssueId: 'HOK-3000',
      evidenceRevision: 'old-revision',
      syncedAt: '2026-08-03T12:01:00.000Z',
    });
    await store.upsert(incident({
      taskId: 'HOK-2842',
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: first.evidence,
    }));

    const canonical = await store.upsert(incident({
      taskId: null,
      category: 'external_transient_dependency',
      rootCauseClass: 'remote_timeout',
      summary: 'Queue planner fallback is active: timeout.',
      evidence: first.evidence,
    }));
    const incidents = await store.getIncidents();
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8')) as Record<string, IncidentRecord>;

    assert.equal(incidents.length, 1);
    assert.equal(canonical.taskId, null);
    assert.equal(canonical.occurrenceCount, 3);
    assert.equal(canonical.metadata.linkedLinearId, 'HOK-3000');
    assert.deepEqual(Object.keys(index), [canonical.fingerprint]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
