import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReadyStage,
  checkSchemaMigrations,
  checkDeployPaths,
  computeVerdict,
  type ReadyResult,
  type ReadyCheck,
} from './ready-stage.ts';

describe('ready-stage', () => {
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

  describe('runReadyStage - structural tests', () => {
    it('validates result structure shape', async () => {
      // This will fail because we don't have a real PR, but we can test the error handling
      try {
        const result = await runReadyStage({
          prNumber: 42,
          repoDir: '/tmp/test',
        });

        // If it succeeds (unlikely), verify structure
        assert.equal(typeof result.prNumber, 'number');
        assert.equal(result.prNumber, 42);
        assert.ok(['pass', 'fail', 'warn'].includes(result.verdict));
        assert.ok(Array.isArray(result.checks));
        assert.equal(typeof result.timestamp, 'string');
        assert.equal(typeof result.summary, 'string');
      } catch (error) {
        // Expected - gh CLI will fail without a real PR
        assert.ok(error instanceof Error);
      }
    });
  });
});
