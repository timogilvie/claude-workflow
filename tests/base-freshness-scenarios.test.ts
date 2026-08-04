/**
 * Integration tests for base freshness scenarios.
 *
 * These tests create real git repos with remote tracking to simulate:
 * - Base branch advancement scenarios
 * - Fetch error scenarios
 * - Rebase + rerun flow
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

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

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Create a minimal git repo with a remote and base branch.
 */
function createTestRepo(): {
  remote: string;
  local: string;
  cleanup: () => void;
} {
  const remoteDir = mkdtempSync(join('/tmp', 'git-remote-'));
  const localDir = mkdtempSync(join('/tmp', 'git-local-'));

  // Init remote repo
  execSync('git init --bare', { cwd: remoteDir });

  // Init local repo with initial commit
  execSync('git init', { cwd: localDir });
  execSync('git config user.email "test@example.com"', { cwd: localDir });
  execSync('git config user.name "Test User"', { cwd: localDir });
  writeFileSync(join(localDir, 'README.md'), '# Test Repo\n');
  execSync('git add README.md', { cwd: localDir });
  execSync('git commit -m "initial commit"', { cwd: localDir });

  // Add remote
  execSync(`git remote add origin ${remoteDir}`, { cwd: localDir });

  // Push main and base branches
  execSync('git push -u origin main', { cwd: localDir });
  execSync('git checkout -b auto/integration', { cwd: localDir });
  writeFileSync(join(localDir, 'base.txt'), 'base content v1\n');
  execSync('git add base.txt', { cwd: localDir });
  execSync('git commit -m "base v1"', { cwd: localDir });
  execSync('git push -u origin auto/integration', { cwd: localDir });

  return {
    remote: remoteDir,
    local: localDir,
    cleanup: () => {
      rmSync(remoteDir, { recursive: true });
      rmSync(localDir, { recursive: true });
    },
  };
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

test('base freshness: detect base advancement', () => {
  const { remote, local, cleanup } = createTestRepo();
  try {
    // Get initial base SHA
    const initialBaseSha = execSync('git rev-parse origin/auto/integration', {
      cwd: local,
      encoding: 'utf-8',
    }).trim();

    // Advance base in remote
    execSync('git checkout auto/integration', { cwd: local });
    writeFileSync(join(local, 'base.txt'), 'base content v2\n');
    execSync('git add base.txt', { cwd: local });
    execSync('git commit -m "base v2"', { cwd: local });
    execSync('git push origin auto/integration', { cwd: local });

    // Fetch from local repo (simulating remote advance)
    const newBaseSha = execSync('git rev-parse origin/auto/integration', {
      cwd: local,
      encoding: 'utf-8',
    }).trim();

    // Verify SHAs are different
    assert.notEqual(initialBaseSha, newBaseSha, 'base should have advanced');
  } finally {
    cleanup();
  }
});

test('base freshness: validate merge-base against remote ref', () => {
  const { remote, local, cleanup } = createTestRepo();
  try {
    // Create a topic branch from base
    execSync('git checkout auto/integration', { cwd: local });
    execSync('git checkout -b feature/test', { cwd: local });
    writeFileSync(join(local, 'feature.txt'), 'feature content\n');
    execSync('git add feature.txt', { cwd: local });
    execSync('git commit -m "feature"', { cwd: local });

    // Get merge-base against remote-tracking ref
    const mergeBase = execSync('git merge-base HEAD origin/auto/integration', {
      cwd: local,
      encoding: 'utf-8',
    }).trim();

    const baseRef = execSync('git rev-parse origin/auto/integration', {
      cwd: local,
      encoding: 'utf-8',
    }).trim();

    // merge-base should equal the base ref (no commits between)
    assert.equal(mergeBase, baseRef, 'merge-base should equal base ref');
  } finally {
    cleanup();
  }
});

test('base freshness: rebase on new base and rerun', () => {
  const { remote, local, cleanup } = createTestRepo();
  try {
    // Create topic branch from original base
    execSync('git checkout auto/integration', { cwd: local });
    const originalBase = execSync('git rev-parse auto/integration', {
      cwd: local,
      encoding: 'utf-8',
    }).trim();

    execSync('git checkout -b feature/work', { cwd: local });
    writeFileSync(join(local, 'work.txt'), 'work content\n');
    execSync('git add work.txt', { cwd: local });
    execSync('git commit -m "my work"', { cwd: local });

    // Advance base in remote
    execSync('git checkout auto/integration', { cwd: local });
    writeFileSync(join(local, 'base.txt'), 'base content v2\n');
    execSync('git add base.txt', { cwd: local });
    execSync('git commit -m "base v2"', { cwd: local });
    execSync('git push origin auto/integration', { cwd: local });

    // Back to feature branch, rebase on new base
    execSync('git checkout feature/work', { cwd: local });
    execSync('git rebase auto/integration', { cwd: local });

    // Verify merge-base changed
    const newBase = execSync('git merge-base HEAD origin/auto/integration', {
      cwd: local,
      encoding: 'utf-8',
    }).trim();

    assert.notEqual(
      originalBase,
      newBase,
      'merge-base should change after rebase',
    );
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
