import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExecArgvCommandResult } from './shell-utils.ts';
import {
  REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE,
  REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
  runReviewScopeGuard,
  type ReviewScopeGuardDeps,
} from './review-scope-guard.ts';

function makeDeps(outputs: Record<string, string | Error>): ReviewScopeGuardDeps {
  return {
    execArgvCommand: (_file, args): ExecArgvCommandResult => {
      const key = args.join(' ');
      const output = outputs[key];
      if (output instanceof Error) {
        return { stdout: '', stderr: output.message, exitCode: 128, failed: false };
      }
      if (output === undefined) {
        return { stdout: '', stderr: `unexpected git command: ${key}`, exitCode: 2, failed: false };
      }
      return { stdout: output, stderr: '', exitCode: 0, failed: false };
    },
    getIntegrationConfig: () => ({
      enabled: false,
      integrationBranch: 'auto/integration',
      promotionBranch: 'main',
      autoUpdatePromotionBranch: false,
      mergeMethod: 'squash',
      deleteBranchAfterMerge: true,
      haltOnRed: true,
      requiredChecks: [],
      highRiskPolicy: 'manual',
      useMillSession: true,
    }),
    loadWavemillConfig: () => ({
      integration: { integrationBranch: 'auto/integration' },
    }),
    resolveDefaultBaseRef: () => 'main',
    existsSync: () => true,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(repoDir: string, relativePath: string, contents: string, message: string): void {
  const filePath = join(repoDir, relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, contents);
  git(repoDir, `add ${shellQuote(relativePath)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    integration: { integrationBranch: 'auto/integration' },
  }));
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');
  git(repoDir, 'checkout -b auto/integration');
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

test('runReviewScopeGuard passes when every staged file is in task scope', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': 'abc123\n',
    'diff --name-only -z abc123 HEAD': 'shared/lib/observer.ts\0tools/observer.ts\0',
    'diff --cached --name-only -z': 'tools/observer.ts\0shared/lib/observer.ts\0',
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.stagedPaths, ['shared/lib/observer.ts', 'tools/observer.ts']);
  assert.deepEqual(result.outOfScopePaths, []);
});

test('runReviewScopeGuard reports unrelated staged files deterministically', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': 'abc123\n',
    'diff --name-only -z abc123 HEAD': 'tools/observer.ts\0',
    'diff --cached --name-only -z': 'shared/lib/workflow-router.ts\0tools/observer.ts\0shared/lib/config.ts\0',
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'fail');
  assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE);
  assert.deepEqual(result.outOfScopePaths, [
    'shared/lib/config.ts',
    'shared/lib/workflow-router.ts',
  ]);
});

test('runReviewScopeGuard rejects new unrelated files', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': 'abc123\n',
    'diff --name-only -z abc123 HEAD': 'tools/observer.ts\0',
    'diff --cached --name-only -z': 'tools/unrelated.ts\0',
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.outOfScopePaths, ['tools/unrelated.ts']);
});

test('runReviewScopeGuard fails closed when integration merge-base cannot be resolved', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': new Error('fatal: Not a valid object name auto/integration'),
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'error');
  assert.equal(result.message, REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE);
  assert.equal(result.toolError?.commandClass, 'git-merge-base');
  assert.match(result.toolError?.stderr || '', /Not a valid object name/);
});

test('runReviewScopeGuard allows test and registration companions only for scoped source files', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': 'abc123\n',
    'diff --name-only -z abc123 HEAD': 'shared/lib/review-scope-guard.ts\0',
    'diff --cached --name-only -z': 'shared/lib/review-scope-guard.test.ts\0tests/run-unit-tests.sh\0',
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.allowedCompanionPaths, [
    'shared/lib/review-scope-guard.test.ts',
    'tests/run-unit-tests.sh',
  ]);
});

test('runReviewScopeGuard rejects test companions when corresponding source is not scoped', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': 'abc123\n',
    'diff --name-only -z abc123 HEAD': 'tools/observer.ts\0',
    'diff --cached --name-only -z': 'shared/lib/review-scope-guard.test.ts\0tests/run-unit-tests.sh\0',
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.outOfScopePaths, [
    'shared/lib/review-scope-guard.test.ts',
    'tests/run-unit-tests.sh',
  ]);
});

test('runReviewScopeGuard fails closed on ambiguous staged paths', () => {
  const deps = makeDeps({
    'merge-base auto/integration HEAD': 'abc123\n',
    'diff --name-only -z abc123 HEAD': 'tools/observer.ts\0',
    'diff --cached --name-only -z': 'tools/../observer.ts\0',
  });

  const result = runReviewScopeGuard({ repoDir: '/repo' }, deps);

  assert.equal(result.status, 'error');
  assert.equal(result.toolError?.commandClass, 'git-path-normalization');
  assert.match(result.toolError?.stderr || '', /Ambiguous staged index path/);
});

test('runReviewScopeGuard blocks stale review overwrites of integration-only files before commit', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b task/observer-work auto/integration');
    commitFile(repoDir, 'tools/observer.ts', 'observer fix\n', 'Fix observer task file');

    git(repoDir, 'checkout auto/integration');
    commitFile(repoDir, 'shared/lib/workflow-router.ts', 'queue watchdog fix\n', 'Fix queue watchdog');

    git(repoDir, 'checkout task/observer-work');
    git(repoDir, 'merge auto/integration --no-edit');
    writeFileSync(join(repoDir, 'shared/lib/workflow-router.ts'), 'stale pre-watchdog contents\n');
    git(repoDir, 'add shared/lib/workflow-router.ts');

    const result = runReviewScopeGuard({ repoDir });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.taskPaths, ['tools/observer.ts']);
    assert.deepEqual(result.outOfScopePaths, ['shared/lib/workflow-router.ts']);

    writeFileSync(join(repoDir, 'tools/observer.ts'), 'observer fix\nreview follow-up\n');
    git(repoDir, 'reset shared/lib/workflow-router.ts');
    git(repoDir, 'add tools/observer.ts');

    const validResult = runReviewScopeGuard({ repoDir });
    assert.equal(validResult.status, 'pass');
    assert.deepEqual(validResult.stagedPaths, ['tools/observer.ts']);
  } finally {
    cleanup();
  }
});
