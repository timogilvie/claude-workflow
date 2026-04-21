import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(__dirname, 'resource-lifecycle.ts');

function run(args: string[], cwd?: string): string {
  return execFileSync('npx', ['tsx', TOOL, ...args], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env },
  });
}

function runFail(args: string[], cwd?: string): { status: number; stderr: string; stdout: string } {
  try {
    return { status: 0, stderr: '', stdout: run(args, cwd) };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      stderr: error.stderr?.toString() ?? '',
      stdout: error.stdout?.toString() ?? '',
    };
  }
}

describe('resource-lifecycle CLI', () => {
  it('shows help', () => {
    const output = run(['--help']);
    assert.match(output, /resource-lifecycle/);
    assert.match(output, /Usage:/);
  });

  it('fails on unknown subcommand', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'resource-lifecycle-cli-'));
    try {
      const result = runFail(['bogus', '--repo-dir', repoDir], repoDir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown subcommand/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
