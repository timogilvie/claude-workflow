import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { incidentStoreFor, runIncidentsCommand } from './incidents.ts';
import { createIncidentDraft, type IncidentRecord } from '../shared/lib/wavemill-incident-model.ts';

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

const baseArgs = { 'repo-dir': undefined, reason: undefined, all: undefined, json: undefined };

test('incidents CLI resolves and archives records by fingerprint', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'incidents-cli-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    const store = incidentStoreFor(repo);
    const created = await store.upsert(incident());

    await runIncidentsCommand({ ...baseArgs, 'repo-dir': repo, reason: 'fixed by HOK-1' }, ['resolve', created.fingerprint]);
    assert.equal((await store.getIncident(created.fingerprint))?.lifecycle, 'resolved');

    await runIncidentsCommand({ ...baseArgs, 'repo-dir': repo }, ['archive', created.fingerprint]);
    const archived = await store.getIncident(created.fingerprint);
    assert.equal(archived?.lifecycle, 'archived');
    assert.equal(archived?.metadata.resolution?.action, 'operator_archived');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('incidents CLI rejects unknown actions and missing fingerprints', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'incidents-cli-invalid-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    await assert.rejects(
      () => runIncidentsCommand({ ...baseArgs, 'repo-dir': repo }, ['destroy']),
      /unknown action 'destroy'/,
    );
    await assert.rejects(
      () => runIncidentsCommand({ ...baseArgs, 'repo-dir': repo }, ['resolve']),
      /requires an incident fingerprint/,
    );
    await assert.rejects(
      () => runIncidentsCommand({ ...baseArgs, 'repo-dir': repo }, ['resolve', 'no-such-fingerprint']),
      /no incident found/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
