import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runReadyStage,
  checkMergeConflicts,
  checkSchemaMigrations,
  checkDeployPaths,
  computeVerdict,
  checkLegacyMarkers,
  controllerCheckReadiness,
  type ReadyResult,
  type ReadyCheck,
  type LegacyMarkerResult,
  type ControllerReadinessResult,
  type ReadyStageConfig,
} from './ready-stage.ts';
import * as readyStage from './ready-stage.ts';

function assertIso8601(timestamp: string) {
  assert.match(
    timestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'timestamp should be ISO 8601 UTC format'
  );
  assert.ok(!Number.isNaN(new Date(timestamp).getTime()));
}

describe('ready-stage', () => {
  describe('ReadyCheck contract', () => {
    it('accepts passing check objects', () => {
      const check = {
        name: 'ci-status',
        status: 'pass',
        message: 'All required checks passed',
      } satisfies ReadyCheck;

      assert.deepEqual(check, {
        name: 'ci-status',
        status: 'pass',
        message: 'All required checks passed',
      });
    });

    it('accepts failing check objects with details', () => {
      const check = {
        name: 'merge-conflicts',
        status: 'fail',
        message: 'PR has merge conflicts with main',
        details: {
          state: 'conflicted',
          conflictedFiles: ['src/app.ts'],
        },
      } satisfies ReadyCheck;

      assert.equal(check.status, 'fail');
      assert.deepEqual(check.details, {
        state: 'conflicted',
        conflictedFiles: ['src/app.ts'],
      });
    });

    it('accepts warning check objects', () => {
      const check = {
        name: 'release-notes',
        status: 'warn',
        message: 'Manual release notes update required',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'warn');
      assert.equal(check.message, 'Manual release notes update required');
    });

    it('accepts skipped check objects', () => {
      const check = {
        name: 'compatibility-mode',
        status: 'skip',
        message: 'Ready stage is disabled for this repository',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'skip');
      assert.equal(check.name, 'compatibility-mode');
    });
  });

  describe('ReadyResult contract', () => {
    it('accepts passing results with multiple checks', () => {
      const result = {
        prNumber: 42,
        verdict: 'pass',
        checks: [
          {
            name: 'ci-status',
            status: 'pass',
            message: 'All required checks passed',
          },
          {
            name: 'approvals',
            status: 'pass',
            message: 'Required approvals are present',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'PR is ready to merge',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'pass');
      assert.equal(result.prNumber, 42);
      assert.equal(result.checks.length, 2);
      assertIso8601(result.timestamp);
    });

    it('accepts failing results', () => {
      const result = {
        prNumber: 77,
        verdict: 'fail',
        checks: [
          {
            name: 'merge-conflicts',
            status: 'fail',
            message: 'PR has merge conflicts',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'Merge is blocked until conflicts are resolved',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'fail');
      assert.equal(result.checks[0]?.status, 'fail');
    });

    it('accepts warning results', () => {
      const result = {
        prNumber: 99,
        verdict: 'warn',
        checks: [
          {
            name: 'manual-steps',
            status: 'warn',
            message: 'Post-merge release checklist still required',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'Ready with manual follow-up',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'warn');
      assert.equal(result.summary, 'Ready with manual follow-up');
    });
  });

  describe('ReadyStageConfig contract', () => {
    it('supports explicit enablement', () => {
      const config = {
        enabled: true,
      } satisfies ReadyStageConfig;

      assert.equal(config.enabled, true);
    });

    it('supports explicit disablement', () => {
      const config = {
        enabled: false,
      } satisfies ReadyStageConfig;

      assert.equal(config.enabled, false);
    });

    it('supports specific checks lists', () => {
      const config = {
        enabled: true,
        checks: ['ci-status', 'approvals', 'merge-conflicts'],
      } satisfies ReadyStageConfig;

      assert.deepEqual(config.checks, ['ci-status', 'approvals', 'merge-conflicts']);
    });

    it('supports required checks as a subset', () => {
      const config = {
        enabled: true,
        checks: ['ci-status', 'approvals', 'release-notes'],
        requiredChecks: ['ci-status', 'approvals'],
      } satisfies ReadyStageConfig;

      assert.deepEqual(config.requiredChecks, ['ci-status', 'approvals']);
    });

    it('supports backwards-compatible missing ready config', () => {
      const config = {} satisfies ReadyStageConfig;

      assert.deepEqual(config, {});
      assert.equal(config.enabled, undefined);
    });
  });

  describe('checkSchemaMigrations', () => {
    it('returns skip when no schema files changed', () => {
      const result = checkSchemaMigrations(['src/app.ts', 'README.md'], '/tmp/test');
      assert.equal(result.status, 'skip');
      assert.equal(result.name, 'schema-migrations');
      assert.match(result.message, /No schema changes/);
    });

    it('returns fail when schema changed without migration', () => {
      const result = checkSchemaMigrations(['prisma/schema.prisma', 'src/app.ts'], '/tmp/test');
      assert.equal(result.status, 'fail');
      assert.equal(result.name, 'schema-migrations');
      assert.match(result.message, /without migration/);
      assert.ok(result.details?.schemaFiles);
    });

    it('returns pass when both schema and migration changed', () => {
      const result = checkSchemaMigrations(
        ['prisma/schema.prisma', 'prisma/migrations/001_init.sql', 'src/app.ts'],
        '/tmp/test'
      );
      assert.equal(result.status, 'pass');
      assert.equal(result.name, 'schema-migrations');
      assert.match(result.message, /corresponding migrations/);
    });

    it('detects Django models.py as schema file', () => {
      const result = checkSchemaMigrations(['app/models.py'], '/tmp/test');
      assert.equal(result.status, 'fail');
    });

    it('detects alembic migrations', () => {
      const result = checkSchemaMigrations(
        ['app/models.py', 'alembic/versions/001_init.py'],
        '/tmp/test'
      );
      assert.equal(result.status, 'pass');
    });
  });

  describe('checkDeployPaths', () => {
    it('always returns skip for v1', () => {
      const result = checkDeployPaths(['src/app.ts'], {});
      assert.equal(result.status, 'skip');
      assert.equal(result.name, 'deploy-paths');
      assert.match(result.message, /not configured/);
    });
  });

  describe('computeVerdict', () => {
    it('returns pass for empty checks array', () => {
      const result = computeVerdict([]);
      assert.equal(result, 'pass');
    });

    it('returns pass when all checks pass', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'pass', message: 'ok' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'pass');
    });

    it('returns pass when checks are skipped', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'skip', message: 'skipped' },
        { name: 'check2', status: 'pass', message: 'ok' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'pass');
    });

    it('returns warn when any check warns', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'warn', message: 'warning' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'warn');
    });

    it('returns fail when any check fails', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'fail', message: 'failed' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'fail');
    });

    it('returns fail even with warnings when one fails', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'warn', message: 'warning' },
        { name: 'check2', status: 'fail', message: 'failed' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'fail');
    });
  });

  describe('checkMergeConflicts', () => {
    it('returns CLEAN when GitHub reports a mergeable PR', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
      );

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'CLEAN');
        assert.equal(result.attempts, 1);
        assert.equal(result.mergeStateStatus, 'CLEAN');
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns CONFLICTED when GitHub reports a dirty merge state', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
      );

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'CONFLICTED');
        assert.equal(result.attempts, 1);
        assert.equal(result.mergeable, 'CONFLICTING');
      } finally {
        execMock.mock.restore();
      }
    });

    it('retries UNKNOWN status and returns UNKNOWN after the final attempt', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
      );
      const sleepMock = mock.method(readyStage.readyStageDeps, 'sleep', async () => undefined);

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'UNKNOWN');
        assert.equal(result.attempts, 3);
        assert.equal(execMock.mock.callCount(), 3);
        assert.equal(sleepMock.mock.callCount(), 2);
      } finally {
        execMock.mock.restore();
        sleepMock.mock.restore();
      }
    });

    it('returns ERROR when the gh command fails', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () => {
        throw new Error('gh failed');
      });

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'ERROR');
        assert.match(result.error ?? '', /gh failed/);
      } finally {
        execMock.mock.restore();
      }
    });
  });

  describe('checkLegacyMarkers', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty checks when no markers present', async () => {
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 0);
      assert.equal(result.markers.length, 3);
      assert.ok(result.markers.every(m => !m.present));
    });

    it('detects .plan-approved marker', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, 'legacy-plan-approved');
      assert.equal(result.checks[0].status, 'pass');
    });

    it('detects .coding-complete marker', async () => {
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, 'legacy-coding-complete');
      assert.equal(result.checks[0].status, 'pass');
    });

    it('detects .workflow-aborted marker as fail', async () => {
      await fs.writeFile(path.join(tmpDir, '.workflow-aborted'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, 'legacy-workflow-aborted');
      assert.equal(result.checks[0].status, 'fail');
    });

    it('detects multiple markers simultaneously', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 2);
      const names = result.checks.map(c => c.name);
      assert.ok(names.includes('legacy-plan-approved'));
      assert.ok(names.includes('legacy-coding-complete'));
    });
  });

  describe('controllerCheckReadiness', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns not ready when feature directory does not exist', async () => {
      const result = await controllerCheckReadiness('/nonexistent/path');
      assert.equal(result.ready, false);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.checks[0].status, 'fail');
      assert.match(result.checks[0].message, /does not exist/);
    });

    it('returns unknown phase for empty feature directory', async () => {
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.ready, true);
      assert.equal(result.phase, 'unknown');
      assert.match(result.summary, /No phase markers/);
    });

    it('detects coding phase when .plan-approved exists', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'coding');
      assert.equal(result.ready, true);
    });

    it('detects review phase when .coding-complete exists', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'review');
      assert.equal(result.ready, true);
    });

    it('detects aborted phase and marks not ready', async () => {
      await fs.writeFile(path.join(tmpDir, '.workflow-aborted'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'aborted');
      assert.equal(result.ready, false);
    });

    it('reports task packet presence', async () => {
      await fs.writeFile(path.join(tmpDir, 'task-packet.md'), '# Task');
      const result = await controllerCheckReadiness(tmpDir);
      const taskCheck = result.checks.find(c => c.name === 'task-packet');
      assert.ok(taskCheck);
      assert.equal(taskCheck.status, 'pass');
    });

    it('warns on missing task packet', async () => {
      const result = await controllerCheckReadiness(tmpDir);
      const taskCheck = result.checks.find(c => c.name === 'task-packet');
      assert.ok(taskCheck);
      assert.equal(taskCheck.status, 'warn');
    });

    it('reports plan presence', async () => {
      await fs.writeFile(path.join(tmpDir, 'plan.md'), '# Plan');
      const result = await controllerCheckReadiness(tmpDir);
      const planCheck = result.checks.find(c => c.name === 'plan');
      assert.ok(planCheck);
      assert.equal(planCheck.status, 'pass');
    });

    it('includes correct featureDir and timestamp in result', async () => {
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.featureDir, tmpDir);
      assert.ok(result.timestamp);
      // Verify ISO 8601 format
      assert.ok(!isNaN(Date.parse(result.timestamp)));
    });
  });

  describe('runReadyStage - integration', () => {
    it('includes merge conflict status independently from the readiness verdict', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { enabled: true } }),
        'utf-8'
      );

      // Mock gh CLI commands to test the success path
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'CONFLICTING',
              mergeStateStatus: 'DIRTY',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [
              { path: 'src/app.ts' },
              { path: 'README.md' }
            ]
          });
        }
        if (cmd.includes('gh pr diff')) {
          return 'diff --git a/src/app.ts b/src/app.ts\n+new code';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({
          prNumber: 42,
          repoDir,
        });

        // Verify structure
        assert.equal(typeof result.prNumber, 'number');
        assert.equal(result.prNumber, 42);
        assert.ok(['pass', 'fail', 'warn'].includes(result.verdict));
        assert.ok(Array.isArray(result.checks));
        assert.equal(typeof result.timestamp, 'string');
        assert.equal(typeof result.summary, 'string');
        assert.equal(result.branch, 'feature-branch');
        assert.equal(result.verdict, 'warn');
        assert.equal(result.mergeConflict?.status, 'CONFLICTED');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });
  });
});
