import {
  CLASS_RANK,
  evaluateCapabilityConstraints,
  getEffectiveRegistry,
  getLadder,
  hasCapabilityConstraints,
  type ModelClass,
  type ModelRegistry,
  type RegistryTaskType,
  type CapabilityConstraintName,
  type CapabilityConstraints,
} from './model-registry.ts';
import { filterDeepSeekModels } from './deepseek-provider.ts';
import { filterOpenRouterModels } from './openrouter-provider.ts';
import { type QuotaSnapshot, type QuotaStatus } from './quota-state.ts';
import { getAllowedModelFloor, type RoutingDifficulty } from './task-difficulty-classifier.ts';
import { isRouterCapabilityFilteringEnabled } from './config.ts';

export interface RoutingPolicy {
  taskType: RegistryTaskType;
  difficulty: RoutingDifficulty;
  quotaState: QuotaSnapshot;
  minQualityScore?: number;
  maxCostTier?: ModelClass;
  repoDir?: string;
  capabilityConstraints?: CapabilityConstraints;
}

export type ExclusionReason =
  | 'quota-exhausted'
  | 'disabled-by-policy'
  | 'below-difficulty-floor'
  | 'below-quality-threshold'
  | 'exceeds-cost-tier'
  | 'below-frontier-substitute'
  | 'missing-capability';

export interface RankedCandidate {
  modelId: string;
  qualityScore: number;
  adjustedScore: number;
  modelClass: ModelClass;
  viable: boolean;
  exclusionReason?: ExclusionReason;
  quotaStatus?: QuotaStatus;
  capabilityFailures?: CapabilityConstraintName[];
}

export interface ViableCandidatePool {
  modelIds: string[];
  capabilityFallbackUsed: boolean;
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

  // When both are viable frontier-class candidates, healthy ranks above degrading
  if (left.viable && left.modelClass === 'frontier' && right.modelClass === 'frontier') {
    const leftHealthy = left.quotaStatus === 'healthy';
    const rightHealthy = right.quotaStatus === 'healthy';
    if (leftHealthy !== rightHealthy) {
      return leftHealthy ? -1 : 1;
    }
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

function findHealthyFrontierSibling(
  registry: ModelRegistry,
  quotaState: QuotaSnapshot,
  taskType: RegistryTaskType,
  excludeModelId?: string,
  maxCostTier?: ModelClass,
): string | null {
  // Walk the ladder to find the first healthy frontier sibling, respecting cost tier
  const ladder = getLadder(registry, taskType);

  for (const modelId of ladder) {
    if (modelId === excludeModelId) {
      continue;
    }

    const capabilities = registry.models[modelId];
    if (!capabilities || capabilities.class !== 'frontier') {
      continue;
    }

    if (maxCostTier && CLASS_RANK[capabilities.class] > CLASS_RANK[maxCostTier]) {
      continue;
    }

    const status = getQuotaStatus(quotaState, modelId);
    if (status === 'healthy') {
      return modelId;
    }
  }

  return null;
}

function filterProviderUnavailableModels(
  registry: ModelRegistry,
  repoDir?: string,
): ModelRegistry {
  const allowedModelIds = new Set(
    filterOpenRouterModels(
      filterDeepSeekModels(Object.keys(registry.models), repoDir).models,
      repoDir,
    ).models,
  );

  return {
    models: Object.fromEntries(
      Object.entries(registry.models).filter(([modelId]) => allowedModelIds.has(modelId)),
    ),
    ladders: Object.fromEntries(
      Object.entries(registry.ladders).map(([taskType, ladder]) => [
        taskType,
        ladder.filter((modelId) => allowedModelIds.has(modelId)),
      ]),
    ),
  };
}

export function resolveModel(
  policy: RoutingPolicy,
  registryOverride?: ModelRegistry,
): RankedCandidate[] {
  const registry = filterProviderUnavailableModels(
    registryOverride ?? getEffectiveRegistry(policy.repoDir),
    policy.repoDir,
  );
  const ladderModelIds = new Set(getLadder(registry, policy.taskType));
  const candidateModelIds = Object.entries(registry.models)
    .filter(([modelId, capabilities]) =>
      ladderModelIds.has(modelId) || capabilities.defaultLadderEligible !== false
    )
    .map(([modelId]) => modelId);
  const floor = getAllowedModelFloor(policy.difficulty);
  const hasViableFrontier = candidateModelIds.some((modelId) => {
    const capabilities = registry.models[modelId];
    if (capabilities.class !== 'frontier') {
      return false;
    }

    if (policy.maxCostTier && CLASS_RANK[capabilities.class] > CLASS_RANK[policy.maxCostTier]) {
      return false;
    }

    return getQuotaStatus(policy.quotaState, modelId) !== 'exhausted';
  });

  // Detect frontier sibling substitution scenario
  const topLadderFrontier = getLadder(registry, policy.taskType).find((modelId) => {
    const caps = registry.models[modelId];
    return caps && caps.class === 'frontier';
  }) || null;

  const topFrontierStatus = topLadderFrontier
    ? getQuotaStatus(policy.quotaState, topLadderFrontier)
    : null;

  const healthyFrontierSubstituteAvailable = !!(
    topLadderFrontier &&
    (topFrontierStatus === 'degrading' || topFrontierStatus === 'exhausted') &&
    findHealthyFrontierSibling(
      registry,
      policy.quotaState,
      policy.taskType,
      topLadderFrontier,
      policy.maxCostTier,
    )
  );
  const capabilityFilteringEnabled = isRouterCapabilityFilteringEnabled(policy.repoDir);
  const shouldApplyCapabilityFiltering =
    capabilityFilteringEnabled && hasCapabilityConstraints(policy.capabilityConstraints);

  const candidates = candidateModelIds.map((modelId) => {
    const capabilities = registry.models[modelId];
    const qualityScore = capabilities.qualityScores[policy.taskType] ?? 0;
    const status = getQuotaStatus(policy.quotaState, modelId);
    const adjustedScore = computeAdjustedScore(qualityScore, status);
    const capabilityResult = shouldApplyCapabilityFiltering
      ? evaluateCapabilityConstraints(capabilities, policy.capabilityConstraints)
      : { satisfied: true, failedConstraints: [] };
    const exclusionReason = (() => {
      if (capabilities.disabled === true) {
        return 'disabled-by-policy' satisfies ExclusionReason;
      }

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

      // New exclusion: if a healthy frontier sibling is available, exclude non-frontier models
      if (healthyFrontierSubstituteAvailable && capabilities.class !== 'frontier') {
        return 'below-frontier-substitute' satisfies ExclusionReason;
      }

      if (policy.minQualityScore !== undefined && qualityScore < policy.minQualityScore) {
        return 'below-quality-threshold' satisfies ExclusionReason;
      }

      if (!capabilityResult.satisfied) {
        return 'missing-capability' satisfies ExclusionReason;
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
      quotaStatus: status,
      capabilityFailures: capabilityResult.failedConstraints,
    } satisfies RankedCandidate;
  });

  return candidates.sort(compareCandidates);
}

export function viableCandidatesInPool(
  policy: RoutingPolicy,
  pool: string[],
  registryOverride?: ModelRegistry,
): ViableCandidatePool {
  const poolSet = new Set(pool);
  const ranked = resolveModel(policy, registryOverride);
  const constrainedModelIds = ranked
    .filter((candidate) => candidate.viable && poolSet.has(candidate.modelId))
    .map((candidate) => candidate.modelId);

  if (constrainedModelIds.length > 0) {
    return {
      modelIds: constrainedModelIds,
      capabilityFallbackUsed: false,
    };
  }

  if (!isRouterCapabilityFilteringEnabled(policy.repoDir) || !hasCapabilityConstraints(policy.capabilityConstraints)) {
    return {
      modelIds: constrainedModelIds,
      capabilityFallbackUsed: false,
    };
  }

  const fallbackModelIds = resolveModel(
    { ...policy, capabilityConstraints: undefined },
    registryOverride,
  )
    .filter((candidate) => candidate.viable && poolSet.has(candidate.modelId))
    .map((candidate) => candidate.modelId);

  return {
    modelIds: fallbackModelIds,
    capabilityFallbackUsed: fallbackModelIds.length > 0,
  };
}

export function topViableCandidate(
  policy: RoutingPolicy,
  pool: string[],
  registryOverride?: ModelRegistry,
): string | null {
  return viableCandidatesInPool(policy, pool, registryOverride).modelIds[0] ?? null;
}
