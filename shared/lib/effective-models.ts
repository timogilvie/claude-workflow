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
      ...(normalizedStage === 'coding' ? { launchPhase: 'coding' as const } : {}),
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
 * Models eligible to run as the *challenger* arm of a challenge pair.
 *
 * This intentionally matches `listEffectiveModelsForStage`: automated
 * challenge selection may not bypass the same stage projection enforced by
 * native launch preflight. A model with `launchEligible: true` and
 * `routingEligible: false` may still be named by explicit tooling outside this
 * scheduler, but Wavemill challenge arms cannot auto-select it.
 */
export function listChallengerEligibleModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions = {},
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  return listEffectiveModelsForStage(stage, opts);
}

export function listEffectiveModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions = {},
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  return listModelsForStage(stage, opts);
}

function listModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  opts: EffectiveModelOptions,
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  const registry = registryFromOptions(opts);
  const normalizedStage = normalizeSupportedModelStage(stage);
  const supported = Object.entries(registry.models)
    .filter(([modelId]) => {
      const exclusion = explainModelSupportExclusion(modelId, normalizedStage, registry);
      return exclusion === undefined;
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
