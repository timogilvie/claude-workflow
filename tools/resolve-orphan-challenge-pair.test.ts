import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
// CLI tests for tools/resolve-orphan-challenge-pair.ts --reason validation (HOK-2773).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function makeRepoDir(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resolve-orphan-tool-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );
  return repoDir;
}

function cleanup(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

function runTool(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', 'tools/resolve-orphan-challenge-pair.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('resolve-orphan-challenge-pair tool', () => {
  it('rejects an unsupported --reason value and lists the canonical reasons', () => {
    const repoDir = makeRepoDir();
    try {
      const result = runTool(['--pair-id', 'HOK-9999', '--reason', 'foo-bar', '--repo-dir', repoDir, '--dry-run']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported --reason value: foo-bar/);
      assert.match(result.stderr, /both-challenge-aborted/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('accepts --reason both-challenge-aborted on a pair absent from state (dry-run skip)', () => {
    const repoDir = makeRepoDir();
    try {
      const result = runTool(['--pair-id', 'HOK-9999', '--reason', 'both-challenge-aborted', '--repo-dir', repoDir, '--dry-run']);
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, 'skipped');
      assert.match(parsed.reason, /not present in workflow state/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('accepts --reason sibling-challenge-aborted on a pair absent from state (dry-run skip)', () => {
    const repoDir = makeRepoDir();
    try {
      const result = runTool(['--pair-id', 'HOK-9999', '--reason', 'sibling-challenge-aborted', '--repo-dir', repoDir, '--dry-run']);
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, 'skipped');
    } finally {
      cleanup(repoDir);
    }
  });
});
