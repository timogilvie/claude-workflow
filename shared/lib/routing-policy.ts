import {
  CLASS_RANK,
  getEffectiveRegistry,
  getLadder,
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
  | 'frontier-substitution-active'
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

/**
 * Determines if frontier substitution should be active for the given policy and registry.
 *
 * Substitution is active when:
 * 1. The top-of-ladder frontier model for this task type is degrading or exhausted
 * 2. At least one other frontier model is healthy
 *
 * @returns true if non-frontier models should be excluded to force healthy frontier sibling selection
 */
export function shouldSubstituteFrontier(
  policy: RoutingPolicy,
  registry: ModelRegistry,
): boolean {
  // Find the preferred frontier model (first frontier in the ladder)
  const ladder = getLadder(registry, policy.taskType);
  const preferredFrontier = ladder.find(
    (modelId) => registry.models[modelId]?.class === 'frontier',
  );

  // If no frontier in ladder, substitution doesn't apply
  if (!preferredFrontier) {
    return false;
  }

  // Check if the preferred frontier is degrading or exhausted
  const preferredStatus = getQuotaStatus(policy.quotaState, preferredFrontier);
  if (preferredStatus !== 'degrading' && preferredStatus !== 'exhausted') {
    return false;
  }

  // Check if any other frontier model is healthy
  const hasHealthyFrontierSibling = Object.entries(registry.models).some(
    ([modelId, capabilities]) => {
      if (modelId === preferredFrontier) {
        return false; // Skip the preferred frontier itself
      }
      if (capabilities.class !== 'frontier') {
        return false;
      }
      return getQuotaStatus(policy.quotaState, modelId) === 'healthy';
    },
  );

  return hasHealthyFrontierSibling;
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

  // Check if frontier substitution should be active
  const substitutionActive = shouldSubstituteFrontier(policy, registry);

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

      // If frontier substitution is active, exclude non-frontier models
      if (substitutionActive && capabilities.class !== 'frontier') {
        return 'frontier-substitution-active' satisfies ExclusionReason;
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
