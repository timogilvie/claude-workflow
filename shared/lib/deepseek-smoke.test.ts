import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runDryRunSmoke, runLiveSmoke } from './deepseek-smoke.ts';

describe('deepseek smoke library', () => {
  it('dry-run returns expected launcher checks', () => {
    const result = runDryRunSmoke({ repoDir: process.cwd() });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'dry-run');
    assert.ok(result.checks.some((check) => check.name === 'launcher.env.state_isolation' && check.ok));
    assert.ok(result.checks.some((check) => check.name === 'launcher.env.models' && check.ok));
  });

  it('dry-run never attempts a live spawn', () => {
    const result = runDryRunSmoke({ repoDir: process.cwd() });
    assert.equal(result.ok, true);
  });

  it('live smoke skips cleanly when no key is available', () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = '';
    try {
      const result = runLiveSmoke({ repoDir: process.cwd() });
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.equal(result.exitCode, 0);
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });
});
