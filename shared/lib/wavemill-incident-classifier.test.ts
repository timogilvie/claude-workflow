import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDependencyFailure, classifyPlanningFailure, classifyStaleOrphaned } from './wavemill-incident-classifier.ts';
import type { StageResult } from './stage-result.ts';

function planningResult(failureReason: string): StageResult {
  return {
    stage: 'planning',
    status: 'failed',
    startedAt: '2026-08-03T12:00:00.000Z',
    finishedAt: '2026-08-03T12:10:00.000Z',
    agent: 'codex',
    model: 'gpt-5',
    notes: '',
    failureReason,
    artifacts: {
      type: 'planning',
      planArtifactValid: false,
      bounds: { maxTurns: 5 },
      usage: { turnsCompleted: 5 },
    },
  };
}

describe('wavemill incident classifier', () => {
  it('classifies native planning turn_limit as model/task/harness outcome', () => {
    const incident = classifyPlanningFailure(planningResult('turn_limit'), '/tmp/feature', { observedAt: '2026-08-03T12:11:00.000Z' });
    assert.ok(incident);
    assert.equal(incident.category, 'model_task_harness_outcome');
    assert.equal(incident.severity, 'high');
    assert.equal(incident.confidence, 'high');
    assert.equal(incident.normalizedRootCauseClass, 'native_planning_turn_limit');
    assert.match(incident.redactedSummary, /turns=5\/5/);
  });

  it('classifies tool stagnation at medium severity', () => {
    const incident = classifyPlanningFailure(planningResult('tool_stagnation'), '/tmp/feature');
    assert.equal(incident?.severity, 'medium');
    assert.equal(incident?.confidence, 'medium');
  });

  it('classifies provider errors as external dependency failures', () => {
    const incident = classifyPlanningFailure(planningResult('provider_error'), '/tmp/feature');
    assert.equal(incident?.category, 'external_transient_dependency');
    assert.equal(incident?.severity, 'high');
  });

  it('classifies aborted planning as configuration/operator condition', () => {
    const incident = classifyPlanningFailure(planningResult('aborted'), '/tmp/feature');
    assert.equal(incident?.category, 'configuration_operator');
  });

  it('redacts credentials in dependency summaries and escalates repeated failures', () => {
    const incident = classifyDependencyFailure({
      failureKind: 'git_ssh',
      failureCount: 3,
      timeWindowMinutes: 60,
      errorSummary: 'git ls-remote failed OPENAI_API_KEY=sk-secret',
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    assert.ok(incident);
    assert.equal(incident.severity, 'high');
    assert.equal(incident.escalated, true);
    assert.doesNotMatch(incident.redactedSummary, /sk-secret/);
  });

  it('records a single dependency failure as non-escalated low severity', () => {
    const incident = classifyDependencyFailure({
      failureKind: 'git_ssh',
      failureCount: 1,
      timeWindowMinutes: 60,
      observedAt: '2026-08-03T12:00:00.000Z',
    });
    assert.equal(incident?.severity, 'low');
    assert.equal(incident?.escalated, false);
  });

  it('classifies missing eval records as stale/orphaned state', () => {
    const incident = classifyStaleOrphaned('missing_eval_records', [{
      evidenceType: 'job_state',
      timestamp: '2026-08-03T12:00:00.000Z',
      path: '/tmp/repo/.wavemill/workflow-state.json',
      description: 'Comparison failed without eval records',
    }]);
    assert.equal(incident?.category, 'stale_orphaned_state');
    assert.equal(incident?.severity, 'high');
    assert.equal(incident?.confidence, 'high');
  });
});
