/**
 * Shared harness for the cross-repo global model parity suite (HOK-2939).
 *
 * The suite used to live in a single cross-repo-parity.test.ts running all
 * five artifact modes; at ~4-6 CI minutes it was the longest indivisible unit
 * test and set the wall-clock floor for whichever shard held it. Each mode is
 * fully independent (own fixture, own assertions), so the modes now run as
 * five thin registered test files (cross-repo-parity.<mode>.test.ts) that call
 * {@link runParityModeSuite}. Assertions and coverage are byte-for-byte the
 * ones the monolithic file ran; only the file granularity changed so the
 * weighted partitioner can spread the cost.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildParityFixture, type ParityArtifactMode } from './cross-repo-parity.ts';
import {
  explainEffectiveModelAvailability,
  getGlobalModelRegistry,
  listEffectiveModelsForStage,
  resolveEffectiveAgent,
  resolveEffectiveModelIdentity,
} from './effective-models.ts';
import type { SupportedModelStage } from './model-registry.ts';
import { filterNativeModels, type RouterRole } from './native-agent/certification/router-filter.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';
import { pickChallengeModelsWithReason } from './challenge-mode.ts';
import { diagnoseOpenRouter, type OpenRouterDoctorStage } from './openrouter-doctor.ts';

const STAGES: SupportedModelStage[] = ['planning', 'coding', 'review'];
const STAGE_TO_ROLE: Record<SupportedModelStage, RouterRole> = {
  expansion: 'reviewer',
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};
const STAGE_TO_DOCTOR: Record<SupportedModelStage, OpenRouterDoctorStage> = {
  expansion: 'reviewer',
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};
const REPRESENTATIVE_MODELS = ['qwen-3-coder', 'glm-5.2', 'kimi-k2.7-code'];

function withGlobalRoot<T>(root: string, fn: () => T): T {
  const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = root;
  try {
    return fn();
  } finally {
    if (previousRoot === undefined) {
      delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    } else {
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
    }
  }
}

function readyModelsForStage(repoDir: string, stage: SupportedModelStage): string[] {
  return listEffectiveModelsForStage(stage, { repoDir }).models
    .filter((modelId) => explainEffectiveModelAvailability(modelId, stage, {
      repoDir,
      requireRuntimeReady: true,
      apiKeyPresent: true,
      apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY',
      now: new Date('2026-08-01T00:00:00.000Z'),
    }).available)
    .sort();
}

function availabilitySnapshot(repoDir: string, stage: SupportedModelStage) {
  return REPRESENTATIVE_MODELS.map((modelId) => {
    const availability = explainEffectiveModelAvailability(modelId, stage, {
      repoDir,
      requireRuntimeReady: true,
      apiKeyPresent: true,
      apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    return {
      modelId,
      available: availability.available,
      reason: availability.reason,
      identity: resolveEffectiveModelIdentity(modelId),
      agent: resolveEffectiveAgent(modelId, stage === 'planning' ? 'planning' : stage === 'review' ? 'review' : 'coding').ok
        ? resolveEffectiveAgent(modelId, stage === 'planning' ? 'planning' : stage === 'review' ? 'review' : 'coding').agent
        : 'unresolved',
      nativeGate: availability.nativeGate
        ? {
          ok: availability.nativeGate.ok,
          ...(!availability.nativeGate.ok
            ? {
              reason: availability.nativeGate.reason,
              requiredPhase: availability.nativeGate.requiredPhase,
              foundPhase: availability.nativeGate.foundPhase,
              requiredSuiteVersion: availability.nativeGate.requiredSuiteVersion,
              foundSuiteVersion: availability.nativeGate.foundSuiteVersion,
            }
            : {}),
        }
        : undefined,
    };
  });
}

function routerSnapshot(repoDir: string, stage: SupportedModelStage) {
  const role = STAGE_TO_ROLE[stage];
  const result = filterNativeModels(REPRESENTATIVE_MODELS, role, getGlobalModelRegistry(), repoDir, {
    now: new Date('2026-08-01T00:00:00.000Z'),
    apiKeyPresent: true,
    apiKeyEnv: 'TEST_PARITY_OPENROUTER_KEY',
  });
  return {
    eligible: result.eligible.sort(),
    rejected: result.rejected
      .map((entry) => ({
        modelId: entry.modelId,
        role: entry.role,
        requestedPhase: entry.requestedPhase,
        certifiedPhase: entry.certifiedPhase,
        reason: entry.reason,
        requiredSuiteVersion: entry.requiredSuiteVersion,
      }))
      .sort((a, b) => a.modelId.localeCompare(b.modelId) || a.reason.localeCompare(b.reason)),
  };
}

function doctorSnapshot(repoDir: string, stage: SupportedModelStage) {
  const report = diagnoseOpenRouter({ repoDir, stage: STAGE_TO_DOCTOR[stage], lookback: 1 });
  return {
    routerPoolEligibleCounts: report.summary.routerPoolEligibleCounts,
    challengePoolEligibleCounts: report.summary.challengePoolEligibleCounts,
    topBlockingReasons: report.summary.topBlockingReasons,
    models: report.models
      .filter((model) => REPRESENTATIVE_MODELS.includes(model.registryModelId ?? model.alias ?? model.id))
      .map((model) => ({
        alias: model.alias,
        registryModelId: model.registryModelId,
        eligibleStages: model.eligibleStages,
        cells: model.cells.map((cell) => ({
          stage: cell.stage,
          eligible: cell.eligible,
          primaryReason: cell.primaryReason?.reason ?? null,
        })),
      }))
      .sort((a, b) => (a.registryModelId ?? '').localeCompare(b.registryModelId ?? '')),
  };
}

function challengeSnapshot(repoDir: string) {
  const selection = pickChallengeModelsWithReason(REPRESENTATIVE_MODELS, {
    pairId: 'HOK-2588',
    issueId: 'HOK-2588',
    slug: 'global-model-parity',
    primaryModel: 'glm-5.2',
    repoDir,
    randomFn: () => 0,
    strictWhenRequired: true,
    requestedRate: 1,
  });
  return {
    pair: selection.pair
      ? {
        primary: selection.pair.primary.model,
        challenger: selection.pair.challenger.model,
        primaryAgent: selection.pair.primary.agent,
        challengerAgent: selection.pair.challenger.agent,
      }
      : null,
    failureReason: selection.failureReason,
    unavailableMode: selection.challengeUnavailable?.mode,
    blockers: selection.challengeUnavailable?.blockers.map((blocker) => blocker.kind).sort(),
    rejections: (selection.nativeCertificationRejections ?? [])
      .map((entry) => ({ modelId: entry.modelId, reason: entry.reason, role: entry.role }))
      .sort((a, b) => a.modelId.localeCompare(b.modelId) || a.reason.localeCompare(b.reason)),
  };
}

function snapshot(repoDir: string, stage: SupportedModelStage) {
  return {
    readyModels: readyModelsForStage(repoDir, stage).filter((model) => REPRESENTATIVE_MODELS.includes(model)),
    availability: availabilitySnapshot(repoDir, stage),
    router: routerSnapshot(repoDir, stage),
    doctor: doctorSnapshot(repoDir, stage),
    ...(stage === 'coding' ? { challenge: challengeSnapshot(repoDir) } : {}),
  };
}

/**
 * Register the parity suite for one artifact mode on the current node:test
 * context. Each per-mode test file calls this exactly once.
 */
export function runParityModeSuite(mode: ParityArtifactMode): void {
  describe('cross-repo global model parity', () => {
    it(`keeps Wavemill, gtm-backend, and gtm-frontend in parity for ${mode} global artifacts`, () => {
      const fixture = buildParityFixture({ globalArtifacts: mode });
      try {
        withGlobalRoot(fixture.global.root, () => {
          for (const stage of STAGES) {
            const [first, ...rest] = fixture.consumers.map((consumer) => snapshot(consumer.repoDir, stage));
            for (const other of rest) {
              assert.deepEqual(other, first);
            }
          }

          const validReady = readyModelsForStage(fixture.consumers[0].repoDir, 'coding');
          if (mode === 'valid') {
            assert.ok(validReady.includes('qwen-3-coder'), 'legacy router.models must not hide globally certified Qwen');
            assert.ok(validReady.includes('glm-5.2'));
            assert.ok(validReady.includes('kimi-k2.7-code'));
            const challenge = challengeSnapshot(fixture.consumers[0].repoDir);
            assert.equal(challenge.failureReason, undefined);
            assert.ok(challenge.pair);
          } else {
            const challenge = challengeSnapshot(fixture.consumers[0].repoDir);
            assert.equal(challenge.failureReason, 'challenge_unavailable');
            assert.equal(challenge.unavailableMode, 'challenge_unavailable');
          }
        });
      } finally {
        fixture.cleanup();
      }
    });
  });
}
