import {
  CLASS_RANK,
  getEffectiveRegistry,
  getLadder,
  type LatencyTier,
  type ModelClass,
  type ModelRegistry,
  type RegistryTaskType,
} from './model-registry.ts';
import { filterDeepSeekModels } from './deepseek-provider.ts';
import { type QuotaSnapshot, type QuotaStatus } from './quota-state.ts';
import { getAllowedModelFloor, type RoutingDifficulty } from './task-difficulty-classifier.ts';

/**
 * Capability constraints for model selection.
 * Used by capability-aware routing to filter candidates based on task requirements.
 */
export interface CapabilityConstraints {
  minContextWindow?: number;
  requiresTools?: boolean;
  requiresMultimodal?: boolean;
  maxLatencyTier?: LatencyTier;
}

/**
 * Rejection metadata for a single model that failed capability filtering.
 */
export interface CapabilityFilterRejection {
  id: string;
  reasons: string[];
}

/**
 * Result of capability filtering operation.
 */
export interface CapabilityFilterResult<T> {
  accepted: T[];
  rejected: CapabilityFilterRejection[];
  applied: boolean;
  fallback: boolean;
}

export interface RoutingPolicy {
  taskType: RegistryTaskType;
  difficulty: RoutingDifficulty;
  quotaState: QuotaSnapshot;
  minQualityScore?: number;
  maxCostTier?: ModelClass;
  repoDir?: string;
  capabilityConstraints?: CapabilityConstraints;
  capabilityAwareRouting?: boolean;
}

export type ExclusionReason =
  | 'quota-exhausted'
  | 'below-difficulty-floor'
  | 'below-quality-threshold'
  | 'exceeds-cost-tier'
  | 'below-frontier-substitute'
  | 'capability-constraint';

export interface RankedCandidate {
  modelId: string;
  qualityScore: number;
  adjustedScore: number;
  modelClass: ModelClass;
  viable: boolean;
  exclusionReason?: ExclusionReason;
  quotaStatus?: QuotaStatus;
  capabilityRejectedReasons?: string[];
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
  const allowedModelIds = new Set(filterDeepSeekModels(Object.keys(registry.models), repoDir).models);

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

const LATENCY_TIER_ORDER: Record<LatencyTier, number> = {
  fast: 0,
  standard: 1,
  slow: 2,
};

/**
 * Filter candidates by capability constraints.
 * Returns accepted candidates and rejection metadata.
 */
export function filterByCapabilities<T>(
  candidates: T[],
  constraints: CapabilityConstraints | undefined,
  registry: ModelRegistry,
  getModelId: (candidate: T) => string,
): CapabilityFilterResult<T> {
  // No constraints or empty constraints means no filtering
  if (!constraints || Object.keys(constraints).length === 0) {
    return {
      accepted: candidates,
      rejected: [],
      applied: false,
      fallback: false,
    };
  }

  const rejected: CapabilityFilterRejection[] = [];
  const accepted: T[] = [];

  for (const candidate of candidates) {
    const modelId = getModelId(candidate);
    const capabilities = registry.models[modelId];

    if (!capabilities) {
      rejected.push({
        id: modelId,
        reasons: ['missing capability metadata'],
      });
      continue;
    }

    const reasons: string[] = [];

    // Check context window requirement
    if (constraints.minContextWindow !== undefined) {
      const modelContextWindow = capabilities.contextWindowTokens ?? 0;
      if (modelContextWindow < constraints.minContextWindow) {
        reasons.push(
          `context window ${modelContextWindow} < required ${constraints.minContextWindow}`,
        );
      }
    }

    // Check tool support requirement (only if explicitly required)
    if (constraints.requiresTools === true) {
      const toolSupport = capabilities.toolSupport ?? 'none';
      if (toolSupport === 'none') {
        reasons.push('no tool support');
      }
    }

    // Check multimodal requirement (only if explicitly required)
    if (constraints.requiresMultimodal === true) {
      const hasImageSupport = capabilities.multimodal?.image ?? false;
      if (!hasImageSupport) {
        reasons.push('no multimodal/image support');
      }
    }

    // Check latency tier requirement
    if (constraints.maxLatencyTier !== undefined) {
      const modelLatency = capabilities.latencyTier ?? 'slow';
      const maxLatencyOrder = LATENCY_TIER_ORDER[constraints.maxLatencyTier];
      const modelLatencyOrder = LATENCY_TIER_ORDER[modelLatency];
      if (modelLatencyOrder > maxLatencyOrder) {
        reasons.push(`latency ${modelLatency} > max ${constraints.maxLatencyTier}`);
      }
    }

    if (reasons.length > 0) {
      rejected.push({ id: modelId, reasons });
    } else {
      accepted.push(candidate);
    }
  }

  // If all candidates were rejected, fall back to original list
  const fallback = accepted.length === 0;
  return {
    accepted: fallback ? candidates : accepted,
    rejected,
    applied: true,
    fallback,
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

  let candidates = Object.entries(registry.models).map(([modelId, capabilities]) => {
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

      // New exclusion: if a healthy frontier sibling is available, exclude non-frontier models
      if (healthyFrontierSubstituteAvailable && capabilities.class !== 'frontier') {
        return 'below-frontier-substitute' satisfies ExclusionReason;
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
      quotaStatus: status,
    } satisfies RankedCandidate;
  });

  // Apply capability filtering if enabled
  if (policy.capabilityAwareRouting && policy.capabilityConstraints) {
    const filterResult = filterByCapabilities(
      candidates,
      policy.capabilityConstraints,
      registry,
      (candidate) => candidate.modelId,
    );

    // Only apply filtering if we have some accepted candidates or we're not falling back
    if (!filterResult.fallback) {
      candidates = candidates.map((candidate) => {
        const rejection = filterResult.rejected.find((r) => r.id === candidate.modelId);
        if (rejection) {
          return {
            ...candidate,
            viable: false,
            exclusionReason: 'capability-constraint' satisfies ExclusionReason,
            capabilityRejectedReasons: rejection.reasons,
          };
        }
        return candidate;
      });
    } else if (filterResult.rejected.length > 0) {
      // Fallback case: mark rejection reasons but keep viable status unchanged
      candidates = candidates.map((candidate) => {
        const rejection = filterResult.rejected.find((r) => r.id === candidate.modelId);
        if (rejection) {
          return {
            ...candidate,
            capabilityRejectedReasons: rejection.reasons,
          };
        }
        return candidate;
      });
    }
  }

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
