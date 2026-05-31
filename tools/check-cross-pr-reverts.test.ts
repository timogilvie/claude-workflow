import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { crossPrRevertCheckDeps, runCrossPrRevertCheck } from './check-cross-pr-reverts.ts';

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commitFile(repoDir: string, path: string, contents: string, message: string): void {
  writeFileSync(join(repoDir, path), contents);
  git(repoDir, `add ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
}

function removeFile(repoDir: string, path: string, message: string): void {
  git(repoDir, `rm ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
}

function mergePrBranch(
  repoDir: string,
  branch: string,
  prNumber: number,
  title: string,
): void {
  git(repoDir, `merge --no-ff ${shellQuote(branch)} -m ${shellQuote(`Merge pull request #${prNumber} from test/${branch}`)} -m ${shellQuote(title)}`);
}

function makeRepo(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-cli-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config));
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');
  git(repoDir, 'checkout -b auto/integration');

  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

test('runCrossPrRevertCheck blocks unacknowledged cross-PR deletions', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    removeFile(repoDir, 'strategy.txt', 'Remove unrelated diff');

    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.equal(result.blocked, true);
    assert.equal(result.unacknowledged.length, 1);
    assert.equal(result.unacknowledged[0].prNumber, 437);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck allows explicitly acknowledged deletions', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    removeFile(repoDir, 'strategy.txt', 'Intentionally remove strategy');

    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: 'Intentionally reverts #437',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.acknowledged.length, 1);
    assert.equal(result.unacknowledged.length, 0);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck reports disabled status when config disables the guard', () => {
  const { repoDir, cleanup } = makeRepo({
    reviewMerge: {
      crossPrRevertCheck: {
        enabled: false,
      },
    },
  });
  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.disabled, true);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck falls back to recent commit messages when gh metadata is unavailable', () => {
  const { repoDir, cleanup } = makeRepo();
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string, options?: { cwd?: string; encoding?: string }) => {
    if (command.startsWith('gh pr view')) {
      throw new Error('no open pr');
    }
    return execSync(command, {
      cwd: options?.cwd ?? repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  });

  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    removeFile(repoDir, 'strategy.txt', 'Intentionally reverts #437');

    const result = runCrossPrRevertCheck({
      repoDir,
    });

    assert.equal(result.blocked, false);
    assert.equal(result.acknowledged.length, 1);
    assert.equal(result.unacknowledged.length, 0);
  } finally {
    execMock.mock.restore();
    cleanup();
  }
});
