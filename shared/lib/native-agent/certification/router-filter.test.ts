/**
 * Unit tests for the native certification router filter.
 *
 * These tests cover filterNativeModels directly, verifying:
 * - Phase requirement mapping
 * - Non-native pass-through
 * - All rejection reason paths
 * - Diagnostic field completeness
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  filterNativeModels,
  STAGE_PHASE_REQUIREMENT,
  type RouterRole,
} from './router-filter.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  CERTIFICATION_TTL_DAYS,
} from './schema.ts';
import { buildGlobalCertificationPath } from './loader.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './storage.ts';
import type { ModelRegistry } from '../../model-registry.ts';
import { resolveOpenRouterModelIdentity, type RoleEligibility } from '../../openrouter-catalog.ts';

const OPENROUTER_PATCH_CASES = [
  {
    modelId: 'qwen/qwen3-coder',
    providerPath: 'qwen',
    modelPath: 'qwen3-coder',
    vendor: 'qwen',
    modelClass: 'strong_generalist' as const,
    qualityScores: { routing: 58, planning: 72, coding: 84, review: 78, classify: 58 },
    contextWindowTokens: 131_072,
    multimodal: { text: true, image: false },
    reasoningTier: 'standard' as const,
    inputCost: 0.35,
    outputCost: 1.05,
  },
  {
    modelId: 'z-ai/glm-5.2',
    providerPath: 'z-ai',
    modelPath: 'glm-5.2',
    vendor: 'z-ai',
    modelClass: 'frontier' as const,
    qualityScores: { routing: 60, planning: 80, coding: 80, review: 84, classify: 60 },
    contextWindowTokens: 1_048_576,
    multimodal: { text: true, image: false },
    reasoningTier: 'advanced' as const,
    inputCost: 0.93,
    outputCost: 3,
  },
  {
    modelId: 'moonshotai/kimi-k2.7-code',
    providerPath: 'moonshotai',
    modelPath: 'kimi-k2.7-code',
    vendor: 'kimi',
    modelClass: 'strong_generalist' as const,
    qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: true },
    reasoningTier: 'advanced' as const,
    inputCost: 0.74,
    outputCost: 3.5,
  },
] as const;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'router-filter-test-'));
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  return {
    repoDir,
    cleanup: () => {
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  overrides: Record<string, unknown> = {},
): void {
  const path = buildGlobalCertificationPath(provider, model, suiteVersion);
  mkdirSync(dirname(path), { recursive: true });
  const artifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider,
    model,
    phase: 'patch',
    suiteVersion,
    // 1 day ago — fresh
    certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact));
}

/** Minimal registry with one native and one non-native model */
function makeRegistry(nativeModelId: string, certPhase: string, suiteVersion: string): ModelRegistry {
  return {
    models: {
      [nativeModelId]: {
        vendor: 'openai',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: certPhase as 'read-only' | 'patch' | 'workflow',
            certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            certificationSuiteVersion: suiteVersion,
          },
        },
      },
      'non-native-model': {
        vendor: 'anthropic',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 200_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
      },
    },
    ladders: {},
  };
}

function makeOpenRouterRegistry(
  modelId: string,
  certPhase: 'read-only' | 'patch' | 'workflow',
  suiteVersion: string,
): ModelRegistry {
  const identity = resolveOpenRouterModelIdentity(modelId);
  assert.ok(identity, `expected launch-priority identity for ${modelId}`);

  return {
    models: {
      [modelId]: {
        vendor: identity.family,
        class: identity.family === 'glm' ? 'frontier' : 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 60, planning: 80, coding: 84, review: 82, classify: 60 },
        contextWindowTokens: identity.family === 'glm' ? 1_048_576 : 262_144,
        toolSupport: 'full',
        multimodal: { text: true, image: identity.family === 'kimi' },
        latencyTier: 'standard',
        reasoningTier: identity.family === 'qwen' ? 'standard' : 'advanced',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 3,
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          readOnlyNative: 'certified',
          compatFlags: { thinkingFormat: 'openrouter' },
          certification: {
            maxCertifiedPhase: certPhase,
            certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            certificationSuiteVersion: suiteVersion,
          },
        },
      },
    },
    ladders: {},
  };
}

// ---------------------------------------------------------------------------
// Phase requirement mapping
// ---------------------------------------------------------------------------

console.log('\n--- router-filter Unit Tests ---\n');

await test('STAGE_PHASE_REQUIREMENT has the correct phase for each role', () => {
  assert.equal(STAGE_PHASE_REQUIREMENT.reviewer, 'read-only');
  assert.equal(STAGE_PHASE_REQUIREMENT.coder, 'patch');
  assert.equal(STAGE_PHASE_REQUIREMENT.planner, 'workflow');
});

// ---------------------------------------------------------------------------
// Non-native pass-through
// ---------------------------------------------------------------------------

await test('non-native models are returned as eligible without cert checks', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry = makeRegistry('native-model', 'patch', 'v1');
    const result = filterNativeModels(
      ['non-native-model'],
      'coder',
      registry,
      repoDir,
    );
    assert.deepEqual(result.eligible, ['non-native-model']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

await test('model not in registry is treated as non-native and passes through', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry: ModelRegistry = { models: {}, ladders: {} };
    const result = filterNativeModels(['unknown-model'], 'coder', registry, repoDir);
    assert.deepEqual(result.eligible, ['unknown-model']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

await test('claude-openrouter entries without native capability are rejected fail-closed', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry: ModelRegistry = {
      models: {
        'mistral-large-2': {
          vendor: 'mistral',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 60, planning: 70, coding: 70, review: 70, classify: 60 },
          contextWindowTokens: 128_000,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 2,
          costPerMillionOutputTokensUsd: 6,
          agent: 'claude-openrouter',
        },
      },
      ladders: {},
    };

    const result = filterNativeModels(['mistral-large-2'], 'planner', registry, repoDir);
    assert.deepEqual(result.eligible, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.reason, 'no-native-capability');
  } finally {
    cleanup();
  }
});

await test('hosted codex entries without native capability still pass through', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry: ModelRegistry = {
      models: {
        'gpt-5.5': {
          vendor: 'openai',
          class: 'frontier',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 80, planning: 85, coding: 85, review: 85, classify: 80 },
          contextWindowTokens: 128_000,
          toolSupport: 'full',
          multimodal: { text: true, image: true },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 10,
          costPerMillionOutputTokensUsd: 30,
          agent: 'codex',
        },
      },
      ladders: {},
    };

    const result = filterNativeModels(['gpt-5.5'], 'reviewer', registry, repoDir);
    assert.deepEqual(result.eligible, ['gpt-5.5']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Valid certification paths
// ---------------------------------------------------------------------------

await test('read-only cert passes for reviewer role', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-ro', 'v1', { phase: 'read-only' });
    const registry = makeRegistry('native-ro', 'read-only', 'v1');
    const result = filterNativeModels(['native-ro'], 'reviewer', registry, repoDir);
    assert.deepEqual(result.eligible, ['native-ro']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

await test('patch cert passes for coder role', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-p', 'v1', { phase: 'patch' });
    const registry = makeRegistry('native-p', 'patch', 'v1');
    const result = filterNativeModels(['native-p'], 'coder', registry, repoDir);
    assert.deepEqual(result.eligible, ['native-p']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

await test('patch cert passes for reviewer role (patch satisfies read-only)', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-p', 'v1', { phase: 'patch' });
    const registry = makeRegistry('native-p', 'patch', 'v1');
    const result = filterNativeModels(['native-p'], 'reviewer', registry, repoDir);
    assert.deepEqual(result.eligible, ['native-p']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

await test('workflow cert passes for all roles', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const roles: RouterRole[] = ['planner', 'coder', 'reviewer'];
    for (const role of roles) {
      writeCertArtifact(repoDir, 'openai', 'native-wf', 'v1', { phase: 'workflow' });
      const registry = makeRegistry('native-wf', 'workflow', 'v1');
      const result = filterNativeModels(['native-wf'], role, registry, repoDir);
      assert.deepEqual(result.eligible, ['native-wf'], `expected eligible for role=${role}`);
      assert.deepEqual(result.rejected, [], `expected no rejections for role=${role}`);
    }
  } finally {
    cleanup();
  }
});

await test('openrouter aliases load certifications from mapped provider/model storage paths for eligible roles', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', 'v1', { phase: 'workflow' });
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': {
          vendor: 'qwen',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 58, planning: 72, coding: 84, review: 78, classify: 58 },
          contextWindowTokens: 131_072,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 0.35,
          costPerMillionOutputTokensUsd: 1.05,
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              certificationSuiteVersion: 'v1',
            },
          },
        },
      },
      ladders: {},
    };

    const result = filterNativeModels(['qwen-3-coder'], 'reviewer', registry, repoDir);
    assert.deepEqual(result.eligible, ['qwen-3-coder']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

await test('launch-priority roleEligibility rejects coding-only Qwen aliases for planner role', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'qwen', 'qwen-2.5-coder-32b-instruct', 'v1', { phase: 'workflow' });
    const registry: ModelRegistry = {
      models: {
        'qwen-2.5-coder-32b': {
          vendor: 'qwen',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 58, planning: 65, coding: 84, review: 70, classify: 58 },
          contextWindowTokens: 32_768,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 0.2,
          costPerMillionOutputTokensUsd: 0.6,
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              certificationSuiteVersion: 'v1',
            },
          },
        },
      },
      ladders: {},
    };

    const result = filterNativeModels(['qwen-2.5-coder-32b'], 'planner', registry, repoDir);
    assert.deepEqual(result.eligible, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.reason, 'role-ineligible');
    assert.equal(result.rejected[0]?.requestedLaunchPhase, 'planning');
    assert.equal(result.rejected[0]?.nativeProvider, 'openrouter');
    assert.deepEqual(result.rejected[0]?.eligibleRoles, ['coding']);
  } finally {
    cleanup();
  }
});

await test('nativeAgent.allowedPhases rejects configured native planning candidates before route selection', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['review'],
      },
    }));
    writeCertArtifact(repoDir, 'openai', 'native-workflow', 'v1', { phase: 'workflow' });
    const registry = makeRegistry('native-workflow', 'workflow', 'v1');

    const result = filterNativeModels(['native-workflow'], 'planner', registry, repoDir);
    assert.deepEqual(result.eligible, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.reason, 'phase-not-allowed');
    assert.equal(result.rejected[0]?.requestedLaunchPhase, 'planning');
    assert.deepEqual(result.rejected[0]?.allowedNativeAgentPhases, ['review']);
  } finally {
    cleanup();
  }
});

await test('native OpenRouter launch matrix covers Kimi, Qwen, and GLM aliases and raw ids', () => {
  const roleLaunchPhase: Record<RouterRole, RoleEligibility> = {
    planner: 'planning',
    coder: 'coding',
    reviewer: 'review',
  };
  const modelIds = [
    'qwen-3-coder',
    'qwen/qwen3-coder',
    'kimi-k2.7-code',
    'moonshotai/kimi-k2.7-code',
    'glm-5.2',
    'z-ai/glm-5.2',
  ];

  for (const modelId of modelIds) {
    const identity = resolveOpenRouterModelIdentity(modelId);
    assert.ok(identity, `expected launch-priority identity for ${modelId}`);
    const { repoDir, cleanup } = makeRepo();
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
        nativeAgent: {
          enabled: true,
          allowedPhases: ['planning', 'coding', 'review'],
        },
      }));
      writeCertArtifact(repoDir, identity.provider, identity.providerModel, 'v1', { phase: 'workflow' });
      const registry = makeOpenRouterRegistry(modelId, 'workflow', 'v1');

      for (const role of ['planner', 'coder', 'reviewer'] as const) {
        const result = filterNativeModels([modelId], role, registry, repoDir);
        const expectedEligible = identity.roleEligibility.includes(roleLaunchPhase[role]);
        if (expectedEligible) {
          assert.deepEqual(result.eligible, [modelId], `${modelId} should be eligible for ${role}`);
          assert.deepEqual(result.rejected, [], `${modelId} should not be rejected for ${role}`);
        } else {
          assert.deepEqual(result.eligible, [], `${modelId} should not be eligible for ${role}`);
          assert.equal(result.rejected.length, 1, `${modelId} should have one rejection for ${role}`);
          assert.equal(result.rejected[0]?.reason, 'role-ineligible');
          assert.deepEqual(result.rejected[0]?.eligibleRoles, identity.roleEligibility);
        }
      }
    } finally {
      cleanup();
    }
  }
});

for (const testCase of OPENROUTER_PATCH_CASES) {
  await test(`fresh patch artifact admits raw OpenRouter model ${testCase.modelId} for coder role`, () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertArtifact(repoDir, testCase.providerPath, testCase.modelPath, 'v1', { phase: 'patch' });
      const registry: ModelRegistry = {
        models: {
          [testCase.modelId]: {
            vendor: testCase.vendor,
            class: testCase.modelClass,
            strengths: [],
            weaknesses: [],
            qualityScores: testCase.qualityScores,
            contextWindowTokens: testCase.contextWindowTokens,
            toolSupport: 'full',
            multimodal: testCase.multimodal,
            latencyTier: 'standard',
            reasoningTier: testCase.reasoningTier,
            costPerMillionInputTokensUsd: testCase.inputCost,
            costPerMillionOutputTokensUsd: testCase.outputCost,
            nativeCapability: {
              nativeProvider: 'openrouter',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'certified',
              compatFlags: { thinkingFormat: 'openrouter' },
              certification: {
                maxCertifiedPhase: 'patch',
                certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                certificationSuiteVersion: 'v1',
              },
            },
          },
        },
        ladders: {},
      };

      const result = filterNativeModels([testCase.modelId], 'coder', registry, repoDir);
      assert.deepEqual(result.eligible, [testCase.modelId]);
      assert.deepEqual(result.rejected, []);
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Rejection reason: missing
// ---------------------------------------------------------------------------

await test('missing artifact rejects native model with reason=missing', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry = makeRegistry('native-miss', 'patch', 'v1');
    const result = filterNativeModels(['native-miss'], 'coder', registry, repoDir);
    assert.deepEqual(result.eligible, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, 'missing');
    assert.equal(result.rejected[0].modelId, 'native-miss');
    assert.equal(result.rejected[0].role, 'coder');
    assert.equal(result.rejected[0].requestedPhase, 'patch');
    assert.equal(result.rejected[0].requiredSuiteVersion, 'v1');
    assert.equal(result.rejected[0].nativeCapability, 'certified');
  } finally {
    cleanup();
  }
});

await test('missing registry certification metadata rejects with reason=missing', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry: ModelRegistry = {
      models: {
        'native-no-meta': {
          vendor: 'openai',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
          contextWindowTokens: 128_000,
          toolSupport: { functionCalling: true, streamingTools: true },
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 3,
          costPerMillionOutputTokensUsd: 15,
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            // No certification metadata
          },
        },
      },
      ladders: {},
    };
    const result = filterNativeModels(['native-no-meta'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'missing');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rejection reason: stale
// ---------------------------------------------------------------------------

await test('cert older than TTL is rejected with reason=stale', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const staleCertifiedAt = new Date(
      Date.now() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    writeCertArtifact(repoDir, 'openai', 'native-stale', 'v1', {
      phase: 'patch',
      certifiedAt: staleCertifiedAt,
    });
    const registry = makeRegistry('native-stale', 'patch', 'v1');
    const result = filterNativeModels(['native-stale'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'stale');
  } finally {
    cleanup();
  }
});

await test('cert with explicit expiresAt in the past is rejected with reason=stale', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-expired', 'v1', {
      phase: 'patch',
      // certifiedAt is fresh but expiresAt is in the past
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const registry = makeRegistry('native-expired', 'patch', 'v1');
    const result = filterNativeModels(['native-expired'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'stale');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rejection reason: wrong-suite
// ---------------------------------------------------------------------------

await test('suiteVersion mismatch rejects with reason=wrong-suite', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // Registry expects v2, artifact has v1
    writeCertArtifact(repoDir, 'openai', 'native-ws', 'v2', {
      phase: 'patch',
      suiteVersion: 'v1',
    });
    const registry = makeRegistry('native-ws', 'patch', 'v2');
    const result = filterNativeModels(['native-ws'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'wrong-suite');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rejection reason: insufficient-phase
// ---------------------------------------------------------------------------

await test('read-only cert rejects for coder role (requires patch)', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-ro2', 'v1', { phase: 'read-only' });
    const registry = makeRegistry('native-ro2', 'read-only', 'v1');
    const result = filterNativeModels(['native-ro2'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'insufficient-phase');
    assert.equal(result.rejected[0].certifiedPhase, 'read-only');
    assert.equal(result.rejected[0].requestedPhase, 'patch');
  } finally {
    cleanup();
  }
});

await test('patch cert rejects for planner role (requires workflow)', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-p2', 'v1', { phase: 'patch' });
    const registry = makeRegistry('native-p2', 'patch', 'v1');
    const result = filterNativeModels(['native-p2'], 'planner', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'insufficient-phase');
    assert.equal(result.rejected[0].certifiedPhase, 'patch');
    assert.equal(result.rejected[0].requestedPhase, 'workflow');
  } finally {
    cleanup();
  }
});

await test('failed scenario rejects with reason=insufficient-phase', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeCertArtifact(repoDir, 'openai', 'native-fail', 'v1', {
      phase: 'patch',
      scenarios: [{ scenarioId: 's1', passed: true }, { scenarioId: 's2', passed: false }],
    });
    const registry = makeRegistry('native-fail', 'patch', 'v1');
    const result = filterNativeModels(['native-fail'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'insufficient-phase');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rejection reason: malformed
// ---------------------------------------------------------------------------

await test('malformed artifact rejects with reason=malformed', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const path = buildGlobalCertificationPath('openai', 'native-bad', 'v1');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not valid json ');
    const registry = makeRegistry('native-bad', 'patch', 'v1');
    const result = filterNativeModels(['native-bad'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'malformed');
  } finally {
    cleanup();
  }
});

await test('structurally invalid artifact rejects with reason=malformed', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const path = buildGlobalCertificationPath('openai', 'native-incomplete', 'v1');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, provider: 'openai' }));
    const registry = makeRegistry('native-incomplete', 'patch', 'v1');
    const result = filterNativeModels(['native-incomplete'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'malformed');
  } finally {
    cleanup();
  }
});

await test('negative patch-path diagnostics stay pairwise distinct across all required failure modes', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const registry = makeRegistry('native-distinct', 'patch', 'v2');
    const path = buildGlobalCertificationPath('openai', 'native-distinct', 'v2');

    const checkReason = (): string => {
      const result = filterNativeModels(['native-distinct'], 'coder', registry, repoDir);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.rejected.length, 1);
      return result.rejected[0]!.reason;
    };

    const reasons = new Map<string, string>();

    reasons.set('missing', checkReason());

    writeCertArtifact(repoDir, 'openai', 'native-distinct', 'v2', {
      phase: 'patch',
      certifiedAt: new Date(
        Date.now() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    reasons.set('stale', checkReason());

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'openai',
      model: 'native-distinct',
      phase: 'read-only',
      suiteVersion: 'v2',
      certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      scenarios: [{ scenarioId: 's1', passed: true }],
    }));
    reasons.set('read-only-only', checkReason());

    writeCertArtifact(repoDir, 'openai', 'native-distinct', 'v2', {
      phase: 'patch',
      suiteVersion: 'v1',
    });
    reasons.set('wrong-suite', checkReason());

    writeFileSync(path, '{ invalid json');
    reasons.set('malformed', checkReason());

    assert.deepEqual(Object.fromEntries(reasons), {
      missing: 'missing',
      stale: 'stale',
      'read-only-only': 'insufficient-phase',
      'wrong-suite': 'wrong-suite',
      malformed: 'malformed',
    });
    assert.equal(new Set(reasons.values()).size, reasons.size);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Mixed pools
// ---------------------------------------------------------------------------

await test('eligible and rejected models are separated correctly in a mixed pool', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // native-ok has valid patch cert
    writeCertArtifact(repoDir, 'openai', 'native-ok', 'v1', { phase: 'patch' });
    // native-bad has no artifact

    const registry: ModelRegistry = {
      models: {
        'native-ok': {
          vendor: 'openai',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
          contextWindowTokens: 128_000,
          toolSupport: { functionCalling: true, streamingTools: true },
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 3,
          costPerMillionOutputTokensUsd: 15,
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              maxCertifiedPhase: 'patch',
              certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              certificationSuiteVersion: 'v1',
            },
          },
        },
        'native-bad': {
          vendor: 'openai',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
          contextWindowTokens: 128_000,
          toolSupport: { functionCalling: true, streamingTools: true },
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 3,
          costPerMillionOutputTokensUsd: 15,
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              maxCertifiedPhase: 'patch',
              certifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              certificationSuiteVersion: 'v1',
            },
          },
        },
        'non-native-model': {
          vendor: 'anthropic',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
          contextWindowTokens: 200_000,
          toolSupport: { functionCalling: true, streamingTools: true },
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 3,
          costPerMillionOutputTokensUsd: 15,
        },
      },
      ladders: {},
    };

    const result = filterNativeModels(
      ['native-ok', 'native-bad', 'non-native-model'],
      'coder',
      registry,
      repoDir,
    );

    assert.deepEqual(result.eligible.sort(), ['native-ok', 'non-native-model'].sort());
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].modelId, 'native-bad');
    assert.equal(result.rejected[0].reason, 'missing');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
