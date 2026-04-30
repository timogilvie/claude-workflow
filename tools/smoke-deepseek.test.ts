import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('smoke-deepseek tool', () => {
  it('exits 2 with the exact skip message when DEEPSEEK_API_KEY is missing', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: '',
      },
    });

    assert.equal(result.status, 2);
    assert.equal(result.stdout.trim(), 'DEEPSEEK_API_KEY not set; skipping smoke test');
  });

  it('supports a stubbed success path without leaking the API key', () => {
    const result = spawnSync('npx', ['tsx', 'tools/smoke-deepseek.ts'], {
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
});
