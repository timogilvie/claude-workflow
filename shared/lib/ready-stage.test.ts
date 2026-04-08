import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReadyStage, type ReadyResult } from './ready-stage.ts';

describe('ready-stage', () => {
  describe('runReadyStage', () => {
    it('returns valid ReadyResult shape', async () => {
      const result = await runReadyStage({
        prNumber: 42,
        repoDir: '/tmp/test',
      });

      assert.equal(typeof result.prNumber, 'number');
      assert.equal(result.prNumber, 42);
      assert.ok(['pass', 'fail', 'warn'].includes(result.verdict));
      assert.ok(Array.isArray(result.checks));
      assert.equal(typeof result.timestamp, 'string');
      assert.equal(typeof result.summary, 'string');
    });

    it('stub returns passing verdict', async () => {
      const result = await runReadyStage({
        prNumber: 123,
        repoDir: '/tmp/test',
      });

      assert.equal(result.verdict, 'pass');
      assert.equal(result.checks.length, 0);
    });

    it('timestamp is valid ISO 8601', async () => {
      const result = await runReadyStage({
        prNumber: 1,
        repoDir: '/tmp/test',
      });

      const date = new Date(result.timestamp);
      assert.ok(!isNaN(date.getTime()));
    });
  });
});
