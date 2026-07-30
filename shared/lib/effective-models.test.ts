import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  projectChallengeCandidates,
  projectEffectiveModel,
  projectRouterCandidates,
} from './effective-models.ts';
import type { ModelRegistry, NativeProviderName } from './model-registry.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './native-agent/certification/schema.ts';

const NOW = new Date('2026-07-12T12:00:00.000Z');

function withGlobalRoot<T>(fn: (root: string) => T): T {
  const temp = mkdtempSync(join(tmpdir(), 'effective-models-'));
  const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(temp, 'global-certifications');
  try {
    return fn(process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
    } else {
      process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

function registry(modelId: string, provider: NativeProviderName = 'openai', suiteVersion = 'v1'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: provider,
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 60, planning: 70, coding: 80, review: 75, classify: 50 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        nativeCapability: {
          nativeProvider: provider,
          piTransportKind: provider === 'openai' ? 'openai-responses' : 'openai-completions',
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: 'workflow',
            certifiedAt: NOW.toISOString(),
            certificationSuiteVersion: suiteVersion,
          },
        },
      },
    },
    ladders: {},
  };
}

function writeArtifact(
  provider: string,
  model: string,
  suiteVersion = 'v1',
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const path = buildGlobalCertificationPath(provider, model, suiteVersion);
  mkdirSync(join(path, '..'), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider,
    model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact));
  return path;
}

describe('effective model projection', () => {
  it('normalizes Wavemill aliases and raw OpenRouter IDs to one storage identity', () => withGlobalRoot(() => {
    writeArtifact('z-ai', 'glm-5.2');
    const alias = projectEffectiveModel({
      modelId: 'glm-5.2',
      stage: 'coder',
      registry: registry('glm-5.2', 'openrouter'),
      repoDir: '/tmp/consumer-a',
      now: NOW,
    });
    const raw = projectEffectiveModel({
      modelId: 'z-ai/glm-5.2',
      stage: 'coder',
      registry: registry('z-ai/glm-5.2', 'openrouter'),
      repoDir: '/tmp/consumer-b',
      now: NOW,
    });

    assert.equal(alias.eligible, true);
    assert.equal(raw.eligible, true);
    assert.equal(alias.identity.storageProvider, 'z-ai');
    assert.equal(raw.identity.storageModel, 'glm-5.2');
    assert.equal(alias.certification.artifactPath, raw.certification.artifactPath);
  }));

  it('maps stages to required certification phases', () => withGlobalRoot(() => {
    writeArtifact('openai', 'native-model', 'v1', { phase: 'workflow' });
    const reg = registry('native-model');

    assert.equal(projectEffectiveModel({ modelId: 'native-model', stage: 'reviewer', registry: reg, now: NOW }).certification.requiredPhase, 'read-only');
    assert.equal(projectEffectiveModel({ modelId: 'native-model', stage: 'implementation', registry: reg, now: NOW }).certification.requiredPhase, 'patch');
    assert.equal(projectEffectiveModel({ modelId: 'native-model', stage: 'plan', registry: reg, now: NOW }).certification.requiredPhase, 'workflow');
  }));

  it('uses one global artifact root across consumer repositories', () => withGlobalRoot((root) => {
    const artifactPath = writeArtifact('openai', 'native-model');
    const reg = registry('native-model');
    const a = projectRouterCandidates({ models: ['native-model'], role: 'coder', registry: reg, repoDir: join(root, '..', 'repo-a'), now: NOW });
    const b = projectRouterCandidates({ models: ['native-model'], role: 'coder', registry: reg, repoDir: join(root, '..', 'repo-b'), now: NOW });

    assert.deepEqual(a.eligible, ['native-model']);
    assert.deepEqual(b.eligible, ['native-model']);
    assert.equal(a.projections[0]?.certification.artifactPath, artifactPath);
    assert.equal(b.projections[0]?.certification.artifactScope, 'global');
  }));

  it('classifies artifact failure modes with stable reason codes', () => withGlobalRoot(() => {
    const cases: Array<[string, Partial<NativeCertificationArtifact> | string, string]> = [
      ['wrong-suite', { suiteVersion: 'v0' }, 'wrong_suite'],
      ['stale', { certifiedAt: new Date(NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString() }, 'stale_artifact'],
      ['insufficient', { phase: 'read-only' as CertificationPhase }, 'insufficient_phase'],
      ['scenario', { scenarios: [{ scenarioId: 's1', passed: false }] }, 'scenario_failure'],
      ['wrong-identity', { provider: 'openai', model: 'different-model' }, 'wrong_identity'],
    ];

    for (const [model, overrides, reason] of cases) {
      writeArtifact('openai', model, 'v1', overrides as Partial<NativeCertificationArtifact>);
      const row = projectEffectiveModel({ modelId: model, stage: 'coder', registry: registry(model), now: NOW });
      assert.equal(row.primaryReason, reason);
    }

    const malformedPath = buildGlobalCertificationPath('openai', 'malformed', 'v1');
    mkdirSync(join(malformedPath, '..'), { recursive: true });
    writeFileSync(malformedPath, '{ invalid json');
    assert.equal(projectEffectiveModel({ modelId: 'malformed', stage: 'coder', registry: registry('malformed'), now: NOW }).primaryReason, 'malformed_artifact');
    assert.equal(projectEffectiveModel({ modelId: 'missing', stage: 'coder', registry: registry('missing'), now: NOW }).primaryReason, 'missing_artifact');
  }));

  it('fails implementation challenge candidates when patch coding is not enabled', () => withGlobalRoot(() => {
    writeArtifact('openai', 'native-model', 'v1', { phase: 'patch' });
    const result = projectChallengeCandidates({
      models: ['native-model'],
      stage: 'implementation',
      registry: registry('native-model'),
      repoDir: '/tmp/consumer',
      now: NOW,
    });

    assert.deepEqual(result.eligible, []);
    assert.equal(result.projections[0]?.primaryReason, 'patch_coding_disabled');
    assert.equal(result.rejected[0]?.reason, 'no-native-capability');
  }));
});
