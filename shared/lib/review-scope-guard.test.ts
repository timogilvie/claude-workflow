import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  REVIEW_SCOPE_GUARD_NO_COMMIT_COMMITTED_MESSAGE,
  REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE,
  REVIEW_SCOPE_GUARD_NO_PR_MESSAGE,
  REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
  validateReviewScope,
  writeReviewScopeBaseline,
} from './review-scope-guard.ts';

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

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  const absPath = join(repoDir, path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf-8');
  git(repoDir, `add ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function makeRepo(): { repoDir: string; featureDir: string; baseCommit: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-'));
  git(repoDir, 'init -b auto/integration');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    reviewMerge: { crossPrRevertCheck: { enabled: false } },
  }));
  const baseCommit = commitFile(repoDir, 'README.md', 'base\n', 'base');
  git(repoDir, 'checkout -b task/scope-guard');
  const featureDir = join(repoDir, 'features', 'scope-guard');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'selected-task.json'), JSON.stringify({
    taskId: 'HOK-1',
    featureName: 'scope-guard',
    reviewBaseCommit: baseCommit,
  }));
  writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`src/app.ts\`
- \`src/app.test.ts\`
`);
  return {
    repoDir,
    featureDir,
    baseCommit,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

/**
 * A plain worktree: no features/ directory, no task packet, no baseline —
 * only git. `.wavemill-config.json` is committed on the integration branch so
 * it is neither untracked noise nor part of the task diff.
 */
function makeGitOnlyRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-git-'));
  git(repoDir, 'init -b auto/integration');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    reviewMerge: { crossPrRevertCheck: { enabled: false } },
  }));
  git(repoDir, 'add .wavemill-config.json');
  commitFile(repoDir, 'README.md', 'base\n', 'base');
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function stageFile(repoDir: string, path: string, contents: string): void {
  const absPath = join(repoDir, path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf-8');
  git(repoDir, `add ${shellQuote(path)}`);
}

test('validateReviewScope allows files in the original coding baseline', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      writeBaseline: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.baselinePaths, ['src/app.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope blocks later committed files outside baseline and declared scope', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    validateReviewScope({ repoDir, featureDir, sinceCommit: baseCommit, writeBaseline: true });
    commitFile(repoDir, 'shared/lib/unrelated.ts', 'stale\n', 'bad review fix');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      writeBaseline: true,
    });

    assert.equal(result.ok, false);
    assert(result.findings.some((finding) => finding.path === 'shared/lib/unrelated.ts'));
  } finally {
    cleanup();
  }
});

test('validateReviewScope includes staged and working-tree changes before commit', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    validateReviewScope({ repoDir, featureDir, sinceCommit: baseCommit, writeBaseline: true });
    mkdirSync(join(repoDir, 'shared/lib'), { recursive: true });
    writeFileSync(join(repoDir, 'shared/lib/unrelated.ts'), 'stale\n', 'utf-8');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      includeWorkingTree: true,
    });

    assert.equal(result.ok, false);
    assert(result.findings.some((finding) => finding.path === 'shared/lib/unrelated.ts'));
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// Git-derived scope (HOK-2887): no featureDir, no sinceCommit
// ────────────────────────────────────────────────────────────────

test('validateReviewScope evaluates git-derived scope with no featureDir and no sinceCommit', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/plain-scope');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/observer.ts', 'export const a = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.equal(result.ok, true);
    assert.equal(result.featureDir, null);
    assert.deepEqual(result.taskPaths, ['tools/observer.ts']);
    assert.deepEqual(result.stagedPaths, ['tools/observer.ts']);
    assert.match(result.baselineSource, /^git merge-base auto\/integration \([0-9a-f]+\)$/);
  } finally {
    cleanup();
  }
});

test('validateReviewScope blocks stale staged overwrites of integration-only files before any commit', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    // Replay of 17d17fb5 (PR #1243): the task never touched workflow-router.ts;
    // it landed on auto/integration and was merged in. Staging a stale
    // overwrite must be refused while it is still only in the index.
    git(repoDir, 'checkout -b task/observer-work');
    commitFile(repoDir, 'tools/observer.ts', 'observer fix\n', 'Fix observer task file');

    git(repoDir, 'checkout auto/integration');
    commitFile(repoDir, 'shared/lib/workflow-router.ts', 'queue watchdog fix\n', 'Fix queue watchdog');

    git(repoDir, 'checkout task/observer-work');
    git(repoDir, 'merge auto/integration --no-edit');
    const headBefore = git(repoDir, 'rev-parse HEAD');
    stageFile(repoDir, 'shared/lib/workflow-router.ts', 'stale pre-watchdog contents\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.equal(result.ok, false);
    assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE);
    assert.deepEqual(result.taskPaths, ['tools/observer.ts']);
    assert.deepEqual(result.outOfScopePaths, ['shared/lib/workflow-router.ts']);
    assert(result.findings.some((finding) =>
      finding.severity === 'blocker' && finding.path === 'shared/lib/workflow-router.ts'));
    // The violation was caught in the index — no commit was created.
    assert.equal(git(repoDir, 'rev-parse HEAD'), headBefore);

    // Unstage + revert the out-of-scope path, stage a task-scoped fix → pass.
    git(repoDir, 'reset shared/lib/workflow-router.ts');
    git(repoDir, 'checkout -- shared/lib/workflow-router.ts');
    stageFile(repoDir, 'tools/observer.ts', 'observer fix\nreview follow-up\n');

    const validResult = validateReviewScope({ repoDir, includeWorkingTree: true });
    assert.equal(validResult.status, 'pass');
    assert.deepEqual(validResult.stagedPaths, ['tools/observer.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope allows test and registration companions for scoped source files', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    commitFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n', 'test runner');
    git(repoDir, 'checkout -b task/companions');
    commitFile(repoDir, 'shared/lib/foo.ts', 'export const foo = 1;\n', 'task work');
    stageFile(repoDir, 'shared/lib/foo.test.ts', 'import "./foo.ts";\n');
    stageFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n# shared/lib/foo.test.ts\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.allowedCompanionPaths, [
      'shared/lib/foo.test.ts',
      'tests/run-unit-tests.sh',
    ]);
  } finally {
    cleanup();
  }
});

test('validateReviewScope rejects test and registration companions when the source is not in scope', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    commitFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n', 'test runner');
    git(repoDir, 'checkout -b task/no-companions');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'shared/lib/bar.test.ts', 'import "./bar.ts";\n');
    stageFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n# shared/lib/bar.test.ts\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.outOfScopePaths, [
      'shared/lib/bar.test.ts',
      'tests/run-unit-tests.sh',
    ]);
  } finally {
    cleanup();
  }
});

test('validateReviewScope rejects new unrelated staged files', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/unrelated');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/unrelated.ts', 'export const b = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.outOfScopePaths, ['tools/unrelated.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope returns status error (never a pass) when git fails', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/git-failure');
    const failingRunner = (cmd: string): string => {
      if (cmd.includes('merge-base')) {
        throw new Error('fatal: Not a valid object name auto/integration');
      }
      return '';
    };

    const result = validateReviewScope({ repoDir, shellRunner: failingRunner });

    assert.equal(result.status, 'error');
    assert.equal(result.ok, false);
    assert.equal(result.message, REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE);
    assert.equal(result.toolError?.commandClass, 'git-merge-base');
    assert.match(result.toolError?.stderr ?? '', /Not a valid object name/);
    assert.deepEqual(result.findings, []);
  } finally {
    cleanup();
  }
});

test('validateReviewScope fails closed on ambiguous staged paths', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-mock-'));
  try {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      reviewMerge: { crossPrRevertCheck: { enabled: false } },
    }));
    const mockRunner = (cmd: string): string => {
      if (cmd.includes('merge-base')) {
        return 'abc123\n';
      }
      if (cmd.includes('--cached --name-only -z')) {
        return 'tools/../observer.ts\0';
      }
      if (cmd.includes('--name-only -z')) {
        return 'tools/observer.ts\0';
      }
      if (cmd.includes('rev-parse --abbrev-ref')) {
        return 'main\n';
      }
      return '';
    };

    const result = validateReviewScope({ repoDir, shellRunner: mockRunner });

    assert.equal(result.status, 'error');
    assert.equal(result.toolError?.commandClass, 'git-path-normalization');
    assert.match(result.toolError?.stderr ?? '', /Ambiguous staged index path/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('validateReviewScope still admits a packet-declared new file via declared scope', () => {
  const { repoDir, featureDir, cleanup } = makeRepo();
  try {
    // Commit the feature-dir artifacts and config so they are task paths, then
    // stage a brand-new file that only the task packet declares.
    git(repoDir, 'add .wavemill-config.json features');
    git(repoDir, 'commit -m "feature artifacts"');
    stageFile(repoDir, 'src/app.ts', 'export const value = 1;\n');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      includeWorkingTree: true,
      writeBaseline: false,
    });

    assert.equal(result.status, 'pass');
    assert(result.declaredScope.includes('src/app.ts'));
  } finally {
    cleanup();
  }
});

test('validateReviewScope ignores reverts that live in the integration branch history itself', () => {
  // The cross-PR revert detector flags any branch whose HEAD matches the
  // pre-PR content of a recently merged PR — including branches that are
  // simply up to date with an integration branch that itself reverted the
  // PR. The guard must not block commits for reverts this branch did not
  // introduce.
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-revert-'));
  try {
    git(repoDir, 'init -b auto/integration');
    git(repoDir, 'config user.name "Test User"');
    git(repoDir, 'config user.email "test@example.com"');
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      reviewMerge: { crossPrRevertCheck: { enabled: true } },
    }));
    git(repoDir, 'add .wavemill-config.json');
    commitFile(repoDir, 'lib/common.sh', 'original\n', 'base');

    // A PR merges into integration...
    git(repoDir, 'checkout -b fix/liveness');
    commitFile(repoDir, 'lib/common.sh', 'liveness fix\n', 'liveness fix');
    git(repoDir, 'checkout auto/integration');
    git(repoDir, 'merge --no-ff fix/liveness -m "Merge pull request #7 from test/fix-liveness"');
    // ...and integration itself later reverts it.
    commitFile(repoDir, 'lib/common.sh', 'original\n', 'revert: drop liveness fix');

    // A task branch off the current tip stages purely in-scope work.
    git(repoDir, 'checkout -b task/up-to-date');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/observer.ts', 'export const a = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.crossPrReverts, []);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// CLI exit contract: 0 pass / 1 policy violation / 2 tool failure
// ────────────────────────────────────────────────────────────────

const TSX_BIN = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CLI_TOOL = join(process.cwd(), 'tools', 'check-review-scope.ts');

function runCli(repoDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(TSX_BIN, [CLI_TOOL, '--repo-dir', repoDir], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('check-review-scope CLI exits 0 when staged changes are in git-derived scope', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/cli-pass');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/observer.ts', 'export const a = 2;\n');

    const { status, stdout } = runCli(repoDir);

    assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
    assert.match(stdout, /Review scope guard passed/);
  } finally {
    cleanup();
  }
});

test('check-review-scope CLI exits 1 and lists paths on a policy violation', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/cli-fail');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/unrelated.ts', 'export const b = 2;\n');

    const { status, stdout } = runCli(repoDir);

    assert.equal(status, 1, `expected exit 1, got ${status}: ${stdout}`);
    assert.match(stdout, /tools\/unrelated\.ts/);
    assert.match(stdout, /No review commit may be created/);
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// HOK-2913: baseline-absent handoff, committed-history remedy, no-PR
// ────────────────────────────────────────────────────────────────

test('validateReviewScope with missing baseline and clean index passes on committed task deliverable (HOK-2913 REQ-F1)', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/committed-only');
    commitFile(repoDir, 'shared/lib/template-curly-checker.ts', 'export const check = 1;\n', 'Add curly checker');
    commitFile(repoDir, 'tools/check-template-curly.ts', 'export const cli = 1;\n', 'Add CLI');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass', `expected pass, got ${result.status}: ${result.message}`);
    assert.equal(result.ok, true);
    assert.equal(result.baselineIsArtifact, false);
    // The task's committed deliverable is recognized as allowed scope.
    assert.ok(result.taskPaths.includes('shared/lib/template-curly-checker.ts'));
    assert.ok(result.taskPaths.includes('tools/check-template-curly.ts'));
    // No out-of-scope findings on a clean index.
    assert.deepEqual(result.outOfScopePaths, []);
  } finally {
    cleanup();
  }
});

test('validateReviewScope with missing baseline still blocks unrelated staged review edits (HOK-2913 REQ-F4)', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/mixed');
    commitFile(repoDir, 'shared/lib/template-curly-checker.ts', 'export const check = 1;\n', 'task work');
    stageFile(repoDir, 'shared/lib/unrelated.ts', 'export const off_scope = 1;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.outOfScopePaths, ['shared/lib/unrelated.ts']);
    // Staged origin → the current staged-only remediation text.
    assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE);
    const staged = result.findings.find((f) => f.path === 'shared/lib/unrelated.ts');
    assert.equal(staged?.origin, 'staged');
  } finally {
    cleanup();
  }
});

test('validateReviewScope with persisted baseline + out-of-scope committed review edit reports committed remedy (HOK-2913 REQ-F3)', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    validateReviewScope({ repoDir, featureDir, sinceCommit: baseCommit, writeBaseline: true });
    // Simulate a bad review commit landing on an out-of-scope path.
    commitFile(repoDir, 'shared/lib/unrelated.ts', 'stale\n', 'bad review fix');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      writeBaseline: false,
    });

    assert.equal(result.status, 'fail');
    // The finding is committed-history — remedy tells the operator to revert
    // or amend, never to unstage a clean index (HOK-2913).
    const finding = result.findings.find((f) => f.path === 'shared/lib/unrelated.ts');
    assert.equal(finding?.origin, 'committed');
    assert.match(finding?.message ?? '', /Revert the review commit|amend/);
    assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_COMMITTED_MESSAGE);
    // The staged-only remediation string is deliberately not the top-level
    // message when nothing is staged.
    assert.notEqual(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE);
  } finally {
    cleanup();
  }
});

test('validateReviewScope surfaces no-PR outcome when scope passes and gh reports no PR (HOK-2913 REQ-F5)', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/no-pr-branch');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');

    // Simulate gh saying "no pull requests found" for this branch.
    const noPrRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }): string => {
      if (cmd.startsWith('gh pr view')) {
        const err = new Error('no pull requests found for branch "task/no-pr-branch"');
        throw err;
      }
      return execSync(cmd, {
        cwd: opts?.cwd ?? repoDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as string;
    };

    const result = validateReviewScope({
      repoDir,
      includeWorkingTree: true,
      checkPullRequest: true,
      shellRunner: noPrRunner,
    });

    assert.equal(result.status, 'no-pr');
    assert.equal(result.pullRequestState, 'absent');
    assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_PR_MESSAGE);
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('validateReviewScope treats a gh lookup failure as unknown (never blocks the pass) (HOK-2913 REQ-F5)', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/gh-broken');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');

    // Simulate gh being unavailable / unauthenticated for this branch.
    const brokenGhRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }): string => {
      if (cmd.startsWith('gh pr view')) {
        throw new Error('gh: not authenticated. Run gh auth login');
      }
      return execSync(cmd, {
        cwd: opts?.cwd ?? repoDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as string;
    };

    const result = validateReviewScope({
      repoDir,
      includeWorkingTree: true,
      checkPullRequest: true,
      shellRunner: brokenGhRunner,
    });

    assert.equal(result.pullRequestState, 'unknown');
    // A lookup failure must not turn a passing scope check into an error or
    // into a no-PR outcome — infrastructure error stays distinguishable
    // (HOK-2913 REQ-F5).
    assert.equal(result.status, 'pass');
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('writeReviewScopeBaseline snapshots the coding deliverable at the handoff (HOK-2913 REQ-F2)', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    // No baseline artifact yet — simulating the pre-handoff state.
    const baselinePath = join(featureDir, '.review-scope-baseline.json');
    assert.equal(existsSync(baselinePath), false);

    const baseline = writeReviewScopeBaseline({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
    });

    assert.ok(baseline);
    assert.equal(existsSync(baselinePath), true);
    const persisted = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.sinceCommit, baseCommit);
    assert.deepEqual(persisted.paths, ['src/app.ts']);

    // Now the guard runs against the persisted baseline (not the fallback).
    const result = validateReviewScope({ repoDir, featureDir, writeBaseline: false });
    assert.equal(result.status, 'pass');
    assert.equal(result.baselineIsArtifact, true);
  } finally {
    cleanup();
  }
});

test('check-review-scope CLI exits 2 and reports unverified on a git failure', () => {
  // A config file explicitly implies the integration branch, but the branch
  // does not exist locally: merge-base fails, which must be a tool error —
  // never a pass and never a policy violation.
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-broken-'));
  try {
    git(repoDir, 'init -b main');
    git(repoDir, 'config user.name "Test User"');
    git(repoDir, 'config user.email "test@example.com"');
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      reviewMerge: { crossPrRevertCheck: { enabled: false } },
    }));
    commitFile(repoDir, 'README.md', 'base\n', 'base');

    const { status, stdout } = runCli(repoDir);

    assert.equal(status, 2, `expected exit 2, got ${status}: ${stdout}`);
    assert.match(stdout, /could not verify/);
    assert.match(stdout, /unverified/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
