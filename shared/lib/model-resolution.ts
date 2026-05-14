import {
  type ModelSelector,
  parseModelSelector,
  resolveSelector,
  type ResolvedModel,
  type ResolutionContext,
  validateModelId,
} from './model-registry.ts';
import {
  ModelPolicyResolutionError,
  resolveSelectorWithPolicy,
  type ResolveSelectorWithPolicyOptions,
} from './model-resolution-policy.ts';
import { resolveModel } from './routing-policy.ts';
import type { QuotaSnapshot } from './quota-state.ts';

export type EffectiveModelSelectorInput = ModelSelector | string | undefined;

export type ResolutionLayer = 'workspace' | 'user' | 'policy' | 'parent' | 'default';

export type EffectiveResolvedModel = ResolvedModel & {
  resolutionLayer: ResolutionLayer;
};

export type ResolveEffectiveModelPolicyContext = Omit<
  ResolveSelectorWithPolicyOptions,
  'quotaState'
> & {
  quotaState: QuotaSnapshot;
};

export interface ResolveEffectiveModelInput {
  workspaceSelector?: EffectiveModelSelectorInput;
  userOverride?: EffectiveModelSelectorInput;
  parent?: ResolvedModel;
  parentContextId?: string;
  parentResolvedModelId?: string;
  policyContext: ResolveEffectiveModelPolicyContext;
}

interface SelectedResolution {
  selector: ModelSelector;
  layer: Exclude<ResolutionLayer, 'policy'>;
  context?: ResolutionContext;
}

function normalizeParentResolvedModelId(modelId: string | undefined): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    validateModelId(trimmed);
  } catch {
    process.stderr.write(
      `[model-resolution] WARN: WAVEMILL_RESOLVED_MODEL='${trimmed}' is not a recognized model ID — ignoring and falling back to configured default.\n`
    );
    return undefined;
  }

  return trimmed;
}

function parentFromResolvedModelId(modelId: string | undefined): ResolvedModel | undefined {
  const normalized = normalizeParentResolvedModelId(modelId);
  if (!normalized) {
    return undefined;
  }

  return {
    requested: { kind: 'pinned', modelId: normalized },
    resolved: normalized,
    source: 'pinned',
  };
}

function normalizeSelector(input: EffectiveModelSelectorInput): ModelSelector | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== 'string') {
    return input;
  }

  const parsed = parseModelSelector(input);
  if (!parsed.ok) {
    throw parsed.error;
  }

  return parsed.selector;
}

function mapExclusionReasonToFallbackReason(exclusionReason: string | undefined) {
  if (exclusionReason === 'quota-exhausted') {
    return 'quota-exhausted' as const;
  }

  return 'disabled-by-policy' as const;
}

function selectDefaultResolution(
  policyContext: ResolveEffectiveModelPolicyContext,
): SelectedResolution {
  // Default selection follows the existing ranked viable ordering so the
  // no-selector path stays aligned with Layer 3 policy and quota constraints.
  const rankedCandidates = resolveModel(policyContext, policyContext.registryOverride);
  const viableCandidate = rankedCandidates.find((candidate) => candidate.viable);
  if (!viableCandidate) {
    const requestedModelId = rankedCandidates[0]?.modelId ?? '__default__';
    throw new ModelPolicyResolutionError(
      'no_viable_substitute',
      { kind: 'pinned', modelId: requestedModelId },
      requestedModelId,
      mapExclusionReasonToFallbackReason(rankedCandidates[0]?.exclusionReason),
      'No viable default model is available for the supplied policy context.',
    );
  }

  return {
    selector: { kind: 'pinned', modelId: viableCandidate.modelId },
    layer: 'default',
  };
}

function selectRequestedResolution(
  workspaceSelector: ModelSelector | undefined,
  userOverride: ModelSelector | undefined,
  parent: ResolvedModel | undefined,
  parentContextId: string | undefined,
  parentResolvedModelId: string | undefined,
  policyContext: ResolveEffectiveModelPolicyContext,
): SelectedResolution {
  const inheritedParent = parent
    ?? parentFromResolvedModelId(parentResolvedModelId)
    ?? parentFromResolvedModelId(process.env.WAVEMILL_RESOLVED_MODEL);

  if (userOverride && userOverride.kind !== 'inherit') {
    return { selector: userOverride, layer: 'user' };
  }

  if (workspaceSelector && workspaceSelector.kind !== 'inherit') {
    return { selector: workspaceSelector, layer: 'workspace' };
  }

  if (userOverride?.kind === 'inherit' || workspaceSelector?.kind === 'inherit') {
    // An explicit inherit request uses parent context when available, regardless
    // of whether it came from a checked-in selector or a caller override.
    if (inheritedParent) {
      return {
        selector: { kind: 'inherit' },
        layer: 'parent',
        context: {
          parent: inheritedParent,
          parentContextId,
        },
      };
    }

    return selectDefaultResolution(policyContext);
  }

  return selectDefaultResolution(policyContext);
}

function didPolicyIntervene(
  baseline: ResolvedModel,
  resolved: ResolvedModel,
): boolean {
  return (
    baseline.resolved !== resolved.resolved ||
    baseline.source !== resolved.source ||
    baseline.fallbackReason !== resolved.fallbackReason
  );
}

/**
 * Resolve a subagent's effective model using three ordered layers:
 * checked-in workspace selector, caller-provided user override, and
 * runtime policy enforcement. The helper is pure and expects callers
 * to pass any config, CLI, session, or quota inputs explicitly.
 */
export function resolveEffectiveModel(
  input: ResolveEffectiveModelInput,
): EffectiveResolvedModel {
  const workspaceSelector = normalizeSelector(input.workspaceSelector);
  const userOverride = normalizeSelector(input.userOverride);
  const selection = selectRequestedResolution(
    workspaceSelector,
    userOverride,
    input.parent,
    input.parentContextId,
    input.parentResolvedModelId,
    input.policyContext,
  );

  const baseline = resolveSelector(selection.selector, selection.context);
  const resolved = resolveSelectorWithPolicy(
    selection.selector,
    selection.context,
    input.policyContext,
  );

  return {
    ...resolved,
    resolutionLayer: didPolicyIntervene(baseline, resolved) ? 'policy' : selection.layer,
  };
}
