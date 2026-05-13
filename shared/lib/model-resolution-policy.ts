import {
  CLASS_RANK,
  DEFAULT_MODEL_REGISTRY,
  getEffectiveRegistry,
  resolveSelector,
  type FallbackReason,
  type ModelCapabilities,
  type ModelClass,
  type ModelRegistry,
  type ModelSelector,
  type RegistryTaskType,
  type ResolutionContext,
  type ResolvedModel,
} from './model-registry.ts';
import { readQuotaSnapshot, type QuotaSnapshot } from './quota-state.ts';
import { resolveModel, type RankedCandidate } from './routing-policy.ts';
import type { RoutingDifficulty } from './task-difficulty-classifier.ts';

export interface ResolveSelectorWithPolicyOptions {
  taskType: RegistryTaskType;
  difficulty: RoutingDifficulty;
  quotaState?: QuotaSnapshot;
  minQualityScore?: number;
  maxCostTier?: ModelClass;
  repoDir?: string;
  registryOverride?: ModelRegistry;
}

export type ModelPolicyResolutionErrorCode = 'no_viable_substitute';

export class ModelPolicyResolutionError extends Error {
  readonly code: ModelPolicyResolutionErrorCode;
  readonly requested: ModelSelector;
  readonly resolved: string;
  readonly reason: FallbackReason;

  constructor(
    code: ModelPolicyResolutionErrorCode,
    requested: ModelSelector,
    resolved: string,
    reason: FallbackReason,
    message: string,
  ) {
    super(message);
    this.name = 'ModelPolicyResolutionError';
    this.code = code;
    this.requested = requested;
    this.resolved = resolved;
    this.reason = reason;
  }
}

function selectSubstitute(
  baseline: ResolvedModel,
  registry: ModelRegistry,
  rankedCandidates: RankedCandidate[],
): string | null {
  const viableCandidates = rankedCandidates.filter(
    (candidate) => candidate.viable && candidate.modelId !== baseline.resolved,
  );
  if (viableCandidates.length === 0) {
    return null;
  }

  const requestedCapabilities =
    registry.models[baseline.resolved] ?? DEFAULT_MODEL_REGISTRY.models[baseline.resolved];
  if (!requestedCapabilities) {
    return viableCandidates[0]?.modelId ?? null;
  }

  const sameVendorByClass = rankedCandidates
    .map((candidate, index) => ({
      candidate,
      index,
      capabilities: registry.models[candidate.modelId],
    }))
    .filter(
      (
        entry,
      ): entry is {
        candidate: RankedCandidate;
        index: number;
        capabilities: ModelCapabilities;
      } =>
        entry.candidate.modelId !== baseline.resolved &&
        entry.capabilities !== undefined &&
        entry.capabilities.vendor === requestedCapabilities.vendor &&
        CLASS_RANK[entry.capabilities.class] < CLASS_RANK[requestedCapabilities.class] &&
        (entry.candidate.viable || entry.candidate.exclusionReason === 'below-frontier-substitute'),
    )
    .sort((left, right) => {
      const leftDistance =
        CLASS_RANK[requestedCapabilities.class] - CLASS_RANK[left.capabilities.class];
      const rightDistance =
        CLASS_RANK[requestedCapabilities.class] - CLASS_RANK[right.capabilities.class];
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return left.index - right.index;
    });

  return sameVendorByClass[0]?.candidate.modelId ?? viableCandidates[0]?.modelId ?? null;
}

export function resolveSelectorWithPolicy(
  selector: ModelSelector,
  context: ResolutionContext | undefined,
  options: ResolveSelectorWithPolicyOptions,
): ResolvedModel {
  const baseline = resolveSelector(selector, context);
  const registry = options.registryOverride ?? getEffectiveRegistry(options.repoDir);
  const quotaState = options.quotaState ?? readQuotaSnapshot(options.repoDir);
  const rankedCandidates = resolveModel(
    {
      taskType: options.taskType,
      difficulty: options.difficulty,
      quotaState,
      minQualityScore: options.minQualityScore,
      maxCostTier: options.maxCostTier,
      repoDir: options.repoDir,
    },
    registry,
  );

  const requestedCandidate = rankedCandidates.find(
    (candidate) => candidate.modelId === baseline.resolved,
  );
  if (requestedCandidate?.viable) {
    return baseline;
  }

  const fallbackReason: FallbackReason = !registry.models[baseline.resolved] || !requestedCandidate
    ? 'unavailable'
    : requestedCandidate.exclusionReason === 'quota-exhausted'
      ? 'quota-exhausted'
      : 'disabled-by-policy';

  const substitute = selectSubstitute(baseline, registry, rankedCandidates);
  if (!substitute) {
    throw new ModelPolicyResolutionError(
      'no_viable_substitute',
      baseline.requested,
      baseline.resolved,
      fallbackReason,
      `No viable substitute is available for requested selector "${JSON.stringify(baseline.requested)}" after resolving to "${baseline.resolved}" (${fallbackReason}).`,
    );
  }

  return {
    ...baseline,
    resolved: substitute,
    source: fallbackReason === 'disabled-by-policy' ? 'policy' : 'fallback',
    fallbackReason,
  };
}
