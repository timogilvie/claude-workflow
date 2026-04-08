import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReadyStage,
  checkSchemaMigrations,
  checkDeployPaths,
  computeVerdict,
  type ReadyResult,
  type ReadyCheck,
  type ReadyStageConfig,
} from './ready-stage.ts';
import * as shellUtils from './shell-utils.ts';

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

  describe('runReadyStage - integration', () => {
    it.skip('validates result structure with mocked shell commands', async () => {
      // Mock gh CLI commands to test the success path
      const mockExecShellCommand = mock.fn((cmd: string) => {
        if (cmd.includes('gh pr view')) {
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

      // Replace execShellCommand temporarily
      const original = shellUtils.execShellCommand;
      (shellUtils as any).execShellCommand = mockExecShellCommand;

      try {
        const result = await runReadyStage({
          prNumber: 42,
          repoDir: '/tmp/test',
        });

        // Verify structure
        assert.equal(typeof result.prNumber, 'number');
        assert.equal(result.prNumber, 42);
        assert.ok(['pass', 'fail', 'warn'].includes(result.verdict));
        assert.ok(Array.isArray(result.checks));
        assert.equal(typeof result.timestamp, 'string');
        assert.equal(typeof result.summary, 'string');
        assert.equal(result.branch, 'feature-branch');
      } finally {
        // Restore original
        (shellUtils as any).execShellCommand = original;
      }
    });
  });
});
