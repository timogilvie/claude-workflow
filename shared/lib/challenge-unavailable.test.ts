import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildChallengeUnavailable } from './challenge-unavailable.ts';

describe('buildChallengeUnavailable', () => {
  it('emits the stable strict-challenge contract with exact blockers', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'challenge-unavailable-'));
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
        challenge: { enabled: true, rate: 1 },
        router: { defaultAgent: 'claude' },
        providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } },
      }), 'utf-8');

      const result = buildChallengeUnavailable({
        requestedRate: 1,
        pool: ['qwen-3-coder'],
        certifiedPool: [],
        primaryModel: 'qwen-3-coder',
        repoDir,
        nativeCertificationRejections: [{
          modelId: 'qwen-3-coder',
          role: 'coder',
          requestedLaunchPhase: 'coding',
          requestedPhase: 'patch',
          nativeCapability: 'certified',
          nativeProvider: 'openrouter',
          requiredSuiteVersion: 'v2',
          reason: 'missing-artifact',
          artifactPath: '/global/qwen/qwen3-coder/v2.json',
        }],
      });

      assert.equal(result.mode, 'challenge_unavailable');
      assert.equal(result.cleanupHint, 'no_worktree_created');
      assert.equal(result.requestedRate, 1);
      assert.equal(result.globalCatalogVersion, 'v2');
      assert.ok(result.blockers.some((blocker) => blocker.kind === 'insufficient_certified_pool'));
      assert.ok(result.blockers.some((blocker) => blocker.kind === 'primary_uncertifiable' && blocker.reason === 'missing-artifact'));
      assert.deepEqual(result.candidateDiagnostics, [{
        modelId: 'qwen-3-coder',
        provider: 'openrouter',
        reason: 'missing-artifact',
        artifactPath: '/global/qwen/qwen3-coder/v2.json',
      }]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
