import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { detectIncidents } from './wavemill-incident-detector.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('wavemill incident detector', () => {
  it('detects planning-result turn_limit failures', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-detector-planning-'));
    try {
      const featureDir = join(repoDir, 'features', 'detect-failure');
      mkdirSync(featureDir, { recursive: true });
      writeJson(join(repoDir, '.wavemill', 'workflow-state.json'), {
        tasks: {
          'HOK-1': { slug: 'detect-failure', worktree: repoDir, phase: 'planning', status: 'running', agent: 'codex' },
        },
      });
      writeJson(join(featureDir, '.planning-result.json'), {
        stage: 'planning',
        status: 'failed',
        startedAt: '2026-08-03T12:00:00.000Z',
        finishedAt: '2026-08-03T12:05:00.000Z',
        agent: 'codex',
        model: 'gpt-5',
        notes: '',
        failureReason: 'turn_limit',
        artifacts: {
          type: 'planning',
          planArtifactValid: false,
          bounds: { maxTurns: 5 },
          usage: { turnsCompleted: 5 },
        },
      });
      const incidents = await detectIncidents({ repoDir, skipDependencyProbes: true, now: new Date('2026-08-03T12:06:00.000Z') });
      const incident = incidents.find((item) => item.normalizedRootCauseClass === 'native_planning_turn_limit');
      assert.ok(incident);
      assert.equal(incident.issue, 'HOK-1');
      assert.equal(incident.evidence[0].evidenceType, 'planning_result');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('detects queue-health dependency fallback with structured diagnostic reason', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-detector-dependency-'));
    try {
      writeJson(join(repoDir, '.wavemill', 'workflow-state.json'), { tasks: {} });
      writeJson(join(repoDir, '.wavemill', 'queue-health.json'), {
        status: 'degraded',
        degradationReason: 'dependency_planning_failed',
        failureCount: 3,
        diagnostics: {
          structuredReason: 'git ls-remote ssh failure',
          stderrExcerpt: 'git@github.com: Permission denied (publickey).',
        },
      });
      const incidents = await detectIncidents({ repoDir, now: new Date('2026-08-03T12:00:00.000Z') });
      const incident = incidents.find((item) => item.normalizedRootCauseClass === 'dependency_git_ssh');
      assert.ok(incident);
      assert.equal(incident.escalated, true);
      assert.match(incident.redactedSummary, /Repeated dependency probe failures/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('detects failed comparison jobs caused by missing eval records', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-detector-job-'));
    try {
      const resultPath = join(repoDir, '.wavemill', 'jobs', 'comparison.result.json');
      writeJson(resultPath, { ok: false, exitCode: 1, reason: 'Missing eval records for challenge pair pair-1' });
      writeJson(join(repoDir, '.wavemill', 'workflow-state.json'), {
        tasks: {},
        jobs: {
          'comparison-pair-1': {
            id: 'comparison-pair-1',
            kind: 'comparison',
            pairId: 'pair-1',
            prNumbers: [101, 102],
            pid: 0,
            startedAt: '2026-08-03T11:00:00.000Z',
            timeoutSeconds: 60,
            logPath: join(repoDir, '.wavemill', 'jobs', 'comparison.log'),
            resultPath,
            status: 'failed',
            exitCode: 1,
            finishedAt: '2026-08-03T11:01:00.000Z',
            reason: 'Missing eval records for challenge pair pair-1',
            excerpt: null,
            settled: false,
          },
        },
      });
      const incidents = await detectIncidents({ repoDir, skipDependencyProbes: true, now: new Date('2026-08-03T12:00:00.000Z') });
      const incident = incidents.find((item) => item.normalizedRootCauseClass === 'missing_eval_records');
      assert.ok(incident);
      assert.equal(incident.category, 'stale_orphaned_state');
      assert.equal(incident.evidence.some((item) => item.evidenceType === 'job_result'), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('turns malformed artifacts into coverage incidents instead of throwing', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'incident-detector-malformed-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), '{bad', 'utf-8');
      const incidents = await detectIncidents({ repoDir, skipDependencyProbes: true });
      assert.equal(incidents.some((item) => item.normalizedRootCauseClass === 'artifact_coverage_gap'), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
