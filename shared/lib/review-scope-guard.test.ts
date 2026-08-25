import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { validateReviewScope } from './review-scope-guard.ts';

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
