import { mkdtempSync, rmSync } from 'node:fs';
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

test('incident store deduplicates by deterministic fingerprint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-store-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const first = await store.upsert(incident());
    const second = await store.upsert(incident());

    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(second.occurrenceCount, 2);
    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store escalates observed incident at configured threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-threshold-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    await store.upsert(incident());
    await store.upsert(incident());
    const third = await store.upsert(incident());

    assert.equal(third.lifecycle, 'active');
    assert.equal(third.metadata.thresholdTriggered, true);
    assert.ok(third.metadata.escalatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store handles concurrent upserts without duplicate records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-concurrent-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 20 });
    await Promise.all(Array.from({ length: 10 }, () => store.upsert(incident())));

    const incidents = await store.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 10);

    const evidence = await store.getEvidenceForIncident(incidents[0].fingerprint);
    assert.equal(evidence.length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident store updates metadata without counting a new observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-metadata-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const first = await store.upsert(incident());

    const updated = await store.updateMetadata(first.fingerprint, (stored) => ({
      ...stored.metadata,
      linearIssueId: 'issue-1',
      linearEvidenceRevision: 1,
    }));

    assert.equal(updated?.metadata.linearIssueId, 'issue-1');
    const incidents = await store.getIncidents();
    assert.equal(incidents[0].occurrenceCount, 1);
    assert.equal(incidents[0].metadata.linearEvidenceRevision, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
