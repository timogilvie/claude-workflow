import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectCrossPrReverts,
  detectSurvivingChangeWarnings,
  filterUnacknowledgedReverts,
  parseRevertAcknowledgements,
} from './cross-pr-revert-detector.ts';

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  writeFileSync(join(repoDir, path), contents);
  git(repoDir, `add ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function removeFile(repoDir: string, path: string, message: string): string {
  git(repoDir, `rm ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function mergePrBranch(
  repoDir: string,
  branch: string,
  prNumber: number,
  title: string,
): string {
  git(repoDir, `merge --no-ff ${shellQuote(branch)} -m ${shellQuote(`Merge pull request #${prNumber} from test/${branch}`)} -m ${shellQuote(title)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}');
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');
  git(repoDir, 'checkout -b auto/integration');
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

test('detectCrossPrReverts flags deletion of a file added by a recent integration PR', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live integration\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    const mergeCommit = mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    const baseRef = git(repoDir, 'merge-base auto/integration HEAD');
    const headRef = removeFile(repoDir, 'strategy.txt', 'Remove unrelated diff');

    const findings = detectCrossPrReverts({
      repoDir,
      baseRef,
      headRef,
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, [
      {
        prNumber: 437,
        title: 'Merge pull request #437 from test/pr-437',
        mergeCommit,
        files: [
          {
            path: 'strategy.txt',
            status: 'deleted',
            confidence: 'deleted',
          },
        ],
      },
    ]);
  } finally {
    cleanup();
  }
});

test('detectSurvivingChangeWarnings reports history-only PRs whose added files are absent from the promoted tree', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const mainBase = git(repoDir, 'rev-parse main');
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live integration\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    const findings = detectSurvivingChangeWarnings({
      repoDir,
      baseRef: mainBase,
      headRef: 'main',
      integrationRef: 'auto/integration',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].prNumber, 437);
    assert.equal(findings[0].files[0].path, 'strategy.txt');
    assert.equal(findings[0].files[0].confidence, 'missing-survivor');
  } finally {
    cleanup();
  }
});

test('detectCrossPrReverts ignores non-merge integration commits even when their subject mentions a PR number', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'strategy.txt', 'live integration\n', 'Restore strategy explorer (#437)');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    const baseRef = git(repoDir, 'merge-base auto/integration HEAD');
    const headRef = removeFile(repoDir, 'strategy.txt', 'Remove unrelated diff');

    const findings = detectCrossPrReverts({
      repoDir,
      baseRef,
      headRef,
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

test('parseRevertAcknowledgements accepts only explicit acknowledgement phrases', () => {
  const acknowledgements = parseRevertAcknowledgements(`
    Intentionally reverts #437
    removes unrelated diff from this PR
    reverts #438
  `);

  assert.deepEqual([...acknowledgements].sort((a, b) => a - b), [437, 438]);
});

test('filterUnacknowledgedReverts removes findings that were explicitly acknowledged', () => {
  const findings = [
    {
      prNumber: 437,
      files: [{ path: 'strategy.txt', status: 'deleted' as const, confidence: 'deleted' as const }],
    },
    {
      prNumber: 438,
      files: [{ path: 'router.ts', status: 'deleted' as const, confidence: 'deleted' as const }],
    },
  ];

  const remaining = filterUnacknowledgedReverts(findings, new Set([438]));
  assert.deepEqual(remaining, [findings[0]]);
});
