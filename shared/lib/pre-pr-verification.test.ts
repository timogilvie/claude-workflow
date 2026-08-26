/**
 * Tests for pre-PR verification engine.
 * Covers: recipe execution, artifact writes, log capture, error handling.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runVerificationRecipe,
  writeVerificationArtifact,
  readAndValidateArtifact,
  extractBoundedLogExcerpt,
  getRemediationGuidance,
  fetchAndResolveBase,
  runPrePrSafetyGuard,
} from './pre-pr-verification.ts';
import { reviewScopeGuardDeps } from './review-scope-guard.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeAndCommit(repo: string, fileName: string, content: string, message: string): string {
  writeFileSync(join(repo, fileName), content, 'utf-8');
  git(repo, ['add', fileName]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function createVerificationRepo(): { tmpDir: string; repoDir: string; remoteDir: string; baseSha: string; headSha: string } {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-git-test-'));
  const remoteDir = join(tmpDir, 'origin.git');
  const repoDir = join(tmpDir, 'work');

  execFileSync('git', ['init', '--bare', remoteDir], { encoding: 'utf-8' });
  execFileSync('git', ['init', repoDir], { encoding: 'utf-8' });
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Verification Test']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);

  writeAndCommit(repoDir, 'base.txt', 'base\n', 'base');
  git(repoDir, ['branch', '-M', 'auto/integration']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['push', '-u', 'origin', 'auto/integration']);

  git(repoDir, ['switch', '-c', 'task/test']);
  const headSha = writeAndCommit(repoDir, 'feature.txt', 'feature\n', 'feature');

  return { tmpDir, repoDir, remoteDir, baseSha, headSha };
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

test('runVerificationRecipe: all commands pass', () => {
  const recipe = {
    commands: ['echo "test1"', 'echo "test2"'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert.equal(result.status, 'pass');
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].status, 'pass');
  assert.equal(result.commands[1].status, 'pass');
  assert.equal(result.commands[0].exitCode, 0);
});

test('runVerificationRecipe: first command fails', () => {
  const recipe = {
    commands: ['false', 'echo "should not run"'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert.equal(result.status, 'fail');
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].status, 'fail');
  assert(result.commands[0].exitCode !== 0);
  assert(result.commands[0].failureReason);
});

test('runVerificationRecipe: captures command exit code', () => {
  const recipe = {
    commands: ['exit 42'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert.equal(result.commands[0].status, 'fail');
  assert.equal(result.commands[0].exitCode, 42);
});

test('runVerificationRecipe: captures duration', () => {
  const recipe = {
    commands: ['sleep 0.1 && echo "done"'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert(result.commands[0].durationMs !== undefined);
  assert(result.commands[0].durationMs > 50); // Should be at least 100ms
});

test('writeVerificationArtifact: writes atomic artifact', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const artifactPath = join(tmpDir, 'artifact.json');
    const result = {
      status: 'pass' as const,
      commands: [
        {
          index: 0,
          command: 'npm test',
          status: 'pass' as const,
          exitCode: 0,
          durationMs: 1000,
          logPath: 'cmd-0.log',
        },
      ],
    };

    writeVerificationArtifact(result, artifactPath, {
      workingBranch: 'test-branch',
      headSha: 'abc123',
      baseSha: 'def456',
    });

    assert(existsSync(artifactPath));
    const content = readFileSync(artifactPath, 'utf-8');
    const artifact = JSON.parse(content);

    assert.equal(artifact.version, '1.0');
    assert.equal(artifact.workingBranch, 'test-branch');
    assert.equal(artifact.headSha, 'abc123');
    assert.equal(artifact.baseSha, 'def456');
    assert.equal(artifact.overallStatus, 'pass');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readAndValidateArtifact: validates matching SHAs', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const artifactPath = join(tmpDir, 'artifact.json');
    const artifact = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc123',
      baseSha: 'def456',
      overallStatus: 'pass' as const,
      commands: [],
    };

    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf-8');

    const { artifact: read, isValid, shasMismatch } = readAndValidateArtifact(
      artifactPath,
      'abc123',
      'def456',
    );

    assert(read !== null);
    assert.equal(isValid, true);
    assert.equal(shasMismatch, false);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readAndValidateArtifact: detects SHA mismatch', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const artifactPath = join(tmpDir, 'artifact.json');
    const artifact = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc123',
      baseSha: 'def456',
      overallStatus: 'pass' as const,
      commands: [],
    };

    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf-8');

    const { shasMismatch } = readAndValidateArtifact(
      artifactPath,
      'different-sha', // Different HEAD SHA
      'def456',
    );

    assert.equal(shasMismatch, true);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readAndValidateArtifact: returns null for missing file', () => {
  const { artifact, isValid } = readAndValidateArtifact(
    '/nonexistent/path.json',
  );

  assert.equal(artifact, null);
  assert.equal(isValid, false);
});

test('extractBoundedLogExcerpt: truncates long logs', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const logPath = join(tmpDir, 'cmd.log');
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    const excerpt = extractBoundedLogExcerpt(logPath, 10);

    assert(excerpt.includes('Line 1'));
    assert(excerpt.includes('Line 200'));
    assert(excerpt.includes('omitted'));
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('getRemediationGuidance: formats failure message', () => {
  const result = {
    status: 'fail' as const,
    commands: [
      {
        index: 0,
        command: 'npm test',
        status: 'pass' as const,
        exitCode: 0,
        durationMs: 1000,
      },
      {
        index: 1,
        command: 'npm run lint',
        status: 'fail' as const,
        exitCode: 1,
        durationMs: 500,
        failureReason: 'Linting errors found',
        logPath: undefined,
      },
    ],
  };

  const guidance = getRemediationGuidance(result);

  assert(guidance.includes('Command #1 failed'));
  assert(guidance.includes('npm run lint'));
  assert(guidance.includes('Linting errors found'));
});

test('fetchAndResolveBase: fetches remote base tip before resolving', () => {
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    const result = fetchAndResolveBase(repoDir, 'auto/integration');

    assert(!('kind' in result));
    assert.equal(result.baseSha, baseSha);
    assert.equal(result.fetchDiagnostics.upstreamBranch, 'auto/integration');
    assert.equal(result.fetchDiagnostics.fetchedRef, 'origin/auto/integration');
    assert(result.fetchedAt <= Date.now());
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fetchAndResolveBase: rejects a branch that does not include refreshed base', () => {
  const { tmpDir, repoDir } = createVerificationRepo();
  try {
    git(repoDir, ['switch', 'auto/integration']);
    writeAndCommit(repoDir, 'base.txt', 'base\nadvanced\n', 'advance base');
    git(repoDir, ['push', 'origin', 'auto/integration']);
    git(repoDir, ['switch', 'task/test']);

    const result = fetchAndResolveBase(repoDir, 'auto/integration');

    assert('kind' in result);
    assert.equal(result.kind, 'resolve-failed');
    assert(result.diagnostics.includes('HEAD is not a descendant'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fetchAndResolveBase: reports unavailable base branch clearly', () => {
  const { tmpDir, repoDir } = createVerificationRepo();
  try {
    const result = fetchAndResolveBase(repoDir, 'does/not/exist');

    assert('kind' in result);
    assert.equal(result.kind, 'branch-unavailable');
    assert(result.diagnostics.includes("Base branch 'does/not/exist' not found"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fetchAndResolveBase: blocks when origin cannot be fetched', () => {
  const { tmpDir, repoDir, remoteDir } = createVerificationRepo();
  try {
    rmSync(remoteDir, { recursive: true, force: true });

    const result = fetchAndResolveBase(repoDir, 'auto/integration');

    assert('kind' in result);
    assert.equal(result.kind, 'fetch-failed');
    assert(result.diagnostics.includes("base branch 'auto/integration'"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: blocks unsafe branch diff after refreshed base', () => {
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    const featureDir = join(repoDir, 'features', 'test');
    execFileSync('mkdir', ['-p', featureDir]);
    writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`feature.txt\`
`);
    writeFileSync(join(featureDir, '.review-scope-baseline.json'), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: ['feature.txt'],
    }));
    writeAndCommit(repoDir, 'unrelated.txt', 'bad\n', 'unsafe review fix');

    const result = runPrePrSafetyGuard({
      stateDir: repoDir,
      baseSha,
      featureDir,
    });

    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /unrelated\.txt/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: fails open when no feature directory can be resolved', () => {
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    // No featureDir supplied and none resolvable: the guard cannot determine
    // which files the task owns. Before this fix it blocked here, which made
    // checkPrePrVerificationGate reject every caller in every repo.
    // Stage the change rather than committing it: the guard polices the
    // review commit's *uncommitted* edits, so committed work is task work by
    // definition and is never flagged. A committed change here would make the
    // guard pass trivially and prove nothing about the fail-open path.
    writeFileSync(join(repoDir, 'rogue.txt'), 'bad\n');
    git(repoDir, ['add', 'rogue.txt']);

    const result = runPrePrSafetyGuard({ stateDir: repoDir, baseSha });

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skipCause, 'feature-dir-unresolved');
    assert.match(result.reason ?? '', /scope guard skipped/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: a resolvable scope still blocks an out-of-scope change', () => {
  // Guards the fail-open above: it must not swallow a real violation.
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    const featureDir = join(repoDir, 'features', 'test');
    execFileSync('mkdir', ['-p', featureDir]);
    writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`feature.txt\`
`);
    writeFileSync(join(featureDir, '.review-scope-baseline.json'), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: ['feature.txt'],
    }));
    writeAndCommit(repoDir, 'unrelated.txt', 'bad\n', 'out of scope');

    const result = runPrePrSafetyGuard({ stateDir: repoDir, baseSha, featureDir });

    assert.equal(result.passed, false);
    assert.notEqual(result.skipped, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: branch derivation alone blocks an out-of-scope change', () => {
  // No explicit featureDir: the guard must derive features/test from the
  // task/test branch, proving the zero-config path enforces at every call site.
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    const featureDir = join(repoDir, 'features', 'test');
    execFileSync('mkdir', ['-p', featureDir]);
    writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`feature.txt\`
`);
    // Staged, not committed — see the note above: only uncommitted review
    // edits are in the guard's remit.
    writeFileSync(join(repoDir, 'rogue.txt'), 'bad\n');
    git(repoDir, ['add', 'rogue.txt']);

    const result = runPrePrSafetyGuard({ stateDir: repoDir, baseSha });

    assert.equal(result.passed, false);
    assert.notEqual(result.skipped, true);
    assert.match(result.reason ?? '', /rogue\.txt/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: declared scope with no baseline file passes an in-scope change', () => {
  // Regression: a resolvable featureDir with a declared scope but no
  // persisted baseline must enforce against the declared scope and pass —
  // not block on "Unable to resolve a review baseline".
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    const featureDir = join(repoDir, 'features', 'test');
    execFileSync('mkdir', ['-p', featureDir]);
    writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`feature.txt\`
`);

    const result = runPrePrSafetyGuard({ stateDir: repoDir, baseSha, featureDir });

    assert.equal(result.passed, true);
    assert.notEqual(result.skipped, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: featureDir declaring nothing is enforced via git-derived scope', () => {
  // Superseded contract: this previously skipped with `no-scope-authority`,
  // because an unexpanded packet with no baseline left nothing to enforce
  // against. The guard now always derives task scope from the merge-base, so
  // the same feature directory yields real authority and the change is
  // actually checked instead of waved through — strictly stronger.
  //
  // The `no-scope-authority` skip is NOT dead: it still fires when the guard
  // fails and every remaining finding is missing-authority. It is simply no
  // longer reachable from this fixture, whose change is in git-derived scope.
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  try {
    const featureDir = join(repoDir, 'features', 'test');
    execFileSync('mkdir', ['-p', featureDir]);

    const result = runPrePrSafetyGuard({ stateDir: repoDir, baseSha, featureDir });

    assert.equal(result.passed, true);
    assert.notEqual(result.skipped, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runPrePrSafetyGuard: git collection errors fail closed even without declared scope', () => {
  const { tmpDir, repoDir, baseSha } = createVerificationRepo();
  const realRunner = reviewScopeGuardDeps.execShellCommand;
  try {
    const featureDir = join(repoDir, 'features', 'test');
    execFileSync('mkdir', ['-p', featureDir]);
    reviewScopeGuardDeps.execShellCommand = ((cmd: string, opts?: { encoding?: string; cwd?: string }) => {
      if (cmd.startsWith('git diff')) {
        throw new Error('simulated git failure');
      }
      return realRunner(cmd, opts);
    }) as typeof realRunner;

    const result = runPrePrSafetyGuard({ stateDir: repoDir, baseSha, featureDir });

    assert.equal(result.passed, false);
    assert.notEqual(result.skipped, true);
    assert.match(result.reason ?? '', /simulated git failure/);
  } finally {
    reviewScopeGuardDeps.execShellCommand = realRunner;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
