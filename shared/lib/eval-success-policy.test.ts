import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import {
  DEFAULT_SUCCESS_THRESHOLD,
  finalizeEvalSuccess,
  getSuccessThreshold,
  isEvalSuccess,
  SUCCESS_POLICY_VERSION,
} from './eval-success-policy.ts';

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'eval-success-policy-'));
}

describe('eval-success-policy', () => {
  it('exports the current policy version and default threshold', () => {
    assert.equal(SUCCESS_POLICY_VERSION, '1');
    assert.equal(DEFAULT_SUCCESS_THRESHOLD, 0.8);
  });

  it('prefers explicit success over score fallback', () => {
    assert.equal(isEvalSuccess({ score: 0.1, outcomes: { success: true } }), true);
    assert.equal(isEvalSuccess({ score: 1, outcomes: { success: false } }), false);
  });

  it('uses the default threshold when outcomes.success is missing', () => {
    assert.equal(isEvalSuccess({ score: 0.8 }), true);
    assert.equal(isEvalSuccess({ score: 0.7 }), false);
  });

  it('finalizes placeholder success values from score', () => {
    assert.equal(finalizeEvalSuccess({ score: 0.96, outcomes: { success: false } }), true);
    assert.equal(finalizeEvalSuccess({ score: 0.7, outcomes: { success: true } }), false);
  });

  it('returns false when no success signals are present', () => {
    assert.equal(isEvalSuccess({ outcomes: { success: null }, score: null }), false);
    assert.equal(isEvalSuccess(undefined), false);
  });

  it('supports explicit threshold overrides', () => {
    assert.equal(isEvalSuccess({ score: 0.7 }, { threshold: 0.7 }), true);
    assert.equal(isEvalSuccess({ score: 0.7 }, { threshold: 0.9 }), false);
  });

  it('reads the configured threshold from repo config', () => {
    const repoDir = makeTempRepo();
    try {
      clearConfigCache();
      writeFileSync(
        join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ eval: { successThreshold: 0.65 } }),
        'utf-8',
      );

      assert.equal(getSuccessThreshold(repoDir), 0.65);
      assert.equal(isEvalSuccess({ score: 0.7 }, { repoDir }), true);
      assert.equal(isEvalSuccess({ score: 0.6 }, { repoDir }), false);
    } finally {
      clearConfigCache();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
