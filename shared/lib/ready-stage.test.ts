import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runReadyStage,
  checkMergeConflicts,
  checkCIStatus,
  checkSchemaMigrations,
  checkMigrationChainIntegrity,
  checkForbiddenDDL,
  checkMigrationReversibility,
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

const migrationFixturesDir = path.resolve(process.cwd(), 'tests/fixtures/migrations');

function assertIso8601(timestamp: string) {
  assert.match(
    timestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'timestamp should be ISO 8601 UTC format'
  );
  assert.ok(!Number.isNaN(new Date(timestamp).getTime()));
}

async function writeRepoFiles(repoDir: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

function makePrContext(changedFiles: string[], labels: string[] = []) {
  return {
    prNumber: 42,
    diff: '',
    changedFiles,
    labels,
    branch: 'feature-branch',
    baseBranch: 'main',
    url: 'https://github.com/test/repo/pull/42',
    ciStatus: 'configured',
  };
}

async function loadMigrationFixture(name: string): Promise<string> {
  return fs.readFile(path.join(migrationFixturesDir, name), 'utf-8');
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
        name: 'manual-steps',
        status: 'skip',
        message: 'No manual steps detected',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'skip');
      assert.equal(check.name, 'manual-steps');
    });

    it('accepts pending check objects', () => {
      const check = {
        name: 'ci-status',
        status: 'pending',
        message: 'CI checks are still running',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'pending');
      assert.equal(check.name, 'ci-status');
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

    it('accepts pending results', () => {
      const result = {
        prNumber: 100,
        verdict: 'pending',
        checks: [
          {
            name: 'ci-status',
            status: 'pending',
            message: 'CI checks are still running',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'CI checks still in progress - will retry',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'pending');
      assert.equal(result.checks[0]?.status, 'pending');
    });
  });

  describe('ReadyStageConfig contract', () => {
    it('supports specific checks lists', () => {
      const config = {
        checks: ['ci-status', 'approvals', 'merge-conflicts'],
      } satisfies ReadyStageConfig;

      assert.deepEqual(config.checks, ['ci-status', 'approvals', 'merge-conflicts']);
    });

    it('supports required checks as a subset', () => {
      const config = {
        checks: ['ci-status', 'approvals', 'release-notes'],
        requiredChecks: ['ci-status', 'approvals'],
      } satisfies ReadyStageConfig;

      assert.deepEqual(config.requiredChecks, ['ci-status', 'approvals']);
    });

    it('supports backwards-compatible missing ready config', () => {
      const config = {} satisfies ReadyStageConfig;

      assert.deepEqual(config, {});
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

  describe('checkMigrationChainIntegrity', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-migrations-'));
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('passes on a valid linear chain', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'pass');
      assert.equal(result.name, 'migration-chain-integrity');
    });

    it('fails on duplicate revision IDs', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/001_duplicate.py': 'revision = "001"\ndown_revision = None\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /Duplicate migration revision IDs/);
      assert.ok(Array.isArray(result.details?.duplicateRevisions));
    });

    it('fails on dangling down_revision', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /unresolved down_revision/);
    });

    it('fails when the graph has two heads', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_a.py': 'revision = "002_a"\ndown_revision = "001"\n',
        'migrations/versions/002_b.py': 'revision = "002_b"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /exactly one head/);
      assert.equal((result.details?.heads as unknown[])?.length, 2);
    });

    it('fails when the graph has a cycle', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_a.py': 'revision = "001"\ndown_revision = "003"\n',
        'migrations/versions/002_b.py': 'revision = "002"\ndown_revision = "001"\n',
        'migrations/versions/003_c.py': 'revision = "003"\ndown_revision = "002"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /contains a cycle/);
      assert.ok(result.details?.cycle);
    });

    it('skips when the repository has no migration files', async () => {
      await writeRepoFiles(repoDir, {
        'src/app.ts': 'export const ok = true;\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'skip');
      assert.match(result.message, /No migration files/);
    });

    it('honors configured migration patterns', async () => {
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            migrationPatterns: ['db/revisions/'],
            checks: ['migration-chain-integrity'],
          },
        }),
        'db/revisions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'db/revisions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.verdict, 'pass');
        assert.equal(result.checks[0]?.name, 'migration-chain-integrity');
        assert.equal(result.checks[0]?.status, 'pass');
      } finally {
        execMock.mock.restore();
      }
    });
  });

  describe('checkForbiddenDDL', () => {
    let repoDir: string;
    const fixtureDir = path.join(process.cwd(), 'tests/fixtures/forbidden-ddl');

    async function writeFixture(relativeName: string, targetName = relativeName) {
      const content = await fs.readFile(path.join(fixtureDir, relativeName), 'utf-8');
      await writeRepoFiles(repoDir, {
        [`alembic/versions/${targetName}`]: content,
      });
    }

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forbidden-ddl-'));
      const analyzer = await fs.readFile(path.join(process.cwd(), 'shared/lib/forbidden-ddl-analyzer.py'), 'utf-8');
      await writeRepoFiles(repoDir, {
        'shared/lib/forbidden-ddl-analyzer.py': analyzer,
      });
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('skips when no migration files changed', () => {
      const spawnMock = mock.method(readyStage.readyStageDeps, 'spawnPython', () => {
        throw new Error('should not be called');
      });

      try {
        const result = checkForbiddenDDL(makePrContext(['src/app.ts']), repoDir);
        assert.equal(result.status, 'skip');
        assert.equal(result.message, 'No migration files changed');
      } finally {
        spawnMock.mock.restore();
      }
    });

    it('fails on add_column(nullable=False) without server_default', async () => {
      await writeFixture('add_column_non_nullable_no_default.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/add_column_non_nullable_no_default.py']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.match(result.message, /require changes|acknowledgment/);
    });

    it('passes on add_column(nullable=False) with server_default', async () => {
      await writeFixture('add_column_non_nullable_with_default.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/add_column_non_nullable_with_default.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('fails on destructive drops without label', async () => {
      await writeFixture('drop_column.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/drop_column.py']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.deepEqual((result.details?.labels as string[]) ?? [], []);
    });

    it('passes destructive drops when the required label is present', async () => {
      await writeFixture('drop_table.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/drop_table.py'], ['migration:destructive']),
        repoDir
      );
      assert.equal(result.status, 'pass');
      assert.equal((result.details?.acknowledgedFindings as unknown[])?.length, 1);
    });

    it('warns on alter_column(type_=...) without label', async () => {
      await writeFixture('alter_column_type.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/alter_column_type.py']),
        repoDir
      );
      assert.equal(result.status, 'warn');
      assert.match(JSON.stringify(result.details), /migration:long-running/);
    });

    it('passes alter_column(type_=...) with label acknowledgment', async () => {
      await writeFixture('alter_column_type.py', 'alter_column_type_ack.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/alter_column_type_ack.py'], ['migration:long-running']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('warns on execute update statements', async () => {
      await writeFixture('execute_update.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/execute_update.py']),
        repoDir
      );
      assert.equal(result.status, 'warn');
      assert.match(JSON.stringify(result.details), /online job/);
    });

    it('does not trigger on dangerous strings inside literals', async () => {
      await writeFixture('string_literal_false_positive.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/string_literal_false_positive.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('fails closed on syntax errors', async () => {
      await writeFixture('syntax_error.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/syntax_error.py']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.match(result.message, /could not parse/);
    });

    it('passes alter_column without type_ (no finding)', async () => {
      await writeFixture('alter_column_no_type.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/alter_column_no_type.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('passes execute with CREATE INDEX CONCURRENTLY (no execute_dml finding)', async () => {
      await writeFixture('execute_create_index.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/execute_create_index.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('honors custom migration danger labels', async () => {
      await writeFixture('drop_table.py');
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            migrationDangerLabels: {
              drop_table: 'db-risk-approved',
            },
          },
        }),
      });

      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/drop_table.py'], ['db-risk-approved']),
        repoDir
      );
      assert.equal(result.status, 'pass');
      assert.match(JSON.stringify(result.details), /db-risk-approved/);
    });
  });

  describe('checkMigrationReversibility', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-migration-reversibility-'));
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    async function writeFixture(targetName: string, fixtureName: string): Promise<void> {
      await writeRepoFiles(repoDir, {
        [`alembic/versions/${targetName}`]: await loadMigrationFixture(fixtureName),
      });
    }

    it('fails for pass-only downgrade bodies', async () => {
      await writeFixture('001_pass.py', 'downgrade_pass.py');

      const result = await checkMigrationReversibility(['alembic/versions/001_pass.py'], repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /non-functional downgrade/);
      assert.deepEqual(result.details?.invalidDowngrades, [
        {
          file: 'alembic/versions/001_pass.py',
          reason: 'downgrade body only contains pass statements',
        },
      ]);
    });

    it('fails for docstring-only downgrade bodies', async () => {
      await writeFixture('002_docstring.py', 'downgrade_docstring_only.py');

      const result = await checkMigrationReversibility(['alembic/versions/002_docstring.py'], repoDir);
      assert.equal(result.status, 'fail');
      assert.deepEqual(result.details?.invalidDowngrades, [
        {
          file: 'alembic/versions/002_docstring.py',
          reason: 'downgrade body only contains a docstring',
        },
      ]);
    });

    it('fails for docstring plus pass downgrade bodies', async () => {
      await writeFixture('003_docstring_pass.py', 'downgrade_docstring_pass.py');

      const result = await checkMigrationReversibility(['alembic/versions/003_docstring_pass.py'], repoDir);
      assert.equal(result.status, 'fail');
      assert.deepEqual(result.details?.invalidDowngrades, [
        {
          file: 'alembic/versions/003_docstring_pass.py',
          reason: 'downgrade body only contains pass statements',
        },
      ]);
    });

    it('fails for raise NotImplementedError downgrade bodies', async () => {
      await writeFixture('004_not_implemented_name.py', 'downgrade_not_implemented_name.py');
      await writeFixture('005_not_implemented_call.py', 'downgrade_not_implemented_call.py');

      const result = await checkMigrationReversibility([
        'alembic/versions/004_not_implemented_name.py',
        'alembic/versions/005_not_implemented_call.py',
      ], repoDir);

      assert.equal(result.status, 'fail');
      assert.deepEqual(result.details?.invalidDowngrades, [
        {
          file: 'alembic/versions/004_not_implemented_name.py',
          reason: 'downgrade body is non-functional (pass or NotImplementedError only)',
        },
        {
          file: 'alembic/versions/005_not_implemented_call.py',
          reason: 'downgrade body is non-functional (pass or NotImplementedError only)',
        },
      ]);
    });

    it('passes for a real downgrade body', async () => {
      await writeFixture('006_real.py', 'downgrade_real.py');

      const result = await checkMigrationReversibility(['alembic/versions/006_real.py'], repoDir);
      assert.equal(result.status, 'pass');
      assert.match(result.message, /non-trivial downgrade/);
    });

    it('converts failure to pass with the exact migration:irreversible label', async () => {
      await writeFixture('007_irreversible.py', 'downgrade_pass.py');

      const result = await checkMigrationReversibility(
        ['alembic/versions/007_irreversible.py'],
        repoDir,
        ['migration:irreversible']
      );

      assert.equal(result.status, 'pass');
      assert.match(result.message, /explicitly approved/);
      assert.equal(result.details?.overrideLabelApplied, true);
    });

    it('does not accept similarly named labels', async () => {
      await writeFixture('008_irreversible.py', 'downgrade_pass.py');

      const result = await checkMigrationReversibility(
        ['alembic/versions/008_irreversible.py'],
        repoDir,
        ['Migration:Irreversible', 'irreversible']
      );

      assert.equal(result.status, 'fail');
    });

    it('warns when upgrade drops a column even with a non-trivial downgrade', async () => {
      await writeFixture('009_drop_column.py', 'upgrade_drops_column.py');

      const result = await checkMigrationReversibility(['alembic/versions/009_drop_column.py'], repoDir);
      assert.equal(result.status, 'warn');
      assert.deepEqual(result.details?.destructiveUpgradeOps, [
        {
          file: 'alembic/versions/009_drop_column.py',
          operations: ['drop_column'],
        },
      ]);
    });

    it('warns when upgrade drops a table even with a non-trivial downgrade', async () => {
      await writeFixture('010_drop_table.py', 'upgrade_drops_table.py');

      const result = await checkMigrationReversibility(['alembic/versions/010_drop_table.py'], repoDir);
      assert.equal(result.status, 'warn');
      assert.deepEqual(result.details?.destructiveUpgradeOps, [
        {
          file: 'alembic/versions/010_drop_table.py',
          operations: ['drop_table'],
        },
      ]);
    });

    it('skips when no migration files changed', async () => {
      const result = await checkMigrationReversibility(['src/app.ts'], repoDir);
      assert.equal(result.status, 'skip');
      assert.match(result.message, /No migration files changed/);
    });

    it('skips when the changed path is not a recognizable migration', async () => {
      await writeFixture('011_not_a_migration.py', 'not_a_migration.py');

      const result = await checkMigrationReversibility(['alembic/versions/011_not_a_migration.py'], repoDir);
      assert.equal(result.status, 'skip');
      assert.match(result.message, /No recognizable migration files changed/);
    });

    it('fails mixed PRs when any migration has a bad downgrade', async () => {
      await writeFixture('012_real.py', 'downgrade_real.py');
      await writeFixture('013_bad.py', 'downgrade_pass.py');

      const result = await checkMigrationReversibility([
        'alembic/versions/012_real.py',
        'alembic/versions/013_bad.py',
      ], repoDir);

      assert.equal(result.status, 'fail');
      assert.deepEqual(result.details?.invalidDowngrades, [
        {
          file: 'alembic/versions/013_bad.py',
          reason: 'downgrade body only contains pass statements',
        },
      ]);
    });

    it('honors custom migration patterns', async () => {
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            migrationPatterns: ['db/revisions/'],
          },
        }),
        'db/revisions/014_pass.py': await loadMigrationFixture('downgrade_pass.py'),
      });

      const result = await checkMigrationReversibility(
        ['db/revisions/014_pass.py'],
        repoDir,
        [],
        ['db/revisions/']
      );

      assert.equal(result.status, 'fail');
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

    it('returns pending when checks are still running', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'pending', message: 'still running' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'pending');
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

    it('returns fail even when pending checks are present', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pending', message: 'still running' },
        { name: 'check2', status: 'fail', message: 'failed' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'fail');
    });
  });

  describe('checkCIStatus', () => {
    it('suppresses gh stderr when fetching checks', () => {
      let receivedCommand = '';
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        receivedCommand = cmd;
        return JSON.stringify([]);
      });

      try {
        checkCIStatus(42, '/tmp/test');
        assert.match(receivedCommand, /gh pr checks '?42'? --json state,name 2>\/dev\/null$/);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pending for queued checks', () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Shell and Unit Tests', state: 'QUEUED' }])
      );

      try {
        const result = checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pending');
        assert.match(result.message, /still running/);
        assert.deepEqual(result.details, {
          pendingChecks: [{ name: 'Shell and Unit Tests', state: 'QUEUED' }],
          totalChecks: 1,
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pending for in-progress checks', () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Check Lifecycle Paths', state: 'IN_PROGRESS' }])
      );

      try {
        const result = checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pending');
        assert.deepEqual(result.details, {
          pendingChecks: [{ name: 'Check Lifecycle Paths', state: 'IN_PROGRESS' }],
          totalChecks: 1,
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns fail for failed checks', () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Shell and Unit Tests', state: 'FAILURE' }])
      );

      try {
        const result = checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'fail');
        assert.match(result.message, /failing/);
        assert.deepEqual(result.details, {
          failedChecks: [{ name: 'Shell and Unit Tests', state: 'FAILURE' }],
          pendingChecks: [],
          totalChecks: 1,
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns fail when failed and queued checks are mixed', () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([
          { name: 'Shell and Unit Tests', state: 'FAILURE' },
          { name: 'Check Lifecycle Paths', state: 'QUEUED' },
        ])
      );

      try {
        const result = checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'fail');
        assert.deepEqual(result.details, {
          failedChecks: [{ name: 'Shell and Unit Tests', state: 'FAILURE' }],
          pendingChecks: [{ name: 'Check Lifecycle Paths', state: 'QUEUED' }],
          totalChecks: 2,
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pass for success and skipped checks', () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([
          { name: 'Shell and Unit Tests', state: 'SUCCESS' },
          { name: 'Lifecycle Tests', state: 'SKIPPED' },
        ])
      );

      try {
        const result = checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pass');
        assert.equal(result.message, 'All CI checks passing');
        assert.deepEqual(result.details, {
          totalChecks: 2,
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('includes the offending unknown CI state in the failure message', () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Lifecycle Tests', state: 'CANCELLED' }])
      );

      try {
        const result = checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'fail');
        assert.match(result.message, /Unknown CI state for PR #42/);
        assert.match(result.message, /Lifecycle Tests=CANCELLED/);
        assert.deepEqual(result.details, {
          failedChecks: [{ name: 'Lifecycle Tests', state: 'CANCELLED' }],
          pendingChecks: [],
          totalChecks: 1,
        });
      } finally {
        execMock.mock.restore();
      }
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
      assert.match(result.summary, /No stage results/);
    });

    it('returns unknown phase when only .plan-approved exists', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.ready, true);
    });

    it('returns unknown phase when only .coding-complete exists', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.ready, true);
    });

    it('returns unknown phase for legacy abort marker alone', async () => {
      await fs.writeFile(path.join(tmpDir, '.workflow-aborted'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.ready, true);
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

    it('reports ready pass from stage artifacts', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'completed',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: '2026-04-09T12:10:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'verdict: pass',
        artifacts: { type: 'ready', verdict: 'pass', checksRun: 4, checksPassed: 4, mergeConflict: 'CLEAN' },
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, true);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'pass');
    });

    it('reports ready fail from stage artifacts', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'completed',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: '2026-04-09T12:10:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'verdict: fail',
        artifacts: { type: 'ready', verdict: 'fail', checksRun: 4, checksPassed: 2, mergeConflict: 'CLEAN' },
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, false);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'fail');
    });

    it('reports ready remediation in progress from running stage result', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'running',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: null,
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'Conflict remediation in progress',
        artifacts: { type: 'ready', mergeConflict: 'CONFLICTED' },
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, true);
      assert.match(result.summary, /remediation in progress/);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'warn');
    });

    it('reports ready needs attention from failed stage result', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'failed',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: '2026-04-09T12:10:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'Ready checks failed',
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, false);
      assert.match(result.summary, /needs attention/);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'fail');
    });
  });

  describe('runReadyStage - integration', () => {
    it('suppresses gh stderr while gathering PR context CI metadata', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { checks: [], requiredChecks: [] } }),
        'utf-8'
      );

      const commands: string[] = [];
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        commands.push(cmd);

        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([]);
        }
        return '';
      });

      try {
        await runReadyStage({
          prNumber: 42,
          repoDir,
        });

        assert.ok(
          commands.some((cmd) => /gh pr checks '?42'? --json state 2>\/dev\/null$/.test(cmd)),
          'expected gatherPRContext to suppress gh stderr'
        );
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('includes merge conflict status independently from the readiness verdict', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { checks: [], requiredChecks: [] } }),
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
        assert.ok(['pass', 'fail', 'warn', 'pending'].includes(result.verdict));
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

    it('returns pending when CI checks are queued but nothing failed', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { checks: ['ci-status'], requiredChecks: ['ci-status'] } }),
        'utf-8'
      );

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'UNSTABLE',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'QUEUED' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({
          prNumber: 42,
          repoDir,
        });

        assert.equal(result.verdict, 'pending');
        assert.equal(result.summary, 'CI checks still in progress - will retry');
        assert.equal(result.checks[0]?.status, 'pending');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('honors the ready.checks allowlist for migration-chain-integrity', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            checks: ['ci-status'],
            requiredChecks: ['ci-status'],
          },
        }),
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.deepEqual(result.checks.map(check => check.name), ['ci-status']);
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('can run only the migration-reversibility check through the allowlist', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            checks: ['migration-reversibility'],
            requiredChecks: ['migration-reversibility'],
          },
        }),
        'alembic/versions/001_bad.py': await loadMigrationFixture('downgrade_pass.py'),
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'alembic/versions/001_bad.py' }],
            labels: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.deepEqual(result.checks.map(check => check.name), ['migration-reversibility']);
        assert.equal(result.checks[0]?.status, 'fail');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });
  });
});
