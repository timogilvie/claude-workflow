import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acknowledgeIncident, initIncidentStore, queryIncidents, recordIncident, resolveIncident } from './wavemill-incident-store.ts';
import { createIncident, computeIncidentFingerprint, type IncidentEvidence } from './wavemill-incident-model.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function evidence(type: IncidentEvidence['evidenceType']): IncidentEvidence {
  return {
    evidenceType: type,
    timestamp: '2026-08-03T12:00:00.000Z',
    path: '/tmp/repo/features/x/.planning-result.json',
    description: 'Planning failure evidence',
    value: { status: 'failed', failureReason: 'turn_limit' },
  };
}

describe('wavemill incident model', () => {
  it('computes deterministic fingerprints from stable cause fields', () => {
    const first = createIncident({
      category: 'model_task_harness_outcome',
      severity: 'high',
      confidence: 'high',
      normalizedRootCauseClass: 'native_planning_turn_limit',
      evidence: [evidence('planning_result')],
      redactedSummary: 'Planning hit a turn limit.',
      recommendedAction: 'Review task scope.',
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    const second = {
      ...first,
      id: 'incident-other',
      evidence: [{ ...evidence('planning_result'), value: { status: 'failed', failureReason: 'different values do not matter' } }],
    };
    assert.equal(computeIncidentFingerprint(first), computeIncidentFingerprint(second));
  });

  it('avoids collisions across diverse root causes', () => {
    const fingerprints = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const incident = createIncident({
        category: i % 2 === 0 ? 'model_task_harness_outcome' : 'external_transient_dependency',
        severity: 'medium',
        confidence: 'high',
        normalizedRootCauseClass: `cause_${i}`,
        evidence: [evidence(i % 2 === 0 ? 'planning_result' : 'dependency_probe')],
        redactedSummary: `summary ${i}`,
        recommendedAction: 'act',
        observedAt: '2026-08-03T12:00:00.000Z',
      });
      assert.equal(fingerprints.has(incident.fingerprint), false);
      fingerprints.add(incident.fingerprint);
    }
  });

  it('round-trips through JSON', () => {
    const incident = createIncident({
      category: 'stale_orphaned_state',
      severity: 'high',
      confidence: 'high',
      normalizedRootCauseClass: 'missing_eval_records',
      evidence: [evidence('job_state')],
      redactedSummary: 'Comparison missing eval records.',
      recommendedAction: 'Reconcile job and eval state.',
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(incident)), incident);
  });

  it('supports active to acknowledged to resolved lifecycle state transitions', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-lifecycle-'));
    try {
      await initIncidentStore(repoDir);
      const incident = createIncident({
        category: 'model_task_harness_outcome',
        severity: 'high',
        confidence: 'high',
        normalizedRootCauseClass: 'native_planning_turn_limit',
        evidence: [evidence('planning_result')],
        redactedSummary: 'Planning hit turn limit.',
        recommendedAction: 'Review task scope.',
        observedAt: '2026-08-03T12:00:00.000Z',
      });
      await recordIncident({ repoDir, now: new Date('2026-08-03T12:00:00.000Z') }, incident);
      await acknowledgeIncident({ repoDir, now: new Date('2026-08-03T12:01:00.000Z') }, incident.fingerprint);
      assert.equal((await queryIncidents({ repoDir }))[0].lifecycleState, 'acknowledged');
      await resolveIncident({ repoDir, now: new Date('2026-08-03T12:02:00.000Z') }, incident.fingerprint);
      assert.equal((await queryIncidents({ repoDir }))[0].lifecycleState, 'resolved');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
