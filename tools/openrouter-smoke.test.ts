import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

function runSmoke(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync('npx', ['tsx', 'tools/openrouter-smoke.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      OPENROUTER_API_KEY: '',
      OPENROUTER_LIVE_SMOKE: '',
      ...env,
    },
  });
}

describe('openrouter-smoke tool', () => {
  it('defaults to a dry-run that succeeds without environment configuration', () => {
    const result = runSmoke([]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^dry-run:/m);
    assert.doesNotMatch(result.stdout, /BLOCKER/);
  });

  it('emits machine-readable JSON output', () => {
    const result = runSmoke(['--json']);

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(Array.isArray(parsed.reports), true);
    assert.ok(parsed.reports.length >= 25);
  });

  it('skips live runs cleanly when the env gate is missing', () => {
    const result = runSmoke(['--live']);

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /OPENROUTER_LIVE_SMOKE=1 and OPENROUTER_API_KEY are required/,
    );
  });
});
