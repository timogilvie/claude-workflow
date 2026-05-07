import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import {
  resolveEvalsDir,
  resolveGlobalAggregatedEvalsPath,
  resolveWavemillInstallDir,
} from './evals-paths.ts';

let repoDir: string;
let worktreeDir: string;
let tempRoot: string;

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

describe('evals-paths', () => {
  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `evals-paths-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    repoDir = join(tempRoot, 'repo');
    worktreeDir = join(tempRoot, 'worktree');

    mkdirSync(repoDir, { recursive: true });
    git('init', repoDir);
    git('config user.name "Test User"', repoDir);
    git('config user.email "test@example.com"', repoDir);

    writeFileSync(join(repoDir, 'README.md'), 'seed\n', 'utf-8');
    git('add README.md', repoDir);
    git('commit -m "init"', repoDir);

    git('branch worktree-branch', repoDir);
    git(`worktree add ${worktreeDir} worktree-branch`, repoDir);

    repoDir = realpathSync(repoDir);
    worktreeDir = realpathSync(worktreeDir);
  });

  afterEach(() => {
    clearConfigCache();
    delete process.env.WAVEMILL_DIR;
    delete process.env.WAVEMILL_AGGREGATED_EVALS_PATH;

    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves the default evals path from the main repo when called in a worktree', () => {
    const resolved = resolveEvalsDir(undefined, worktreeDir);

    assert.deepEqual(resolved, {
      dir: join(repoDir, '.wavemill', 'evals'),
      fromConfig: false,
    });
  });

  it('resolves config overrides from the main repo when called in a worktree', () => {
    writeFileSync(
      join(worktreeDir, '.wavemill-config.json'),
      JSON.stringify({ eval: { evalsDir: '.wm/custom-evals' } }),
      'utf-8',
    );
    clearConfigCache(repoDir);
    clearConfigCache(worktreeDir);

    const resolved = resolveEvalsDir(undefined, worktreeDir);

    assert.deepEqual(resolved, {
      dir: join(repoDir, '.wm', 'custom-evals'),
      fromConfig: true,
    });
  });

  it('resolves explicit overrides from the provided path without worktree translation', () => {
    const explicitDir = './local-evals';

    const resolved = resolveEvalsDir(explicitDir, worktreeDir);

    assert.deepEqual(resolved, {
      dir: resolve(explicitDir),
      fromConfig: false,
    });
  });

  it('resolves global aggregated evals path from wavemill install by default', () => {
    const expected = join(resolveWavemillInstallDir(), '.wavemill', 'evals', 'aggregated-evals.jsonl');
    assert.equal(resolveGlobalAggregatedEvalsPath(), expected);
  });

  it('respects WAVEMILL_AGGREGATED_EVALS_PATH override', () => {
    const overridePath = join(tempRoot, 'custom', 'aggregated.jsonl');
    process.env.WAVEMILL_AGGREGATED_EVALS_PATH = overridePath;
    assert.equal(resolveGlobalAggregatedEvalsPath(), overridePath);
  });

  it('respects WAVEMILL_DIR override for wavemill install resolution', () => {
    const overrideDir = join(tempRoot, 'wavemill-install');
    process.env.WAVEMILL_DIR = overrideDir;
    assert.equal(resolveWavemillInstallDir(), overrideDir);
  });
});
