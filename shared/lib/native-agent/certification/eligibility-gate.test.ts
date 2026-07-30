import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../../model-registry.ts';
import {
  buildGlobalCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  evaluateNativeProviderGate,
  type CertificationPhase,
  type NativeCertificationArtifact,
  type NativeGateInput,
} from './index.ts';

const FIXED_NOW = new Date('2026-07-12T12:00:00.000Z');

function makeRegistry(modelId: string, provider: 'openai' | 'openrouter', suiteVersion = 'v1'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: provider,
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
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
            certifiedAt: FIXED_NOW.toISOString(),
            certificationSuiteVersion: suiteVersion,
          },
        },
      },
    },
    ladders: {},
  };
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'eligibility-gate-'));
  const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(repoDir, 'global-native-agent-certifications');
  return {
    repoDir,
    cleanup: () => {
      if (previousRoot === undefined) {
        delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
      } else {
        process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
      }
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function taskInput(
  registry: ModelRegistry,
  modelId: string,
  repoDir: string,
  overrides: Partial<NativeGateInput> = {},
): NativeGateInput {
  return {
    modelId,
    mode: 'task',
    requiredPhase: 'read-only',
    registry,
    repoDir,
    apiKeyPresent: true,
    apiKeyEnv: 'TEST_API_KEY',
    now: FIXED_NOW,
    ...overrides,
  };
}

function writeArtifact(
  repoDir: string,
  provider: 'openai' | 'openrouter',
  modelId: string,
  suiteVersion: string,
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const path = buildGlobalCertificationPath(provider, modelId, suiteVersion);
  mkdirSync(dirname(path), { recursive: true });
  const openRouterIdentity = provider === 'openrouter'
    ? (modelId.includes('/') ? modelId.split('/') : ['z-ai', modelId])
    : null;
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: openRouterIdentity ? openRouterIdentity[0]! : provider,
    model: openRouterIdentity ? openRouterIdentity[1]! : modelId,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf8');
  return path;
}

describe('evaluateNativeProviderGate', () => {
  it('rejects missing API keys before registry or filesystem checks', () => {
    const decision = evaluateNativeProviderGate({
      modelId: 'gpt-4o',
      mode: 'task',
      requiredPhase: 'read-only',
      registry: { models: {}, ladders: {} },
      repoDir: '/tmp/unused',
      apiKeyPresent: false,
      apiKeyEnv: 'OPENAI_API_KEY',
      now: FIXED_NOW,
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'missing_api_key');
    assert.match(decision.message, /apiKeyEnv=OPENAI_API_KEY/);
  });

  it('rejects unregistered models without requiring artifact access', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const decision = evaluateNativeProviderGate(taskInput({ models: {}, ladders: {} }, 'missing-model', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'unregistered_model');
      assert.match(decision.message, /nativeCapability=unregistered/);
    } finally {
      cleanup();
    }
  });

  it('allows certification mode without an artifact', () => {
    const registry = makeRegistry('gpt-4o', 'openai');

    const decision = evaluateNativeProviderGate({
      modelId: 'gpt-4o',
      mode: 'certification',
      registry,
      apiKeyPresent: true,
      apiKeyEnv: 'OPENAI_API_KEY',
    });

    assert.deepEqual(decision, {
      ok: true,
      modelId: 'gpt-4o',
      nativeProvider: 'openai',
      certified: false,
    });
  });

  it('requires requiredPhase in task mode', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      assert.throws(
        () => evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, { requiredPhase: undefined })),
        /requiredPhase is required/,
      );
    } finally {
      cleanup();
    }
  });

  it('does not require repoDir in task mode when global storage is configured', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, { repoDir: undefined }));
      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'missing_artifact');
      assert.match(decision.artifactPath ?? '', /global-native-agent-certifications\/openai\/gpt-4o\/v1\.json$/);
    } finally {
      cleanup();
    }
  });

  it('maps missing artifacts to missing_artifact with a resolved path', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'missing_artifact');
      assert.match(decision.artifactPath ?? '', /global-native-agent-certifications\/openai\/gpt-4o\/v1\.json$/);
    } finally {
      cleanup();
    }
  });

  it('maps malformed artifacts to malformed_artifact', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const path = buildGlobalCertificationPath('openai', 'gpt-4o', 'v1');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'not json', 'utf8');

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'malformed_artifact');
    } finally {
      cleanup();
    }
  });

  it('rejects wrong suite before staleness', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai', 'v1');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        suiteVersion: 'v0',
        certifiedAt: new Date(FIXED_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'wrong_suite');
      assert.equal(decision.foundSuiteVersion, 'v0');
    } finally {
      cleanup();
    }
  });

  it('rejects stale artifacts at the TTL boundary', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'stale_artifact');
    } finally {
      cleanup();
    }
  });

  it('rejects insufficient phases', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { phase: 'read-only' });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir, { requiredPhase: 'workflow' }));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'insufficient_phase');
      assert.equal(decision.foundPhase, 'read-only');
    } finally {
      cleanup();
    }
  });

  it('treats scenario failures as insufficient phase readiness', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        scenarios: [{ scenarioId: 's1', passed: false, failureMessage: 'boom' }],
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'insufficient_phase');
    } finally {
      cleanup();
    }
  });

  it('returns ready decisions with the loaded artifact for certified task-mode models', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      const path = writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', { phase: 'patch' });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, true);
      assert.equal(decision.certified, true);
      assert.equal(decision.nativeProvider, 'openai');
      assert.equal(decision.storagePath, path);
      assert.equal(decision.artifact?.phase, 'patch');
    } finally {
      cleanup();
    }
  });

  it('resolves openrouter aliases and raw IDs to the same storage identity', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const aliasRegistry = makeRegistry('glm-5.2', 'openrouter');
      const rawRegistry = makeRegistry('z-ai/glm-5.2', 'openrouter');
      const path = writeArtifact(repoDir, 'openrouter', 'z-ai/glm-5.2', 'v1');

      const aliasDecision = evaluateNativeProviderGate(taskInput(aliasRegistry, 'glm-5.2', repoDir));
      const rawDecision = evaluateNativeProviderGate(taskInput(rawRegistry, 'z-ai/glm-5.2', repoDir));

      assert.equal(aliasDecision.ok, true);
      assert.equal(rawDecision.ok, true);
      assert.equal(aliasDecision.storagePath, path);
      assert.equal(rawDecision.storagePath, path);
    } finally {
      cleanup();
    }
  });

  it('rejects artifacts whose on-disk identity does not match the resolved storage identity', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('glm-5.2', 'openrouter');
      writeArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1', {
        provider: 'openrouter',
        model: 'glm-5.2',
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'glm-5.2', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'missing_artifact');
    } finally {
      cleanup();
    }
  });

  it('rejects missing registry suite metadata as missing_artifact', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      delete registry.models['gpt-4o']?.nativeCapability?.certification?.certificationSuiteVersion;

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'missing_artifact');
    } finally {
      cleanup();
    }
  });

  it('keeps fresh lower-bound artifacts ready before the TTL cutoff', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = makeRegistry('gpt-4o', 'openai');
      writeArtifact(repoDir, 'openai', 'gpt-4o', 'v1', {
        certifiedAt: new Date(FIXED_NOW.getTime() - 59 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const decision = evaluateNativeProviderGate(taskInput(registry, 'gpt-4o', repoDir));

      assert.equal(decision.ok, true);
      assert.equal(decision.certified, true);
    } finally {
      cleanup();
    }
  });
});
