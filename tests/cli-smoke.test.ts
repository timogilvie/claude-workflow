/**
 * CLI smoke tests for the wavemill entry point.
 *
 * Verifies command routing, help/version output, and graceful failure
 * on missing dependencies or unknown commands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAVEMILL = resolve(__dirname, '..', 'wavemill');

function run(args: string[], env?: Record<string, string>): string {
  return execFileSync(WAVEMILL, args, {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

function runExpectFail(args: string[], env?: Record<string, string>): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(WAVEMILL, args, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('wavemill CLI', () => {
  describe('help and version', () => {
    it('shows help with no arguments', () => {
      const out = run([]);
      assert.match(out, /Usage:/);
      assert.match(out, /Commands:/);
    });

    it('shows help with "help" command', () => {
      const out = run(['help']);
      assert.match(out, /Wavemill/);
      assert.match(out, /mill/);
      assert.match(out, /expand/);
      assert.match(out, /plan/);
      assert.match(out, /review/);
      assert.match(out, /eval/);
    });

    it('shows help with --help flag', () => {
      const out = run(['--help']);
      assert.match(out, /Usage:/);
    });

    it('shows version with "version" command', () => {
      const out = run(['version']);
      assert.match(out, /Wavemill v\d+\.\d+\.\d+/);
    });

    it('shows version with --version flag', () => {
      const out = run(['--version']);
      assert.match(out, /Wavemill v\d+\.\d+\.\d+/);
    });
  });

  describe('unknown commands', () => {
    it('exits 1 for unknown command', () => {
      const result = runExpectFail(['nosuchcommand']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown command/);
    });
  });

  describe('dependency checks', () => {
    it('mill reports missing tmux when not on PATH', () => {
      // Use a minimal PATH that excludes tmux
      const result = runExpectFail(['mill'], {
        PATH: '/usr/bin:/bin',
        SKIP_CONTEXT_CHECK: 'true',
        HOME: process.env.HOME ?? '',
      });
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /tmux|required|not found/i);
    });
  });
});
