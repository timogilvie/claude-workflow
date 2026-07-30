import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCertificationPath,
  buildGlobalCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './native-agent/certification/index.ts';
import { evaluateNativeProviderGate } from './native-agent/certification/eligibility-gate.ts';
import type { ModelRegistry } from './model-registry.ts';
import {
  requiredCertificationPhaseForEffectiveStage,
  resolveEffectiveModel,
  selectEffectiveChallengeCandidates,
  selectEffectiveRouterCandidates,
} from './effective-models.ts';

const FIXED_NOW = new Date('2026-07-12T12:00:00.000Z');

function withGlobalRoot(fn: (repoDirA: string, repoDirB: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'effective-models-'));
  const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(tmp, 'global-certs');
  try {
    fn(join(tmp, 'repo-a'), join(tmp, 'repo-b'));
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
    } else {
      process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function makeRegistry(modelId = 'native-test', provider: 'openai' | 'openrouter' = 'openai'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: provider,
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
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
            certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
            certificationSuiteVersion: 'v1',
          },
        },
        supportedModel: {
          wavemillAlias: modelId,
          stages: ['planning', 'coding', 'review'],
        },
      },
    },
    ladders: {},
  };
}

function writeGlobalArtifact(
  provider: string,
  model: string,
  suiteVersion = 'v1',
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const path = buildGlobalCertificationPath(provider, model, suiteVersion);
  mkdirSync(dirname(path), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider,
    model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf8');
  return path;
}

function primaryReason(model: ReturnType<typeof resolveEffectiveModel>): string | undefined {
  return model.exclusions[0]?.code;
}

describe('effective model projection', () => {
  it('normalizes OpenRouter aliases and raw IDs to the same artifact identity', () => {
    withGlobalRoot((repoDir) => {
      const registry = makeRegistry('qwen-3-coder', 'openrouter');
      writeGlobalArtifact('qwen', 'qwen3-coder', 'v1', { phase: 'patch' });

      const alias = resolveEffectiveModel({ modelId: 'qwen-3-coder', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false });
      const raw = resolveEffectiveModel({ modelId: 'qwen/qwen3-coder', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false });

      assert.equal(alias.usable, true);
      assert.equal(raw.usable, true);
      assert.equal(alias.identity.canonicalAlias, 'qwen-3-coder');
      assert.deepEqual(
        [alias.identity.artifactProvider, alias.identity.artifactModel],
        [raw.identity.artifactProvider, raw.identity.artifactModel],
      );
      assert.match(alias.artifact.path ?? '', /global-certs\/qwen\/qwen3-coder\/v1\.json$/);
    });
  });

  it('maps stages to required certification phases', () => {
    const registry = makeRegistry();
    assert.equal(requiredCertificationPhaseForEffectiveStage('planner', 'native-test', registry), 'workflow');
    assert.equal(requiredCertificationPhaseForEffectiveStage('implementation', 'native-test', registry), 'patch');
    assert.equal(requiredCertificationPhaseForEffectiveStage('reviewer', 'native-test', registry), 'read-only');
  });

  it('fails closed for local-only legacy artifacts', () => {
    withGlobalRoot((repoDir) => {
      const registry = makeRegistry();
      const localPath = buildCertificationPath(repoDir, 'openai', 'native-test', 'v1');
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify({
        schemaVersion: CERTIFICATION_SCHEMA_VERSION,
        provider: 'openai',
        model: 'native-test',
        phase: 'workflow',
        suiteVersion: 'v1',
        certifiedAt: FIXED_NOW.toISOString(),
        scenarios: [{ scenarioId: 's1', passed: true }],
      }));

      const projected = resolveEffectiveModel({ modelId: 'native-test', stage: 'planning', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false });
      assert.equal(projected.usable, false);
      assert.equal(primaryReason(projected), 'missing-artifact');
      assert.match(projected.artifact.path ?? '', /global-certs\/openai\/native-test\/v1\.json$/);
    });
  });

  it('returns the same candidate set across two repos sharing one global artifact root', () => {
    withGlobalRoot((repoDirA, repoDirB) => {
      const registry = makeRegistry();
      writeGlobalArtifact('openai', 'native-test', 'v1', { phase: 'workflow' });
      const a = selectEffectiveRouterCandidates({ models: ['native-test'], role: 'planner', registry, repoDir: repoDirA, now: FIXED_NOW });
      const b = selectEffectiveRouterCandidates({ models: ['native-test'], role: 'planner', registry, repoDir: repoDirB, now: FIXED_NOW });
      assert.deepEqual(a.eligible, ['native-test']);
      assert.deepEqual(b.eligible, ['native-test']);
      assert.equal(a.candidates[0]?.artifact.path, b.candidates[0]?.artifact.path);
    });
  });

  it('reports common global artifact failure modes as typed reasons', () => {
    withGlobalRoot((repoDir) => {
      const registry = makeRegistry();
      assert.equal(primaryReason(resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false })), 'missing-artifact');

      writeGlobalArtifact('openai', 'native-test', 'v1', { phase: 'read-only' });
      assert.equal(primaryReason(resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false })), 'insufficient-phase');

      writeGlobalArtifact('openai', 'native-test', 'v1', { suiteVersion: 'v0' });
      assert.equal(primaryReason(resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false })), 'wrong-suite');

      writeGlobalArtifact('openai', 'native-test', 'v1', {
        certifiedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
      });
      assert.equal(primaryReason(resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false })), 'stale-artifact');

      writeGlobalArtifact('openai', 'native-test', 'v1', {
        phase: 'patch',
        scenarios: [{ scenarioId: 's1', passed: false }],
      });
      assert.equal(primaryReason(resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false })), 'scenario-failure');

      const path = buildGlobalCertificationPath('openai', 'native-test', 'v1');
      writeFileSync(path, '{ bad json', 'utf8');
      assert.equal(primaryReason(resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false })), 'malformed-artifact');
    });
  });

  it('keeps provider gate and projection reasons consistent', () => {
    withGlobalRoot((repoDir) => {
      const registry = makeRegistry();
      const projected = resolveEffectiveModel({ modelId: 'native-test', stage: 'coding', registry, repoDir, now: FIXED_NOW, apiKeyPresent: true, checkRuntime: false });
      const gated = evaluateNativeProviderGate({
        modelId: 'native-test',
        mode: 'task',
        requiredPhase: 'patch' satisfies CertificationPhase,
        registry,
        repoDir,
        now: FIXED_NOW,
        apiKeyPresent: true,
        apiKeyEnv: 'TEST_API_KEY',
      });

      assert.equal(primaryReason(projected), 'missing-artifact');
      assert.equal(gated.ok, false);
      assert.equal(gated.reason, 'missing_artifact');
    });
  });

  it('challenge implementation candidates require patch-coding readiness', () => {
    withGlobalRoot((repoDir) => {
      const registry = makeRegistry();
      writeGlobalArtifact('openai', 'native-test', 'v1', { phase: 'patch' });
      const selected = selectEffectiveChallengeCandidates({
        models: ['native-test'],
        stage: 'implementation',
        registry,
        repoDir,
        now: FIXED_NOW,
      });
      assert.deepEqual(selected.eligible, []);
      assert.equal(selected.rejected[0]?.exclusions[0]?.code, 'patch-coding-disabled');
    });
  });
});

