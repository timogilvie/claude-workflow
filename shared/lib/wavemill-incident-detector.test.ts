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
import { canonicalizeRootCauseClass, INCIDENT_ROOT_CAUSE_CLASSES } from './wavemill-incident-model.ts';

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

test('job detector attributes comparison failures from job subject instead of active task', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-subject-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'jobs', 'comparison.json'), JSON.stringify({
      id: 'comparison-HOK-2607-1046-1048',
      kind: 'comparison',
      status: 'failed',
      issueId: 'HOK-2841',
      reason: 'missing eval records',
      finishedAt: now.toISOString(),
    }));

    const activeTaskIncidents = new JobFailureDetector().detect(repo, 'HOK-2841', { repoDir: repo, now });
    const repoIncidents = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    assert.equal(activeTaskIncidents.length, 0);
    assert.equal(repoIncidents.length, 1);
    assert.equal(repoIncidents[0].taskId, 'HOK-2607');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('root cause canonicalization is bounded and merges same-class parse errors', () => {
  const offsetA = canonicalizeRootCauseClass('error_failed_to_parse_backlog_json_from_stdin_unexpected_token_h_this_is_loa_is_');
  const offsetB = canonicalizeRootCauseClass('error_failed_to_parse_backlog_json_from_stdin_unexpected_token_i_in_tools_is_not');
  assert.equal(offsetA, 'local_parse_failure');
  assert.equal(offsetA, offsetB);

  // Typed native completion-protocol reasons (HOK-2933) route local, not remote.
  assert.equal(canonicalizeRootCauseClass('native-completion-protocol'), 'native_completion_protocol_failure');
  assert.equal(canonicalizeRootCauseClass('native_coding_completed_without_coding_complete_or_coding_blocked_completion_jso'), 'native_completion_protocol_failure');
  assert.equal(canonicalizeRootCauseClass('blocked_completion_auto_advance_refused_because_a_live_blocking_command_is_still'), 'harness_liveness_deadlock');
  assert.equal(canonicalizeRootCauseClass('github ssh probe failed'), 'remote_ssh_failure');
  assert.equal(canonicalizeRootCauseClass('some brand new failure text'), 'unclassified_local_failure');

  const classes = new Set<string>(INCIDENT_ROOT_CAUSE_CLASSES);
  for (const raw of ['turn_limit', 'orphaned_completion_marker', 'gibberish %% error', 'timed out talking upstream']) {
    assert.ok(classes.has(canonicalizeRootCauseClass(raw)));
  }
});

test('queue detector routes local parse failures to configuration, not external dependency', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-local-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'dependency_planning_failed',
      failureCount: 3,
      diagnostics: { structuredReason: 'error failed to parse backlog JSON from stdin unexpected token h' },
      lastAttemptAt: now.toISOString(),
    }));

    const incidents = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'configuration_operator_condition');
    assert.equal(incidents[0].rootCauseClass, 'local_parse_failure');
    assert.doesNotMatch(incidents[0].summary, /remote/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('queue detector falls back to bounded queue_planner_degraded class for unknown diagnostics', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-unknown-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'dependency_planning_failed',
      failureCount: 1,
      diagnostics: { structuredReason: 'some novel failure text nobody classified' },
      lastAttemptAt: now.toISOString(),
    }));

    const incidents = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'queue_planner_degraded');
    assert.equal(incidents[0].category, 'configuration_operator_condition');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector keeps a stable terminal event timestamp for un-reaped failures', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-stable-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'workflow-state.json'), JSON.stringify({
      jobs: [{
        id: 'eval-HOK-2893-primary-1265',
        kind: 'eval',
        status: 'failed',
        issueId: 'HOK-2893',
        finishedAt: '2026-08-27T23:58:01.000Z',
        reason: 'exit 1',
      }],
    }));

    const first = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    const later = new JobFailureDetector().detect(repo, null, { repoDir: repo, now: new Date(now.getTime() + 120_000) });
    assert.equal(first.length, 1);
    // Evidence identity is the terminal event time, so repeated polls of the
    // same dead job describe the same source event.
    assert.equal(first[0].evidence[0].timestamp, '2026-08-27T23:58:01.000Z');
    assert.equal(later[0].evidence[0].timestamp, first[0].evidence[0].timestamp);
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
    assert.equal(incidents[0].taskId, null);
    assert.equal(incidents[0].category, 'external_transient_dependency');
    assert.equal(incidents[0].severity, 'medium');
    assert.match(incidents[0].evidence[0].redactedData, /github_ssh_probe_failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
