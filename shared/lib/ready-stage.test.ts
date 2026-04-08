import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  runReadyStage,
  type ReadyCheck,
  type ReadyResult,
  type ReadyStageConfig,
} from './ready-stage.ts';

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

  describe('runReadyStage', () => {
    it('returns valid ReadyResult shape', async () => {
      const result = await runReadyStage({
        prNumber: 42,
        repoDir: '/tmp/test',
      });

      assert.equal(typeof result.prNumber, 'number');
      assert.equal(result.prNumber, 42);
      assert.ok(['pass', 'fail', 'warn'].includes(result.verdict));
      assert.ok(Array.isArray(result.checks));
      assert.equal(typeof result.timestamp, 'string');
      assert.equal(typeof result.summary, 'string');
    });

    it('stub returns passing verdict', async () => {
      const result = await runReadyStage({
        prNumber: 123,
        repoDir: '/tmp/test',
      });

      assert.equal(result.verdict, 'pass');
      assert.equal(result.checks.length, 0);
    });

    it('timestamp is valid ISO 8601', async () => {
      const result = await runReadyStage({
        prNumber: 1,
        repoDir: '/tmp/test',
      });

      assertIso8601(result.timestamp);
    });

    it('stub preserves requested PR number in the result', async () => {
      const result = await runReadyStage({
        prNumber: 314,
        repoDir: '/tmp/test',
      });

      assert.equal(result.prNumber, 314);
    });

    it('stub returns an empty checks array for compatibility mode', async () => {
      const result = await runReadyStage({
        prNumber: 8,
        repoDir: '/tmp/test',
      });

      assert.deepEqual(result.checks, []);
      assert.equal(result.summary, 'Ready stage stub - no checks implemented yet');
    });

    it('returns a valid result for zero PR numbers in the current stub', async () => {
      const result = await runReadyStage({
        prNumber: 0,
        repoDir: '/tmp/test',
      });

      assert.equal(result.prNumber, 0);
      assert.equal(result.verdict, 'pass');
    });

    it('returns a valid result for negative PR numbers in the current stub', async () => {
      const result = await runReadyStage({
        prNumber: -1,
        repoDir: '/tmp/test',
      });

      assert.equal(result.prNumber, -1);
      assert.equal(result.verdict, 'pass');
    });

    it('returns a valid result for an empty repoDir in the current stub', async () => {
      const result = await runReadyStage({
        prNumber: 11,
        repoDir: '',
      });

      assert.equal(result.prNumber, 11);
      assert.equal(result.checks.length, 0);
    });
  });
});
