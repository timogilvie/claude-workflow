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

test('runCrossPrRevertCheck skips when the configured integration branch is missing', () => {
  const { repoDir, cleanup } = makeRepo();
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
    if (command.includes('git merge-base')) {
      throw new Error('fatal: Not a valid object name auto/integration');
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', () => {
    throw new Error('detectCrossPrReverts should not run when integration ref is missing');
  });

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reverts.length, 0);
    assert.equal(result.acknowledged.length, 0);
    assert.equal(result.unacknowledged.length, 0);
  } finally {
    detectMock.mock.restore();
    execMock.mock.restore();
    cleanup();
  }
});

test('runCrossPrRevertCheck resolves the default base branch when config is absent', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-no-config-'));
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', (input) => {
    assert.equal(input.integrationRef, 'main');
    return [];
  });
  const resolveMock = mock.method(crossPrRevertCheckDeps, 'resolveDefaultBaseRef', () => 'main');

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      baseRef: 'abc123',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reverts.length, 0);
  } finally {
    resolveMock.mock.restore();
    detectMock.mock.restore();
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('runCrossPrRevertCheck prefers configured integration branches over resolver fallback', () => {
  const { repoDir, cleanup } = makeRepo({
    integration: {
      integrationBranch: 'release/integration',
    },
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', (input) => {
    assert.equal(input.integrationRef, 'release/integration');
    return [];
  });
  const resolveMock = mock.method(crossPrRevertCheckDeps, 'resolveDefaultBaseRef', () => 'main');

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      baseRef: 'abc123',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
  } finally {
    resolveMock.mock.restore();
    detectMock.mock.restore();
    cleanup();
  }
});

test('runCrossPrRevertCheck honors an explicit baseRef without calling git merge-base', () => {
  const { repoDir, cleanup } = makeRepo();
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
    if (command.includes('git merge-base')) {
      throw new Error('git merge-base should not run when baseRef is provided');
    }
    return '';
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', (input) => {
    assert.equal(input.baseRef, 'explicit-base');
    return [];
  });

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      baseRef: 'explicit-base',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
  } finally {
    detectMock.mock.restore();
    execMock.mock.restore();
    cleanup();
  }
});

for (const message of [
  'fatal: couldn\'t find remote ref auto/integration',
  'error: origin/auto/integration does not exist',
]) {
  test(`runCrossPrRevertCheck treats "${message}" as a missing integration ref`, () => {
    const { repoDir, cleanup } = makeRepo();
    const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
      if (command.includes('git merge-base')) {
        throw new Error(message);
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', () => {
      throw new Error('detectCrossPrReverts should not run when integration ref is missing');
    });

    try {
      const result = runCrossPrRevertCheck({
        repoDir,
        acknowledgementText: '',
      });

      assert.equal(result.blocked, false);
      assert.equal(result.reverts.length, 0);
    } finally {
      detectMock.mock.restore();
      execMock.mock.restore();
      cleanup();
    }
  });
}

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
