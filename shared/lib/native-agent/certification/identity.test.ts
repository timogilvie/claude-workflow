import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isValidCertificationPathSegment,
  resolveCertificationStorageIdentity,
} from './identity.ts';

describe('resolveCertificationStorageIdentity', () => {
  it('normalizes OpenRouter challenge aliases to canonical provider/model storage identity', () => {
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'qwen-3-coder'), {
      provider: 'qwen',
      model: 'qwen3-coder',
    });
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'glm-5.2'), {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'kimi-k2.7-code'), {
      provider: 'moonshotai',
      model: 'kimi-k2.7-code',
    });
  });

  it('normalizes provider aliases and mixed case for direct storage identities', () => {
    assert.deepEqual(resolveCertificationStorageIdentity('Z.AI', 'GLM-5.2'), {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
    assert.deepEqual(resolveCertificationStorageIdentity('Moonshot-AI', 'KIMI-K2.7-CODE'), {
      provider: 'moonshotai',
      model: 'kimi-k2.7-code',
    });
  });

  it('keeps OpenRouter IDs with slashes as safe two-segment storage paths', () => {
    assert.deepEqual(resolveCertificationStorageIdentity('openrouter', 'z-ai/glm-5.2'), {
      provider: 'z-ai',
      model: 'glm-5.2',
    });
  });

  it('rejects unsafe path segments', () => {
    assert.equal(isValidCertificationPathSegment('qwen3-coder'), true);
    assert.equal(isValidCertificationPathSegment('../qwen3-coder'), false);
    assert.equal(isValidCertificationPathSegment('qwen/qwen3-coder'), false);
    assert.equal(isValidCertificationPathSegment(''), false);
  });
});
