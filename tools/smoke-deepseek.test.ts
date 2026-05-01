import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('smoke-deepseek tool', () => {
  it('dry-run mode (default) exits 0 and shows plan without requiring API key', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: '',
      },
    });

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('Dry Run'));
    assert.ok(result.stdout.includes('Command:'));
    assert.ok(result.stdout.includes('ANTHROPIC_BASE_URL'));
    assert.ok(result.stdout.includes('ANTHROPIC_AUTH_TOKEN'));
    assert.ok(!result.stdout.includes('deepseek-secret-value'));
  });

  it('--live without API key exits 0 with skip message', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts', '--live'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: '',
      },
    });

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('skipping'));
    assert.ok(result.stdout.includes('DEEPSEEK_API_KEY'));
  });

  it('--live with API key and stub succeeds without leaking secret', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts', '--live'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'deepseek-secret-value',
        WAVEMILL_DEEPSEEK_SMOKE_STUB: '1',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'OK');
    assert.ok(!result.stdout.includes('deepseek-secret-value'));
    assert.ok(!result.stderr.includes('deepseek-secret-value'));
  });

  it('--help shows usage and exits 0', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: process.env,
    });

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('Usage:'));
    assert.ok(result.stdout.includes('--live'));
  });

  it('unknown args exit 1 with error message', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts', '--invalid'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: process.env,
    });

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Unknown arguments'));
  });
});
