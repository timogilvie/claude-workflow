/**
 * Tests for pre-PR verification gate.
 * Covers: gate checks, artifact validation, recommendations.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  checkPrePrVerificationGate,
  getCompatibilityBehavior,
  formatGateFailure,
  isRemediable,
} from './pre-pr-verification-gate.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

// These tests run inside mill worktrees where the WAVEMILL_* scope env vars
// are exported for real. Clear them for the duration of the run so feature-dir
// resolution is driven only by each test's fixture; restored before exit.
const SCOPE_ENV_KEYS = ['WAVEMILL_FEATURE_DIR', 'WAVEMILL_FEATURE_SLUG', 'WAVEMILL_SLUG'] as const;
const savedScopeEnv: Array<[string, string | undefined]> = SCOPE_ENV_KEYS.map(
  (key) => [key, process.env[key]],
);
for (const key of SCOPE_ENV_KEYS) {
  delete process.env[key];
}

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

function createGateRepo(): { tmpDir: string; repoDir: string; remoteDir: string; baseSha: string; headSha: string } {
  const tmpDir = mkdtempSync(join('/tmp', 'gate-git-test-'));
  const remoteDir = join(tmpDir, 'origin.git');
  const repoDir = join(tmpDir, 'work');

  execFileSync('git', ['init', '--bare', remoteDir], { encoding: 'utf-8' });
  execFileSync('git', ['init', repoDir], { encoding: 'utf-8' });
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Gate Test']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);

  writeAndCommit(repoDir, 'base.txt', 'base\n', 'base');
  git(repoDir, ['branch', '-M', 'auto/integration']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['push', '-u', 'origin', 'auto/integration']);

  git(repoDir, ['switch', '-c', 'task/test']);
  const headSha = writeAndCommit(repoDir, 'feature.txt', 'feature\n', 'feature');

  return { tmpDir, repoDir, remoteDir, baseSha, headSha };
}

function writeScopeFixture(featureDir: string, baseSha: string, scopedFile: string): void {
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, 'task-packet.md'),
    `# Task\n\n## Files to Modify\n\n- \`${scopedFile}\`\n`,
    'utf-8',
  );
  writeFileSync(
    join(featureDir, '.review-scope-baseline.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: [scopedFile],
    }),
    'utf-8',
  );
}

function writeArtifact(repoDir: string, artifact: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill/pre-pr-verification'), {
    recursive: true,
  });
  writeFileSync(
    join(repoDir, '.wavemill/pre-pr-verification/artifact.json'),
    JSON.stringify(artifact),
    'utf-8',
  );
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

test('gate: passes when verification is disabled', () => {
  const result = checkPrePrVerificationGate(
    '/tmp/test',
    { enabled: false, required: false, recipe: { commands: [] } },
  );

  assert.equal(result.passed, true);
});

test('gate: passes when verification is optional', () => {
  const result = checkPrePrVerificationGate(
    '/tmp/test',
    { enabled: true, required: false, recipe: { commands: ['npm test'] } },
  );

  assert.equal(result.passed, true);
});

test('gate: blocks when artifact is missing', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('artifact'));
    assert(result.recommendation);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: passes with valid artifact', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, true);
    assert(result.artifact);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: blocks on SHA mismatch', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'old-sha',
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('stale'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: blocks on failed verification', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'fail' as const,
      commands: [
        {
          index: 0,
          command: 'npm test',
          status: 'fail' as const,
          exitCode: 1,
          durationMs: 1000,
          logPath: '/path/to/log',
        },
      ],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert(result.requiresRemediation);
    assert(result.remediationPrompt);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: respects operator override', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'fail' as const, // Failed...
      overriddenBy: {
        reason: 'Manual approval',
        timestamp: new Date().toISOString(),
        operator: 'admin@example.com',
      },
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, true); // ...but overridden, so pass
    assert(result.reason?.includes('overridden'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: rejects artifact when refreshed base no longer matches recorded base', () => {
  const { tmpDir, repoDir, baseSha } = createGateRepo();
  try {
    git(repoDir, ['switch', 'auto/integration']);
    writeAndCommit(repoDir, 'base-2.txt', 'base advanced\n', 'advance base');
    git(repoDir, ['push', 'origin', 'auto/integration']);
    git(repoDir, ['switch', 'task/test']);
    git(repoDir, ['fetch', 'origin', 'auto/integration']);
    git(repoDir, ['rebase', 'FETCH_HEAD']);
    const rebasedHeadSha = git(repoDir, ['rev-parse', 'HEAD']);

    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: rebasedHeadSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      rebasedHeadSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('stale'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: successful rebase requires rerun artifact before passing', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    git(repoDir, ['switch', 'auto/integration']);
    const advancedBaseSha = writeAndCommit(repoDir, 'base-2.txt', 'base advanced\n', 'advance base');
    git(repoDir, ['push', 'origin', 'auto/integration']);
    git(repoDir, ['switch', 'task/test']);

    const beforeRebase = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );
    assert.equal(beforeRebase.passed, false);
    assert(beforeRebase.reason?.includes('Base branch refresh failed'));

    git(repoDir, ['fetch', 'origin', 'auto/integration']);
    git(repoDir, ['rebase', 'FETCH_HEAD']);
    const rebasedHeadSha = git(repoDir, ['rev-parse', 'HEAD']);

    const staleAfterRebase = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      rebasedHeadSha,
      advancedBaseSha,
    );
    assert.equal(staleAfterRebase.passed, false);
    assert(staleAfterRebase.reason?.includes('stale'));

    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: rebasedHeadSha,
      baseSha: advancedBaseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const rerun = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      rebasedHeadSha,
      advancedBaseSha,
    );
    assert.equal(rerun.passed, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: fetch failure blocks required verification with diagnostics', () => {
  const { tmpDir, repoDir, remoteDir, headSha, baseSha } = createGateRepo();
  try {
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });
    rmSync(remoteDir, { recursive: true, force: true });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('Base branch refresh failed'));
    assert(result.recommendation?.includes('remote base state is unknown'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: operator override cannot bypass a stale artifact', () => {
  const { tmpDir, repoDir, baseSha } = createGateRepo();
  try {
    git(repoDir, ['switch', 'auto/integration']);
    const advancedBaseSha = writeAndCommit(repoDir, 'base-2.txt', 'base advanced\n', 'advance base');
    git(repoDir, ['push', 'origin', 'auto/integration']);
    git(repoDir, ['switch', 'task/test']);
    git(repoDir, ['fetch', 'origin', 'auto/integration']);
    git(repoDir, ['rebase', 'FETCH_HEAD']);
    const rebasedHeadSha = git(repoDir, ['rev-parse', 'HEAD']);

    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: rebasedHeadSha,
      baseSha,
      overallStatus: 'fail' as const,
      overriddenBy: {
        reason: 'Manual approval',
        timestamp: new Date().toISOString(),
        operator: 'admin@example.com',
      },
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      rebasedHeadSha,
      advancedBaseSha,
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('stale'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: blocks out-of-scope change when the task feature dir is resolvable', () => {
  const { tmpDir, repoDir, baseSha } = createGateRepo();
  try {
    // Branch is task/test, so features/test exercises automatic branch derivation.
    writeScopeFixture(join(repoDir, 'features', 'test'), baseSha, 'feature.txt');
    const headSha = writeAndCommit(repoDir, 'unrelated.txt', 'bad\n', 'out of scope fix');
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /unrelated\.txt/);
    assert(result.requiresRemediation);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: passes an ordinary in-scope change when scope is resolvable', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo();
  try {
    // Only feature.txt (the declared scope) differs from base.
    writeScopeFixture(join(repoDir, 'features', 'test'), baseSha, 'feature.txt');
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, true);
    assert(result.artifact);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: fails closed when a workspace has task roots but no dir matches the branch', () => {
  const { tmpDir, repoDir, remoteDir, headSha, baseSha } = createGateRepo();
  try {
    // features/ root exists but nothing matches branch task/test.
    mkdirSync(join(repoDir, 'features', 'other-task'), { recursive: true });
    // The configuration error must be detected before any base fetch.
    rmSync(remoteDir, { recursive: true, force: true });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
    );

    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /feature directory/i);
    assert(!result.requiresRemediation);
    assert(result.recommendation?.includes('WAVEMILL_FEATURE_SLUG'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: explicit featureDir parameter overrides derivation', () => {
  const { tmpDir, repoDir, baseSha } = createGateRepo();
  try {
    // Scope fixture lives outside the features/<branch-slug> convention; the
    // repo has no features/ root, so without the explicit parameter the guard
    // would fail open and the fresh artifact below would let the gate pass.
    const customDir = join(tmpDir, 'custom-scope');
    writeScopeFixture(customDir, baseSha, 'feature.txt');
    const headSha = writeAndCommit(repoDir, 'unrelated.txt', 'bad\n', 'out of scope fix');
    writeArtifact(repoDir, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha,
      baseSha,
      overallStatus: 'pass' as const,
      commands: [],
    });

    const result = checkPrePrVerificationGate(
      repoDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      headSha,
      baseSha,
      customDir,
    );

    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /unrelated\.txt/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getCompatibilityBehavior: allows unconfigured by default', () => {
  const behavior = getCompatibilityBehavior(undefined, false);
  assert.equal(behavior, 'allow');
});

test('getCompatibilityBehavior: blocks when mode is "block"', () => {
  const behavior = getCompatibilityBehavior(
    { enabled: false, recipe: { commands: [] }, compatibility: { mode: 'block' } },
    false,
  );
  assert.equal(behavior, 'block');
});

test('formatGateFailure: creates readable message', () => {
  const result = {
    passed: false,
    reason: 'Verification failed',
    recommendation: 'Re-run the verification command',
  };

  const message = formatGateFailure(result);

  assert(message.includes('Verification failed'));
  assert(message.includes('Re-run the verification command'));
});

test('isRemediable: true for command failure', () => {
  const result = {
    passed: false,
    artifact: {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc',
      baseSha: 'def',
      overallStatus: 'fail' as const,
      commands: [],
    },
  };

  assert.equal(isRemediable(result), true);
});

test('isRemediable: false for passing gate', () => {
  const result = { passed: true };
  assert.equal(isRemediable(result), false);
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

for (const [key, value] of savedScopeEnv) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
