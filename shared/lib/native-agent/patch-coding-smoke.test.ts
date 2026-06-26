import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPatchCodingSmokeDryRun } from './patch-coding-smoke.ts';

describe('patch-coding-smoke', () => {
  it('produces a certification record across both providers in dry-run mode', async () => {
    const result = await runPatchCodingSmokeDryRun();

    assert.equal(result.outcome, 'ok');
    assert.equal(result.certification !== null, true);
    assert.equal(result.providersRun.length, 2);
    assert.deepEqual(
      result.providersRun.map((provider) => provider.provider).sort(),
      ['openai', 'openrouter'],
    );
    assert.ok(result.providersRun.every((provider) => provider.usageTokens > 0));
    assert.ok(result.providersRun.every((provider) => provider.toolCalls > 0));
    assert.match(result.certification!.smokeSuiteRevision, /^[a-f0-9]{64}$/);
  });
});
