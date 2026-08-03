import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DependencyHealthDetector,
  JobFailureDetector,
  PlanningFailureDetector,
  WorkflowStateDetector,
} from './wavemill-incident-detector.ts';

const now = new Date('2026-08-03T12:00:00.000Z');

test('planning detector classifies turn_limit as model/task/harness outcome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-planning-'));
  try {
    writeFileSync(join(dir, '.planning-result.json'), JSON.stringify({
      status: 'failed',
      failureReason: 'turn_limit',
      agent: 'codex',
      model: 'gpt-5',
      finishedAt: now.toISOString(),
    }));

    const incidents = new PlanningFailureDetector().detect(dir, 'HOK-1234_c', { repoDir: dir, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'model_task_harness_outcome');
    assert.equal(incidents[0].rootCauseClass, 'turn_limit');
    assert.equal(incidents[0].confidence, 'definite');
    assert.match(incidents[0].evidence[0].redactedData, /planner=codex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow detector reports orphaned completion marker without result', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-workflow-'));
  const feature = join(repo, 'features', 'example');
  try {
    mkdirSync(feature, { recursive: true });
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(feature, '.coding-complete'), '');
    writeFileSync(join(repo, '.wavemill', 'workflow-state.json'), JSON.stringify({
      tasks: { 'HOK-1_c': { phase: 'coding' } },
    }));

    const incidents = new WorkflowStateDetector().detect(feature, 'HOK-1_c', { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'stale_orphaned_state');
    assert.equal(incidents[0].rootCauseClass, 'orphaned_completion_marker');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector distinguishes missing eval records for failed comparison', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'jobs', 'comparison.json'), JSON.stringify({
      id: 'comparison-HOK-1_c-123',
      kind: 'comparison',
      status: 'failed',
      issueId: 'HOK-1_c',
      reason: 'missing eval records',
      finishedAt: now.toISOString(),
    }));

    const incidents = new JobFailureDetector().detect(repo, 'HOK-1_c', { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'stale_orphaned_state');
    assert.equal(incidents[0].rootCauseClass, 'missing_eval_records_for_comparison');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('dependency detector preserves structured queue fallback reason', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'dependency_planning_failed',
      failureCount: 3,
      diagnostics: { structuredReason: 'github_ssh_probe_failed' },
      lastAttemptAt: now.toISOString(),
    }));

    const incidents = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detect(repo, 'HOK-1_c', { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'external_transient_dependency');
    assert.equal(incidents[0].severity, 'medium');
    assert.match(incidents[0].evidence[0].redactedData, /github_ssh_probe_failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
