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
import { join } from 'node:path';
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
import type { ModelRegistry } from '../../model-registry.ts';

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
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  overrides: Record<string, unknown> = {},
): void {
  const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', provider, model);
  mkdirSync(certDir, { recursive: true });
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
  writeFileSync(join(certDir, `${suiteVersion}.json`), JSON.stringify(artifact));
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

await test('openrouter aliases load certifications from mapped provider/model storage paths', () => {
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

    const result = filterNativeModels(['qwen-3-coder'], 'planner', registry, repoDir);
    assert.deepEqual(result.eligible, ['qwen-3-coder']);
    assert.deepEqual(result.rejected, []);
  } finally {
    cleanup();
  }
});

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
    const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', 'openai', 'native-bad');
    mkdirSync(certDir, { recursive: true });
    writeFileSync(join(certDir, 'v1.json'), '{ not valid json ');
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
    const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', 'openai', 'native-incomplete');
    mkdirSync(certDir, { recursive: true });
    writeFileSync(join(certDir, 'v1.json'), JSON.stringify({ schemaVersion: 1, provider: 'openai' }));
    const registry = makeRegistry('native-incomplete', 'patch', 'v1');
    const result = filterNativeModels(['native-incomplete'], 'coder', registry, repoDir);
    assert.equal(result.rejected[0].reason, 'malformed');
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
