import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { hasTaskWorkspaceRoots, resolveTaskFeatureDir, validateReviewScope } from './review-scope-guard.ts';

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

// The resolver reads WAVEMILL_* env vars that are exported for real inside
// mill worktrees. Pin the environment per test so resolution is driven only by
// the values a test sets, and the ambient shell never leaks in.
const SCOPE_ENV_KEYS = ['WAVEMILL_FEATURE_DIR', 'WAVEMILL_FEATURE_SLUG', 'WAVEMILL_SLUG'] as const;

function withScopeEnv(env: Partial<Record<(typeof SCOPE_ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved = SCOPE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of SCOPE_ENV_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('resolveTaskFeatureDir: explicit path wins over env and branch derivation', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const explicit = join(repoDir, 'somewhere-else');
    withScopeEnv({ WAVEMILL_FEATURE_DIR: join(repoDir, 'features', 'scope-guard') }, () => {
      // Explicit is honored as-is, without an existence check.
      assert.equal(resolveTaskFeatureDir(repoDir, explicit), explicit);
    });
  } finally {
    cleanup();
  }
});

test('resolveTaskFeatureDir: WAVEMILL_FEATURE_DIR wins over branch derivation when it exists', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const envDir = join(repoDir, 'other-dir');
    mkdirSync(envDir, { recursive: true });
    withScopeEnv({ WAVEMILL_FEATURE_DIR: envDir }, () => {
      assert.equal(resolveTaskFeatureDir(repoDir), envDir);
    });
  } finally {
    cleanup();
  }
});

test('resolveTaskFeatureDir: WAVEMILL_FEATURE_SLUG finds features/<slug> and bugs/<slug>', () => {
  const { repoDir, featureDir, cleanup } = makeRepo();
  try {
    withScopeEnv({ WAVEMILL_FEATURE_SLUG: 'scope-guard' }, () => {
      assert.equal(resolveTaskFeatureDir(repoDir), featureDir);
    });

    const bugDir = join(repoDir, 'bugs', 'env-bug');
    mkdirSync(bugDir, { recursive: true });
    withScopeEnv({ WAVEMILL_FEATURE_SLUG: 'env-bug' }, () => {
      assert.equal(resolveTaskFeatureDir(repoDir), bugDir);
    });
  } finally {
    cleanup();
  }
});

test('resolveTaskFeatureDir: WAVEMILL_SLUG is used when WAVEMILL_FEATURE_SLUG is unset', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // A dir distinct from the branch-derived features/scope-guard proves the
    // slug env var, not branch derivation, resolved it.
    const slugDir = join(repoDir, 'features', 'wm-slug');
    mkdirSync(slugDir, { recursive: true });
    withScopeEnv({ WAVEMILL_SLUG: 'wm-slug' }, () => {
      assert.equal(resolveTaskFeatureDir(repoDir), slugDir);
    });
  } finally {
    cleanup();
  }
});

test('resolveTaskFeatureDir: env pointing at missing dirs falls through to branch derivation', () => {
  const { repoDir, featureDir, cleanup } = makeRepo();
  try {
    withScopeEnv(
      {
        WAVEMILL_FEATURE_DIR: join(repoDir, 'does-not-exist'),
        WAVEMILL_FEATURE_SLUG: 'missing-slug',
        WAVEMILL_SLUG: 'also-missing',
      },
      () => {
        // Branch task/scope-guard still resolves features/scope-guard.
        assert.equal(resolveTaskFeatureDir(repoDir), featureDir);
      },
    );
  } finally {
    cleanup();
  }
});

test('resolveTaskFeatureDir: branch derivation works with no env set', () => {
  const { repoDir, featureDir, cleanup } = makeRepo();
  try {
    withScopeEnv({}, () => {
      assert.equal(resolveTaskFeatureDir(repoDir), featureDir);
    });
  } finally {
    cleanup();
  }
});

test('resolveTaskFeatureDir: returns null in a repo with no roots and a non-matching branch', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-plain-'));
  try {
    git(repoDir, 'init -b main');
    git(repoDir, 'config user.name "Test User"');
    git(repoDir, 'config user.email "test@example.com"');
    commitFile(repoDir, 'README.md', 'base\n', 'base');
    withScopeEnv({}, () => {
      assert.equal(resolveTaskFeatureDir(repoDir), null);
    });
    assert.equal(hasTaskWorkspaceRoots(repoDir), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('hasTaskWorkspaceRoots: detects features/ and bugs/ roots', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    assert.equal(hasTaskWorkspaceRoots(repoDir), true);

    const bugsOnly = mkdtempSync(join(tmpdir(), 'review-scope-bugs-'));
    try {
      assert.equal(hasTaskWorkspaceRoots(bugsOnly), false);
      mkdirSync(join(bugsOnly, 'bugs'), { recursive: true });
      assert.equal(hasTaskWorkspaceRoots(bugsOnly), true);
    } finally {
      rmSync(bugsOnly, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

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
