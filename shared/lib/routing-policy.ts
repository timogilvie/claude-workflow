import {
  CLASS_RANK,
  getEffectiveRegistry,
  type ModelClass,
  type ModelRegistry,
  type RegistryTaskType,
} from './model-registry.ts';
import { type QuotaSnapshot, type QuotaStatus } from './quota-state.ts';
import { getAllowedModelFloor, type RoutingDifficulty } from './task-difficulty-classifier.ts';

export interface RoutingPolicy {
  taskType: RegistryTaskType;
  difficulty: RoutingDifficulty;
  quotaState: QuotaSnapshot;
  minQualityScore?: number;
  maxCostTier?: ModelClass;
  repoDir?: string;
}

export type ExclusionReason =
  | 'quota-exhausted'
  | 'below-difficulty-floor'
  | 'below-quality-threshold'
  | 'exceeds-cost-tier';

export interface RankedCandidate {
  modelId: string;
  qualityScore: number;
  adjustedScore: number;
  modelClass: ModelClass;
  viable: boolean;
  exclusionReason?: ExclusionReason;
}

const DEGRADING_SCORE_PENALTY = 0.85;

function getQuotaStatus(snapshot: QuotaSnapshot, modelId: string): QuotaStatus {
  return snapshot.models[modelId]?.status ?? 'healthy';
}

function computeAdjustedScore(qualityScore: number, status: QuotaStatus): number {
  return status === 'degrading'
    ? qualityScore * DEGRADING_SCORE_PENALTY
    : qualityScore;
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.viable !== right.viable) {
    return left.viable ? -1 : 1;
  }

  const leftScore = left.viable ? left.adjustedScore : left.qualityScore;
  const rightScore = right.viable ? right.adjustedScore : right.qualityScore;
  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }

  const classDelta = CLASS_RANK[right.modelClass] - CLASS_RANK[left.modelClass];
  if (classDelta !== 0) {
    return classDelta;
  }

  return left.modelId.localeCompare(right.modelId);
}

export function resolveModel(
  policy: RoutingPolicy,
  registryOverride?: ModelRegistry,
): RankedCandidate[] {
  const registry = registryOverride ?? getEffectiveRegistry(policy.repoDir);
  const floor = getAllowedModelFloor(policy.difficulty);
  const hasViableFrontier = Object.entries(registry.models).some(([modelId, capabilities]) => {
    if (capabilities.class !== 'frontier') {
      return false;
    }

    if (policy.maxCostTier && CLASS_RANK[capabilities.class] > CLASS_RANK[policy.maxCostTier]) {
      return false;
    }

    return getQuotaStatus(policy.quotaState, modelId) !== 'exhausted';
  });

  const candidates = Object.entries(registry.models).map(([modelId, capabilities]) => {
    const qualityScore = capabilities.qualityScores[policy.taskType] ?? 0;
    const status = getQuotaStatus(policy.quotaState, modelId);
    const adjustedScore = computeAdjustedScore(qualityScore, status);
    const exclusionReason = (() => {
      if (status === 'exhausted') {
        return 'quota-exhausted' satisfies ExclusionReason;
      }

      if (policy.maxCostTier && CLASS_RANK[capabilities.class] > CLASS_RANK[policy.maxCostTier]) {
        return 'exceeds-cost-tier' satisfies ExclusionReason;
      }

      if (!floor.allowHaiku && capabilities.class === 'fast_economy') {
        return 'below-difficulty-floor' satisfies ExclusionReason;
      }

      if (floor.preferOpus && capabilities.class !== 'frontier' && hasViableFrontier) {
        return 'below-difficulty-floor' satisfies ExclusionReason;
      }

      if (policy.minQualityScore !== undefined && qualityScore < policy.minQualityScore) {
        return 'below-quality-threshold' satisfies ExclusionReason;
      }

      return undefined;
    })();

    return {
      modelId,
      qualityScore,
      adjustedScore,
      modelClass: capabilities.class,
      viable: exclusionReason === undefined,
      exclusionReason,
    } satisfies RankedCandidate;
  });

  return candidates.sort(compareCandidates);
}

export function topViableCandidate(
  policy: RoutingPolicy,
  pool: string[],
  registryOverride?: ModelRegistry,
): string | null {
  const poolSet = new Set(pool);
  const hit = resolveModel(policy, registryOverride).find(
    (candidate) => candidate.viable && poolSet.has(candidate.modelId),
  );
  return hit?.modelId ?? null;
}
