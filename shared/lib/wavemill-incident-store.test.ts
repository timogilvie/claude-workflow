import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createIncident, type WavemillIncident } from './wavemill-incident-model.ts';
import { queryIncidents, recordIncident } from './wavemill-incident-store.ts';

function makeIncident(summary = 'Planning hit turn limit.'): WavemillIncident {
  return createIncident({
    category: 'model_task_harness_outcome',
    severity: 'high',
    confidence: 'high',
    normalizedRootCauseClass: 'native_planning_turn_limit',
    evidence: [{
      evidenceType: 'planning_result',
      timestamp: '2026-08-03T12:00:00.000Z',
      path: '/tmp/repo/features/x/.planning-result.json',
      description: summary,
      value: { status: 'failed', failureReason: 'turn_limit' },
    }],
    redactedSummary: summary,
    recommendedAction: 'Review task scope.',
    observedAt: '2026-08-03T12:00:00.000Z',
  });
}

describe('wavemill incident store', () => {
  it('deduplicates repeated observations by fingerprint and appends evidence', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-store-dedupe-'));
    try {
      const first = await recordIncident({ repoDir, now: new Date('2026-08-03T12:00:00.000Z') }, makeIncident());
      const second = await recordIncident({ repoDir, now: new Date('2026-08-03T12:05:00.000Z') }, makeIncident('Second observation'));
      const incidents = await queryIncidents({ repoDir });
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].occurrenceCount, 2);
      assert.equal(first.incident.fingerprint, second.incident.fingerprint);
      const evidenceLog = readFileSync(join(repoDir, '.wavemill', 'incidents', 'evidence.jsonl'), 'utf-8').trim().split('\n');
      assert.equal(evidenceLog.length, 2);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent recordIncident calls without corrupting state', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-store-concurrent-'));
    try {
      await Promise.all(Array.from({ length: 10 }, (_value, index) =>
        recordIncident({ repoDir, now: new Date(`2026-08-03T12:${String(index).padStart(2, '0')}:00.000Z`) }, makeIncident(`Observation ${index}`))
      ));
      const incidents = await queryIncidents({ repoDir });
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].occurrenceCount, 10);
      assert.equal(incidents[0].escalated, true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('honors cooldown by suppressing occurrence and evidence append', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-store-cooldown-'));
    try {
      await recordIncident({
        repoDir,
        thresholds: { cooldownMinutes: 30 },
        now: new Date('2026-08-03T12:00:00.000Z'),
      }, makeIncident());
      const second = await recordIncident({
        repoDir,
        thresholds: { cooldownMinutes: 30 },
        now: new Date('2026-08-03T12:05:00.000Z'),
      }, makeIncident('Suppressed'));
      const incidents = await queryIncidents({ repoDir });
      assert.equal(second.suppressedByCooldown, true);
      assert.equal(incidents[0].occurrenceCount, 1);
      assert.equal(readFileSync(join(repoDir, '.wavemill', 'incidents', 'evidence.jsonl'), 'utf-8').trim().split('\n').length, 1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('recovers from malformed incident-state.json and creates missing evidence log', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-store-malformed-'));
    try {
      const incidentDir = join(repoDir, '.wavemill', 'incidents');
      mkdirSync(incidentDir, { recursive: true });
      writeFileSync(join(incidentDir, 'incident-state.json'), '{bad', { flag: 'w' });
      await recordIncident({ repoDir }, makeIncident());
      assert.equal((await queryIncidents({ repoDir })).length, 1);
      assert.equal(existsSync(join(incidentDir, 'evidence.jsonl')), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
