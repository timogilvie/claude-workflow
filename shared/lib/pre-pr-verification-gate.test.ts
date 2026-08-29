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

function createGateRepo(options: { withFeatureDir?: boolean } = {}): {
  tmpDir: string;
  repoDir: string;
  remoteDir: string;
  featureDir: string;
  baseSha: string;
  headSha: string;
} {
  const withFeatureDir = options.withFeatureDir ?? true;
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

  // Realistic task worktree: the branch slug matches features/<slug>, whose
  // task packet declares the file this fixture commits. The safety guard's
  // branch derivation resolves this directory, so the eight baseline gate
  // tests run with scope enforcement active (and passing), not skipped.
  // Left uncommitted deliberately: task context lives beside the change, and
  // the guard diffs base..HEAD only.
  const featureDir = join(repoDir, 'features', 'test');
  if (withFeatureDir) {
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`feature.txt\`
`, 'utf-8');
  }

  return { tmpDir, repoDir, remoteDir, featureDir, baseSha, headSha };
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

test('gate: blocks an out-of-scope change with the offending path in the failure', () => {
  const { tmpDir, repoDir, featureDir, baseSha } = createGateRepo();
  try {
    // Persisted baseline scopes committed changes to feature.txt only, so
    // rogue.txt (added afterward) falls out of scope and must block. Without
    // a baseline the branch's own committed diff governs (HOK-2913 REQ-F1),
    // so the baseline is what makes out-of-scope committed edits enforceable.
    writeFileSync(join(featureDir, '.review-scope-baseline.json'), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: ['feature.txt'],
    }), 'utf-8');
    const headSha = writeAndCommit(repoDir, 'rogue.txt', 'not declared\n', 'out of scope change');
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
    assert.equal(result.reason, 'Pre-PR safety guard failed');
    assert.equal(result.requiresRemediation, true);
    assert(result.recommendation?.includes('rogue.txt'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: passes an in-scope change enforced via a persisted baseline artifact', () => {
  // No declared scope at all: the persisted .review-scope-baseline.json is the
  // only authority, and it covers the change.
  const { tmpDir, repoDir, featureDir, headSha, baseSha } = createGateRepo({ withFeatureDir: false });
  try {
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.review-scope-baseline.json'), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: ['feature.txt'],
    }), 'utf-8');
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
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: fails closed as a configuration error when no feature directory resolves', () => {
  const { tmpDir, repoDir, headSha, baseSha } = createGateRepo({ withFeatureDir: false });
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

    assert.equal(result.passed, false);
    assert(result.reason?.includes('cannot enforce review scope'));
    assert(result.recommendation?.includes('configuration error'));
    assert.equal(result.requiresRemediation, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: explicit featureDir argument overrides branch derivation', () => {
  // Derivation would find features/test (whose baseline scopes feature.txt
  // and would pass); the explicit featureDir points to a different directory
  // whose baseline scopes committed changes elsewhere, so the same committed
  // feature.txt must now block — proving the override took effect. Both dirs
  // carry baselines because without one the branch's own committed diff
  // governs (HOK-2913 REQ-F1) and nothing would ever block here.
  const { tmpDir, repoDir, featureDir, headSha, baseSha } = createGateRepo();
  try {
    writeFileSync(join(featureDir, '.review-scope-baseline.json'), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: ['feature.txt'],
    }), 'utf-8');

    const altFeatureDir = join(repoDir, 'features', 'alt');
    mkdirSync(altFeatureDir, { recursive: true });
    writeFileSync(join(altFeatureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`other.txt\`
`, 'utf-8');
    writeFileSync(join(altFeatureDir, '.review-scope-baseline.json'), JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'test',
      sinceCommit: baseSha,
      headRef: 'HEAD',
      paths: ['other.txt'],
    }), 'utf-8');

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
      altFeatureDir,
    );

    assert.equal(result.passed, false);
    assert.equal(result.reason, 'Pre-PR safety guard failed');
    assert(result.recommendation?.includes('feature.txt'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate: warns and proceeds when the task context declares no scope authority', () => {
  // featureDir resolves but yields neither declared scope nor a baseline:
  // the gate must degrade (warn + continue to artifact checks), not wedge.
  const { tmpDir, repoDir, featureDir, headSha, baseSha } = createGateRepo({ withFeatureDir: false });
  try {
    mkdirSync(featureDir, { recursive: true });
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

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
