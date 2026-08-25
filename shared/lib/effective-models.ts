import { applyModelExclusions, type ModelExclusionDiagnostic } from './model-exclusions.ts';
import {
  DEFAULT_MODEL_REGISTRY,
  explainModelSupportExclusion,
  getModel,
  normalizeSupportedModelStage,
  resolveProviderNativeModelId,
  type AgentType,
  type ModelCapabilities,
  type ModelRegistry,
  type NativeProviderName,
  type PiTransportKind,
  type SupportedModelStage,
  type DescriptorModelStage,
  type RegistryTaskType,
} from './model-registry.ts';
import { resolveModelAgent, type AgentResolutionPhase, type AgentResolution } from './model-agent-resolution.ts';
import { evaluateNativeProviderGate, type NativeGateDecision } from './native-agent/certification/eligibility-gate.ts';
import type { CertificationPhase } from './native-agent/certification/schema.ts';

export type EffectiveModelAvailabilityReason =
  | 'available'
  | 'unknown-model'
  | 'blocked-lifecycle'
  | 'disabled'
  | 'stage-incompatible'
  | 'tool-support-insufficient'
  | 'context-window-insufficient'
  | 'routing-ineligible'
  | 'policy-excluded'
  | 'runtime-unavailable';

export interface EffectiveModelIdentity {
  modelId: string;
  wavemillAlias: string;
  providerNativeId: string;
  provider?: NativeProviderName;
  transport?: PiTransportKind;
  agent?: AgentType;
}

export interface EffectiveModelAvailability {
  available: boolean;
  modelId: string;
  stage: SupportedModelStage;
  reason: EffectiveModelAvailabilityReason;
  identity?: EffectiveModelIdentity;
  capabilities?: ModelCapabilities;
  exclusion?: ModelExclusionDiagnostic;
  nativeGate?: NativeGateDecision;
}

export interface EffectiveModelOptions {
  repoDir?: string;
  registry?: ModelRegistry;
  now?: Date;
  requireRuntimeReady?: boolean;
  apiKeyPresent?: boolean;
  apiKeyEnv?: string;
  certificationRoot?: string;
}

const STAGE_TO_CERTIFICATION_PHASE: Record<SupportedModelStage, CertificationPhase> = {
  expansion: 'read-only',
  planning: 'workflow',
  coding: 'patch',
  review: 'read-only',
};

export function getGlobalModelRegistry(): ModelRegistry {
  return DEFAULT_MODEL_REGISTRY;
}

function registryFromOptions(opts?: EffectiveModelOptions): ModelRegistry {
  return opts?.registry ?? getGlobalModelRegistry();
}

export function resolveEffectiveModelIdentity(
  modelId: string,
  opts?: Pick<EffectiveModelOptions, 'registry' | 'now'>,
): EffectiveModelIdentity | undefined {
  const registry = registryFromOptions(opts);
  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return undefined;
  }
  const providerIdentity = resolveProviderNativeModelId(modelId, registry);
  const agentResolution = resolveModelAgent({
    model: modelId,
    phase: 'coding',
    registry,
    now: opts?.now,
  });
  return {
    modelId,
    wavemillAlias: providerIdentity?.wavemillAlias ?? modelId,
    providerNativeId: providerIdentity?.providerNativeId ?? modelId,
    ...(providerIdentity?.provider ? { provider: providerIdentity.provider } : {}),
    ...(providerIdentity?.transport ? { transport: providerIdentity.transport } : {}),
    ...(agentResolution.ok ? { agent: agentResolution.agent } : {}),
  };
}

export function explainEffectiveModelAvailability(
  modelId: string,
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions = {},
): EffectiveModelAvailability {
  const registry = registryFromOptions(opts);
  const normalizedStage = normalizeSupportedModelStage(stage);
  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return { available: false, modelId, stage: normalizedStage, reason: 'unknown-model' };
  }

  const supportReason = explainModelSupportExclusion(modelId, normalizedStage, registry);
  if (supportReason) {
    return {
      available: false,
      modelId,
      stage: normalizedStage,
      reason: supportReason as EffectiveModelAvailabilityReason,
      capabilities,
      identity: resolveEffectiveModelIdentity(modelId, { registry, now: opts.now }),
    };
  }

  const exclusion = opts.repoDir ? applyModelExclusions([modelId], normalizedStage, opts.repoDir).exclusions[0] : undefined;
  if (exclusion) {
    return {
      available: false,
      modelId,
      stage: normalizedStage,
      reason: 'policy-excluded',
      capabilities,
      identity: resolveEffectiveModelIdentity(modelId, { registry, now: opts.now }),
      exclusion,
    };
  }

  let nativeGate: NativeGateDecision | undefined;
  if (opts.requireRuntimeReady && capabilities.nativeCapability?.nativeProvider) {
    nativeGate = evaluateNativeProviderGate({
      modelId,
      mode: 'task',
      requiredPhase: STAGE_TO_CERTIFICATION_PHASE[normalizedStage],
      registry,
      repoDir: opts.repoDir,
      apiKeyPresent: opts.apiKeyPresent ?? true,
      apiKeyEnv: opts.apiKeyEnv ?? 'RUNTIME_READINESS_UNSPECIFIED',
      now: opts.now,
      certificationRoot: opts.certificationRoot,
    });
    if (!nativeGate.ok) {
      return {
        available: false,
        modelId,
        stage: normalizedStage,
        reason: 'runtime-unavailable',
        capabilities,
        identity: resolveEffectiveModelIdentity(modelId, { registry, now: opts.now }),
        nativeGate,
      };
    }
  }

  return {
    available: true,
    modelId,
    stage: normalizedStage,
    reason: 'available',
    capabilities,
    identity: resolveEffectiveModelIdentity(modelId, { registry, now: opts.now }),
    ...(nativeGate ? { nativeGate } : {}),
  };
}

/**
 * Exclusion reasons a challenger arm is allowed to carry.
 *
 * A challenge pair is the mechanism for gathering evidence about an unproven
 * model: the primary is always a proven model and the challenger is the
 * experiment. Refusing provisional models here means the one mechanism designed
 * to evaluate an unknown model cannot be pointed at one.
 *
 * Narrow on purpose. It permits *only* provisional identity, and only for the
 * challenger pool -- `listEffectiveModelsForStage` is untouched, so primaries
 * and every routing path still exclude provisional models entirely. Their
 * evidence also stays held: evaluateEvidenceEligibility reports
 * `provisional_model_identity` / `provisional-observation-only`, so records are
 * written but never feed routing, training, or launch-priority persistence.
 */
const CHALLENGER_PERMITTED_EXCLUSIONS: ReadonlySet<string> = new Set(['provisional-identity']);

/**
 * Models eligible to run as the *challenger* arm of a challenge pair.
 *
 * Identical to `listEffectiveModelsForStage` except that provisional identities
 * are permitted. Never use this to choose a primary.
 */
export function listChallengerEligibleModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions = {},
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  return listModelsForStage(stage, opts, CHALLENGER_PERMITTED_EXCLUSIONS);
}

export function listEffectiveModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions = {},
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  return listModelsForStage(stage, opts, undefined);
}

function listModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions,
  permittedExclusions: ReadonlySet<string> | undefined,
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  const registry = registryFromOptions(opts);
  const normalizedStage = normalizeSupportedModelStage(stage);
  const supported = Object.entries(registry.models)
    .filter(([modelId]) => {
      const exclusion = explainModelSupportExclusion(modelId, normalizedStage, registry);
      if (exclusion === undefined) return true;
      return permittedExclusions?.has(exclusion) === true;
    })
    .filter(([, capabilities]) => {
      const configuredStages = capabilities.supportedModel?.stages;
      if (configuredStages) {
        return configuredStages.includes(normalizedStage);
      }
      const score = capabilities.qualityScores?.[normalizedStage as RegistryTaskType];
      return typeof score === 'number' ? score > 0 : true;
    })
    .map(([modelId]) => modelId);
  const exclusionFiltered = opts.repoDir
    ? applyModelExclusions(supported, normalizedStage, opts.repoDir)
    : { models: supported, exclusions: [] };
  return {
    models: exclusionFiltered.models,
    exclusions: exclusionFiltered.exclusions,
  };
}

export function listEffectiveNativeProviderModels(
  provider: NativeProviderName,
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions = {},
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  const registry = registryFromOptions(opts);
  const stagePool = listEffectiveModelsForStage(stage, { ...opts, registry });
  return {
    models: stagePool.models.filter((modelId) => registry.models[modelId]?.nativeCapability?.nativeProvider === provider),
    exclusions: stagePool.exclusions,
  };
}

export function resolveEffectiveAgent(
  modelId: string,
  phase: AgentResolutionPhase,
  opts?: Pick<EffectiveModelOptions, 'registry' | 'now'>,
): AgentResolution {
  return resolveModelAgent({
    model: modelId,
    phase,
    registry: registryFromOptions(opts),
    now: opts?.now,
  });
}
