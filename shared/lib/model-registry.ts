import { filterDisabledModels } from './disabled-models.ts';
import {
  CERTIFICATION_TTL_DAYS,
  PHASE_ORDER,
  phaseSatisfies,
  type CertificationPhase,
} from './native-agent/certification/schema.ts';
import { resolveWavemillAliasFromOpenRouterId } from './openrouter-catalog.ts';

export type ModelClass = 'frontier' | 'strong_generalist' | 'fast_economy';
export type RegistryTaskType = 'routing' | 'planning' | 'coding' | 'review' | 'classify';
export type DescriptorModelStage = 'planner' | 'coder' | 'reviewer';
export type ToolSupport = 'none' | 'basic' | 'full';
export type LatencyTier = 'fast' | 'standard' | 'slow';
export type ReasoningTier = 'basic' | 'standard' | 'advanced';
export type Channel = 'stable' | 'preview' | 'experimental';
export const CHANNELS: readonly Channel[] = Object.freeze(['stable', 'preview', 'experimental'] as const);
export type NativeProviderName = 'openai' | 'openrouter';
export type PiTransportKind = 'openai-responses' | 'openai-completions';
export type ReadOnlyNativeCapability = 'certified' | 'unsupported' | 'partial';
export type ModelLifecycleStatus = 'supported' | 'deprecated' | 'blocked';
export type SupportedModelStage = 'expansion' | 'planning' | 'coding' | 'review';
export type ModelSupportExclusionReason =
  | 'unknown-model'
  | 'blocked-lifecycle'
  | 'disabled'
  | 'stage-incompatible'
  | 'tool-support-insufficient'
  | 'context-window-insufficient'
  | 'routing-ineligible';
export type AgentType =
  | 'claude'
  | 'codex'
  | 'claude-openrouter'
  | 'native-openai'
  | 'native-openrouter';
export type CapabilityConstraintName =
  | 'minContextWindow'
  | 'requiresTools'
  | 'requiresMultimodal'
  | 'maxLatencyTier';

export interface MultimodalSupport {
  text: boolean;
  image: boolean;
  audio?: boolean;
  video?: boolean;
}

export interface PiCompatFlags {
  thinkingFormat?: 'openrouter';
  [key: string]: unknown;
}

export interface NativeCertificationMetadata {
  maxCertifiedPhase: CertificationPhase;
  certifiedAt: string;
  certificationSuiteVersion: string;
  knownLimitations?: string[];
}

/**
 * Registry-native metadata for Pi-backed providers.
 *
 * Mapping table:
 * - `openai` + `openai-responses` => `certified`
 * - `openrouter` + `openai-completions` + `thinkingFormat=openrouter` => `certified`
 * - `openrouter` + `openai-completions` without that compat flag => `partial`
 * - all other combinations => `unsupported`
 */
export interface NativeCapability {
  nativeProvider: NativeProviderName;
  piTransportKind: PiTransportKind;
  readOnlyNative: ReadOnlyNativeCapability;
  compatFlags?: PiCompatFlags;
  limitations?: string[];
  certification?: NativeCertificationMetadata;
}

export interface SupportedModelMetadata {
  wavemillAlias?: string;
  providerNativeId?: string;
  provider?: NativeProviderName;
  transport?: PiTransportKind;
  stages?: SupportedModelStage[];
  requiredCertificationPhaseByStage?: Partial<Record<SupportedModelStage, CertificationPhase>>;
  certificationSuiteVersion?: string;
  certificationFreshnessDays?: number;
  canonicalArtifactIdentity?: {
    provider: string;
    model: string;
    suiteVersion: string;
  };
  lifecycle?: ModelLifecycleStatus;
  compatibilityFlags?: PiCompatFlags;
  limitations?: string[];
  launchEligible?: boolean;
  routingEligible?: boolean;
}

/** Account/surface capability for hosted Codex launches (not native OpenAI). */
export interface CodexChatgptCapability {
  supported: boolean;
  reason?: string;
}

export interface ModelCapabilities {
  vendor: string;
  class: ModelClass;
  strengths: string[];
  weaknesses: string[];
  disabled?: boolean;
  qualityScores: Record<RegistryTaskType, number>;
  pricing?: {
    inputCostPerMTok: number;
    outputCostPerMTok: number;
    cacheWriteCostPerMTok?: number;
    cacheReadCostPerMTok?: number;
  };
  defaultLadderEligible?: boolean;
  contextWindowTokens: number;
  toolSupport: ToolSupport;
  multimodal: MultimodalSupport;
  latencyTier: LatencyTier;
  reasoningTier: ReasoningTier;
  costPerMillionInputTokensUsd: number;
  costPerMillionOutputTokensUsd: number;
  agent?: AgentType;
  codexChatgptCapability?: CodexChatgptCapability;
  nativeCapability?: NativeCapability;
  supportedModel?: SupportedModelMetadata;
  /**
   * ISO date the model became generally available. Drives the recency-aware
   * exploration boost (router.exploration.newModelBoost) and challenge
   * scheduler prioritization. Unset means no recency treatment.
   */
  releasedAt?: string;
}

export interface ModelRegistry {
  models: Record<string, ModelCapabilities>;
  ladders: Partial<Record<RegistryTaskType, string[]>>;
}

export interface CapabilityConstraints {
  minContextWindow?: number;
  requiresTools?: boolean;
  requiresMultimodal?: boolean;
  maxLatencyTier?: LatencyTier;
}

export interface CapabilityFilterResult {
  satisfied: boolean;
  failedConstraints: CapabilityConstraintName[];
}

const TASK_TYPES: RegistryTaskType[] = ['routing', 'planning', 'coding', 'review', 'classify'];
export const CLASS_RANK: Record<ModelClass, number> = {
  frontier: 3,
  strong_generalist: 2,
  fast_economy: 1,
};
const LATENCY_TIER_RANK: Record<LatencyTier, number> = {
  fast: 0,
  standard: 1,
  slow: 2,
};
const warnedUnknownLadders = new Set<string>();
const DESCRIPTOR_STAGE_TO_TASK_TYPE: Record<DescriptorModelStage, RegistryTaskType> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};
const READ_ONLY_NATIVE_CAPABILITIES: readonly ReadOnlyNativeCapability[] = ['certified', 'unsupported', 'partial'];
const PI_TRANSPORT_KINDS: readonly PiTransportKind[] = ['openai-responses', 'openai-completions'];
const CERTIFICATION_PHASES: readonly CertificationPhase[] = PHASE_ORDER;
const MODEL_LIFECYCLE_STATUSES: readonly ModelLifecycleStatus[] = ['supported', 'deprecated', 'blocked'];
const SUPPORTED_MODEL_STAGES: readonly SupportedModelStage[] = ['expansion', 'planning', 'coding', 'review'];
const STAGE_REQUIRES_TOOLS: Record<SupportedModelStage, boolean> = {
  expansion: true,
  planning: true,
  coding: true,
  review: true,
};
const INSUFFICIENT_TOOL_SUPPORT: ReadonlySet<ToolSupport> = new Set(['none']);

/**
 * Minimum context window size requirements per stage, derived from measured prompt sizes.
 * 
 * For coding stage: 144,384 tokens derived from the 2026-08-17 kimi-k2 incident (~131,182 tokens)
 * with 10% headroom (matching CONTEXT_WINDOW_SAFETY_MARGIN) = 144,300.2, rounded up to nearest 1024.
 * 
 * Other stages have no floor initially as we have no measured prompt-size data.
 * 
 * Relationship to evaluateCapabilityConstraints: That function implements heuristic,
 * config-gated constraints based on cost-profile estimates. This gate is unconditional
 * and based on actual measured prompt sizes. They are complementary, not duplicates.
 */
export interface StageContextWindowFloor {
  floorTokens: number;
  derivation: {
    observedMaxPromptTokens: number;
    sampleCount: number;
    observationWindow: string;   // e.g. '2026-08-17 incident' or '2026-07-01..2026-08-19 transcripts'
    headroomFraction: number;    // e.g. 0.10
    derivedAt: string;           // ISO date
    method: string;              // human-readable formula
  };
}

export const STAGE_CONTEXT_WINDOW_FLOORS: Partial<Record<SupportedModelStage, StageContextWindowFloor>> = {
  coding: {
    floorTokens: 144_384,
    derivation: {
      observedMaxPromptTokens: 131_182,
      sampleCount: 1,
      observationWindow: '2026-08-17 incident',
      headroomFraction: 0.10,
      derivedAt: '2026-08-18',
      method: 'observedMaxPromptTokens * (1 + headroomFraction), rounded up to nearest 1024',
    },
  },
  // No floor for planning, review, expansion stages initially - no measured data yet
};

export function getStageContextWindowFloor(stage: SupportedModelStage): number | undefined {
  return STAGE_CONTEXT_WINDOW_FLOORS[stage]?.floorTokens;
}

export function hasSufficientContextWindow(
  capabilities: Pick<ModelCapabilities, 'contextWindowTokens'>,
  stage: SupportedModelStage,
): boolean {
  const floor = getStageContextWindowFloor(stage);
  // Fail-open: if no floor is defined for the stage, all models are considered sufficient
  if (floor === undefined) {
    return true;
  }
  return capabilities.contextWindowTokens >= floor;
}
const UNSAFE_CERTIFICATION_SEGMENT = /[/\\.\0]/;
const OPENROUTER_CERTIFICATION_SEED = Object.freeze({
  maxCertifiedPhase: 'workflow' as const,
  certifiedAt: '2026-07-15T00:00:00.000Z',
  certificationSuiteVersion: 'v2',
});

const OPENROUTER_NATIVE_CAPABILITY: NativeCapability = Object.freeze({
  nativeProvider: 'openrouter',
  piTransportKind: 'openai-completions',
  readOnlyNative: 'certified',
  compatFlags: Object.freeze({ thinkingFormat: 'openrouter' }),
  certification: OPENROUTER_CERTIFICATION_SEED,
});

interface CodexChatgptCapabilityOverride {
  supported?: boolean;
  reason?: string;
}

interface NativeCapabilityOverride {
  nativeProvider?: NativeProviderName;
  piTransportKind?: PiTransportKind;
  readOnlyNative?: ReadOnlyNativeCapability;
  compatFlags?: PiCompatFlags;
  limitations?: string[];
  certification?: Partial<NativeCertificationMetadata>;
}

interface ModelCapabilitiesOverride {
  vendor?: string;
  class?: ModelClass;
  strengths?: string[];
  weaknesses?: string[];
  disabled?: boolean;
  qualityScores?: Partial<Record<RegistryTaskType, number>>;
  pricing?: ModelCapabilities['pricing'];
  defaultLadderEligible?: boolean;
  contextWindowTokens?: number;
  toolSupport?: ToolSupport;
  multimodal?: MultimodalSupport;
  latencyTier?: LatencyTier;
  reasoningTier?: ReasoningTier;
  costPerMillionInputTokensUsd?: number;
  costPerMillionOutputTokensUsd?: number;
  agent?: AgentType;
  codexChatgptCapability?: CodexChatgptCapabilityOverride;
  nativeCapability?: NativeCapabilityOverride;
  supportedModel?: Partial<SupportedModelMetadata>;
  releasedAt?: string;
}

function openRouterSupportedModel(input: {
  alias: string;
  providerNativeId: string;
  stages: SupportedModelStage[];
  lifecycle?: ModelLifecycleStatus;
}): SupportedModelMetadata {
  const [provider, model] = input.providerNativeId.split('/');
  return {
    wavemillAlias: input.alias,
    providerNativeId: input.providerNativeId,
    provider: 'openrouter',
    transport: 'openai-completions',
    stages: input.stages,
    requiredCertificationPhaseByStage: {
      planning: 'workflow',
      coding: 'patch',
      review: 'read-only',
    },
    certificationSuiteVersion: OPENROUTER_CERTIFICATION_SEED.certificationSuiteVersion,
    certificationFreshnessDays: CERTIFICATION_TTL_DAYS,
    canonicalArtifactIdentity: provider && model
      ? { provider, model, suiteVersion: OPENROUTER_CERTIFICATION_SEED.certificationSuiteVersion }
      : undefined,
    lifecycle: input.lifecycle ?? 'supported',
    compatibilityFlags: { thinkingFormat: 'openrouter' },
    launchEligible: true,
    routingEligible: true,
  };
}

function cloneCompatFlags(compatFlags: PiCompatFlags | undefined): PiCompatFlags | undefined {
  return compatFlags ? { ...compatFlags } : undefined;
}

function cloneCertificationMetadata(
  certification: NativeCertificationMetadata | undefined,
): NativeCertificationMetadata | undefined {
  if (!certification) {
    return undefined;
  }

  return {
    maxCertifiedPhase: certification.maxCertifiedPhase,
    certifiedAt: certification.certifiedAt,
    certificationSuiteVersion: certification.certificationSuiteVersion,
    knownLimitations: certification.knownLimitations ? [...certification.knownLimitations] : undefined,
  };
}

function cloneNativeCapability(
  capability: NativeCapability | undefined,
): NativeCapability | undefined {
  if (!capability) {
    return undefined;
  }

  return {
    nativeProvider: capability.nativeProvider,
    piTransportKind: capability.piTransportKind,
    readOnlyNative: capability.readOnlyNative,
    compatFlags: cloneCompatFlags(capability.compatFlags),
    limitations: capability.limitations ? [...capability.limitations] : undefined,
    certification: cloneCertificationMetadata(capability.certification),
  };
}

function cloneCodexChatgptCapability(
  capability: CodexChatgptCapability | undefined,
): CodexChatgptCapability | undefined {
  return capability ? { ...capability } : undefined;
}

function mergeCodexChatgptCapability(
  seed: CodexChatgptCapability | undefined,
  override: CodexChatgptCapabilityOverride | undefined,
): CodexChatgptCapability | undefined {
  if (!override) return cloneCodexChatgptCapability(seed);
  return { supported: override.supported ?? seed?.supported ?? false, reason: override.reason ?? seed?.reason };
}

function mergeNativeCapability(
  seed: NativeCapability | undefined,
  override: NativeCapabilityOverride,
): NativeCapability {
  const merged: Partial<NativeCapability> = {
    nativeProvider: override.nativeProvider ?? seed?.nativeProvider,
    piTransportKind: override.piTransportKind ?? seed?.piTransportKind,
    readOnlyNative: override.readOnlyNative ?? seed?.readOnlyNative,
    compatFlags: override.compatFlags
      ? cloneCompatFlags(override.compatFlags)
      : cloneCompatFlags(seed?.compatFlags),
    limitations: override.limitations
      ? [...override.limitations]
      : seed?.limitations
      ? [...seed.limitations]
      : undefined,
    certification: override.certification
      ? {
        maxCertifiedPhase: override.certification.maxCertifiedPhase ?? seed?.certification?.maxCertifiedPhase,
        certifiedAt: override.certification.certifiedAt ?? seed?.certification?.certifiedAt,
        certificationSuiteVersion:
          override.certification.certificationSuiteVersion ?? seed?.certification?.certificationSuiteVersion,
        knownLimitations: override.certification.knownLimitations
          ? [...override.certification.knownLimitations]
          : seed?.certification?.knownLimitations
          ? [...seed.certification.knownLimitations]
          : undefined,
      }
      : cloneCertificationMetadata(seed?.certification),
  };

  return merged as NativeCapability;
}

function scores(
  routing: number,
  planning: number,
  coding: number,
  review: number,
  classify: number,
): Record<RegistryTaskType, number> {
  return { routing, planning, coding, review, classify };
}

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    vendor: capabilities.vendor,
    class: capabilities.class,
    strengths: [...capabilities.strengths],
    weaknesses: [...capabilities.weaknesses],
    disabled: capabilities.disabled,
    qualityScores: { ...capabilities.qualityScores },
    pricing: capabilities.pricing ? { ...capabilities.pricing } : undefined,
    defaultLadderEligible: capabilities.defaultLadderEligible,
    contextWindowTokens: capabilities.contextWindowTokens,
    toolSupport: capabilities.toolSupport,
    multimodal: { ...capabilities.multimodal },
    latencyTier: capabilities.latencyTier,
    reasoningTier: capabilities.reasoningTier,
    costPerMillionInputTokensUsd: capabilities.costPerMillionInputTokensUsd,
    costPerMillionOutputTokensUsd: capabilities.costPerMillionOutputTokensUsd,
    agent: capabilities.agent,
    codexChatgptCapability: cloneCodexChatgptCapability(capabilities.codexChatgptCapability),
    nativeCapability: cloneNativeCapability(capabilities.nativeCapability),
    supportedModel: cloneSupportedModelMetadata(capabilities.supportedModel),
    releasedAt: capabilities.releasedAt,
  };
}

function cloneSupportedModelMetadata(
  metadata: SupportedModelMetadata | undefined,
): SupportedModelMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  return {
    wavemillAlias: metadata.wavemillAlias,
    providerNativeId: metadata.providerNativeId,
    provider: metadata.provider,
    transport: metadata.transport,
    stages: metadata.stages ? [...metadata.stages] : undefined,
    requiredCertificationPhaseByStage: metadata.requiredCertificationPhaseByStage
      ? { ...metadata.requiredCertificationPhaseByStage }
      : undefined,
    certificationSuiteVersion: metadata.certificationSuiteVersion,
    certificationFreshnessDays: metadata.certificationFreshnessDays,
    canonicalArtifactIdentity: metadata.canonicalArtifactIdentity
      ? { ...metadata.canonicalArtifactIdentity }
      : undefined,
    lifecycle: metadata.lifecycle,
    compatibilityFlags: metadata.compatibilityFlags ? { ...metadata.compatibilityFlags } : undefined,
    limitations: metadata.limitations ? [...metadata.limitations] : undefined,
    launchEligible: metadata.launchEligible,
    routingEligible: metadata.routingEligible,
  };
}

function cloneRegistry(registry: ModelRegistry): ModelRegistry {
  return {
    models: Object.fromEntries(
      Object.entries(registry.models).map(([modelId, capabilities]) => [modelId, cloneCapabilities(capabilities)])
    ),
    ladders: Object.fromEntries(
      Object.entries(registry.ladders).map(([taskType, ladder]) => [taskType, [...ladder]])
    ) as Partial<Record<RegistryTaskType, string[]>>,
  };
}

function dedupeModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const modelId of modelIds) {
    if (typeof modelId !== 'string' || modelId.length === 0 || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    deduped.push(modelId);
  }

  return deduped;
}

export function hasCapabilityConstraints(
  constraints?: CapabilityConstraints,
): constraints is CapabilityConstraints {
  if (!constraints) {
    return false;
  }

  return (
    constraints.minContextWindow !== undefined
    || constraints.requiresTools === true
    || constraints.requiresMultimodal === true
    || constraints.maxLatencyTier !== undefined
  );
}

export function compareLatencyTier(left: LatencyTier, right: LatencyTier): number {
  return LATENCY_TIER_RANK[left] - LATENCY_TIER_RANK[right];
}

export function evaluateCapabilityConstraints(
  model: Partial<ModelCapabilities>,
  constraints?: CapabilityConstraints,
): CapabilityFilterResult {
  if (!hasCapabilityConstraints(constraints)) {
    return { satisfied: true, failedConstraints: [] };
  }

  const failedConstraints: CapabilityConstraintName[] = [];

  if (
    constraints.minContextWindow !== undefined
    && (
      typeof model.contextWindowTokens !== 'number'
      || !Number.isFinite(model.contextWindowTokens)
      || model.contextWindowTokens < constraints.minContextWindow
    )
  ) {
    failedConstraints.push('minContextWindow');
  }

  if (
    constraints.requiresTools === true
    && (model.toolSupport === undefined || model.toolSupport === 'none')
  ) {
    failedConstraints.push('requiresTools');
  }

  if (
    constraints.requiresMultimodal === true
    && model.multimodal?.image !== true
  ) {
    failedConstraints.push('requiresMultimodal');
  }

  if (
    constraints.maxLatencyTier !== undefined
    && (
      model.latencyTier === undefined
      || compareLatencyTier(model.latencyTier, constraints.maxLatencyTier) > 0
    )
  ) {
    failedConstraints.push('maxLatencyTier');
  }

  return {
    satisfied: failedConstraints.length === 0,
    failedConstraints,
  };
}

export function satisfiesCapabilities(
  model: Partial<ModelCapabilities>,
  constraints?: CapabilityConstraints,
): boolean {
  return evaluateCapabilityConstraints(model, constraints).satisfied;
}

function makeDefaultCapabilities(override?: ModelCapabilitiesOverride): ModelCapabilities {
  return {
    vendor: override?.vendor ?? 'custom',
    class: override?.class ?? 'strong_generalist',
    strengths: override?.strengths ? [...override.strengths] : [],
    weaknesses: override?.weaknesses ? [...override.weaknesses] : [],
    disabled: override?.disabled,
    qualityScores: {
      routing: 0,
      planning: 0,
      coding: 0,
      review: 0,
      classify: 0,
      ...override?.qualityScores,
    },
    pricing: override?.pricing ? { ...override.pricing } : undefined,
    defaultLadderEligible: override?.defaultLadderEligible ?? true,
    contextWindowTokens: override?.contextWindowTokens ?? 128_000,
    toolSupport: override?.toolSupport ?? 'full',
    multimodal: override?.multimodal ? { ...override.multimodal } : { text: true, image: false },
    latencyTier: override?.latencyTier ?? 'standard',
    reasoningTier: override?.reasoningTier ?? 'standard',
    costPerMillionInputTokensUsd: override?.costPerMillionInputTokensUsd ?? 0,
    costPerMillionOutputTokensUsd: override?.costPerMillionOutputTokensUsd ?? 0,
    agent: override?.agent,
    codexChatgptCapability: override?.codexChatgptCapability
      ? mergeCodexChatgptCapability(undefined, override.codexChatgptCapability)
      : undefined,
    releasedAt: override?.releasedAt,
  };
}

function mergeCapabilities(
  base: ModelCapabilities | undefined,
  override: ModelCapabilitiesOverride,
): ModelCapabilities {
  const seed = base ? cloneCapabilities(base) : makeDefaultCapabilities(override);

  return {
    vendor: override.vendor ?? seed.vendor,
    class: override.class ?? seed.class,
    strengths: override.strengths ? [...override.strengths] : seed.strengths,
    weaknesses: override.weaknesses ? [...override.weaknesses] : seed.weaknesses,
    disabled: override.disabled ?? seed.disabled,
    qualityScores: {
      ...seed.qualityScores,
      ...override.qualityScores,
    },
    pricing: override.pricing ? { ...override.pricing } : seed.pricing ? { ...seed.pricing } : undefined,
    defaultLadderEligible: override.defaultLadderEligible ?? seed.defaultLadderEligible ?? true,
    contextWindowTokens: override.contextWindowTokens ?? seed.contextWindowTokens,
    toolSupport: override.toolSupport ?? seed.toolSupport,
    multimodal: override.multimodal ? { ...override.multimodal } : { ...seed.multimodal },
    latencyTier: override.latencyTier ?? seed.latencyTier,
    reasoningTier: override.reasoningTier ?? seed.reasoningTier,
    costPerMillionInputTokensUsd: override.costPerMillionInputTokensUsd ?? seed.costPerMillionInputTokensUsd,
    costPerMillionOutputTokensUsd: override.costPerMillionOutputTokensUsd ?? seed.costPerMillionOutputTokensUsd,
    agent: override.agent ?? seed.agent,
    codexChatgptCapability: mergeCodexChatgptCapability(seed.codexChatgptCapability, override.codexChatgptCapability),
    nativeCapability: override.nativeCapability
      ? mergeNativeCapability(seed.nativeCapability, override.nativeCapability)
      : cloneNativeCapability(seed.nativeCapability),
    supportedModel: override.supportedModel
      ? {
        ...cloneSupportedModelMetadata(seed.supportedModel),
        ...override.supportedModel,
        stages: override.supportedModel.stages
          ? [...override.supportedModel.stages]
          : seed.supportedModel?.stages
          ? [...seed.supportedModel.stages]
          : undefined,
        requiredCertificationPhaseByStage: override.supportedModel.requiredCertificationPhaseByStage
          ? { ...override.supportedModel.requiredCertificationPhaseByStage }
          : seed.supportedModel?.requiredCertificationPhaseByStage
          ? { ...seed.supportedModel.requiredCertificationPhaseByStage }
          : undefined,
        canonicalArtifactIdentity: override.supportedModel.canonicalArtifactIdentity
          ? { ...override.supportedModel.canonicalArtifactIdentity }
          : seed.supportedModel?.canonicalArtifactIdentity
          ? { ...seed.supportedModel.canonicalArtifactIdentity }
          : undefined,
        compatibilityFlags: override.supportedModel.compatibilityFlags
          ? { ...override.supportedModel.compatibilityFlags }
          : seed.supportedModel?.compatibilityFlags
          ? { ...seed.supportedModel.compatibilityFlags }
          : undefined,
        limitations: override.supportedModel.limitations
          ? [...override.supportedModel.limitations]
          : seed.supportedModel?.limitations
          ? [...seed.supportedModel.limitations]
          : undefined,
      }
      : cloneSupportedModelMetadata(seed.supportedModel),
    releasedAt: override.releasedAt ?? seed.releasedAt,
  };
}

/**
 * Pure derivation for native read-only capability from provider metadata.
 *
 * Mapping table:
 * - `openai` + `openai-responses` => `certified`
 * - `openrouter` + `openai-completions` + `thinkingFormat=openrouter` => `certified`
 * - `openrouter` + `openai-completions` without that compat flag => `partial`
 * - missing provider or transport, or any other combination => `unsupported`
 */
export function deriveReadOnlyNativeCapability(input: {
  nativeProvider?: NativeProviderName;
  piTransportKind?: PiTransportKind;
  compatFlags?: PiCompatFlags;
}): { capability: ReadOnlyNativeCapability; limitations: string[] } {
  if (!input.nativeProvider) {
    return { capability: 'unsupported', limitations: ['missing nativeProvider'] };
  }

  if (!input.piTransportKind) {
    return { capability: 'unsupported', limitations: ['missing piTransportKind'] };
  }

  if (input.nativeProvider === 'openai' && input.piTransportKind === 'openai-responses') {
    return { capability: 'certified', limitations: [] };
  }

  if (input.nativeProvider === 'openrouter' && input.piTransportKind === 'openai-completions') {
    if (input.compatFlags?.thinkingFormat === 'openrouter') {
      return { capability: 'certified', limitations: [] };
    }

    return {
      capability: 'partial',
      limitations: ['missing thinkingFormat=openrouter compat flag'],
    };
  }

  return {
    capability: 'unsupported',
    limitations: [
      `unsupported native provider/transport combination: ${input.nativeProvider}/${input.piTransportKind}`,
    ],
  };
}

function warnUnknownModel(taskType: RegistryTaskType, modelId: string): void {
  const key = `${taskType}:${modelId}`;
  if (warnedUnknownLadders.has(key)) {
    return;
  }
  warnedUnknownLadders.add(key);
  console.warn(
    `Ignoring unknown model "${modelId}" in the global ${taskType} model ladder`
  );
}

function compareModels(
  taskType: RegistryTaskType,
  [leftId, left]: [string, ModelCapabilities],
  [rightId, right]: [string, ModelCapabilities],
): number {
  const scoreDelta = right.qualityScores[taskType] - left.qualityScores[taskType];
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const classDelta = CLASS_RANK[right.class] - CLASS_RANK[left.class];
  if (classDelta !== 0) {
    return classDelta;
  }

  return leftId.localeCompare(rightId);
}

export class ModelValidationError extends Error {
  readonly modelId: string;

  constructor(modelId: string, message: string) {
    super(message);
    this.name = 'ModelValidationError';
    this.modelId = modelId;
  }
}

const MODEL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\[[a-z0-9]+\])?$/;
const PINNED_MODEL_PREFIXES = ['claude-', 'gpt-', 'deepseek-', 'gemini-'] as const;

export type ModelSelector =
  | { kind: 'alias'; family: string; channel?: Channel }
  | { kind: 'pinned'; modelId: string }
  | { kind: 'inherit' };

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
export type FallbackReason = 'quota-exhausted' | 'disabled-by-policy' | 'unavailable';

export interface ResolvedModel {
  requested: ModelSelector;
  resolved: string;
  source: ResolutionSource;
  familyChannel?: Channel;
  parentContextId?: string;
  fallbackReason?: FallbackReason;
}

export interface ResolutionContext {
  parent?: ResolvedModel;
  parentContextId?: string;
}

export type ModelSelectorParseErrorCode =
  | 'empty_input'
  | 'unknown_family'
  | 'malformed_pinned_id'
  | 'unknown_channel';

export class ModelSelectorParseError extends Error {
  readonly code: ModelSelectorParseErrorCode;
  readonly input: string;

  constructor(code: ModelSelectorParseErrorCode, input: string, message: string) {
    super(message);
    this.name = 'ModelSelectorParseError';
    this.code = code;
    this.input = input;
  }
}

export type ParseModelSelectorResult =
  | { ok: true; selector: ModelSelector }
  | { ok: false; error: ModelSelectorParseError };

export type ModelResolutionErrorCode =
  | 'missing_parent'
  | 'invalid_pinned_id'
  | 'unknown_alias'
  | 'channel_unpinned';

export class ModelResolutionError extends Error {
  readonly code: ModelResolutionErrorCode;
  readonly selector: ModelSelector;

  constructor(code: ModelResolutionErrorCode, selector: ModelSelector, message: string) {
    super(message);
    this.name = 'ModelResolutionError';
    this.code = code;
    this.selector = selector;
  }
}

export const FAMILY_ALIASES = Object.freeze({
  fable: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-fable-5',
    }),
    description: 'Stable Anthropic frontier alias for the Fable family.',
  }),
  opus: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-opus-4-8',
    }),
    description: 'Stable Anthropic frontier alias for the Opus family.',
  }),
  sonnet: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-sonnet-5',
    }),
    description: 'Stable Anthropic generalist alias for the Sonnet family.',
  }),
  haiku: Object.freeze({
    channels: Object.freeze({
      stable: 'claude-haiku-4-5-20251001',
    }),
    description: 'Stable Anthropic economy alias for the Haiku family.',
  }),
  'gpt-5.5': Object.freeze({
    channels: Object.freeze({
      stable: 'gpt-5.5',
    }),
    description: 'Stable OpenAI frontier alias for the GPT-5.5 family.',
  }),
  'gpt-5.6': Object.freeze({
    channels: Object.freeze({
      stable: 'gpt-5.6-sol',
    }),
    description: 'OpenAI API alias for the GPT-5.6 family; resolves to Sol.',
  }),
  'gemini-pro': Object.freeze({
    channels: Object.freeze({
      stable: 'gemini-pro',
    }),
    description: 'Selector alias reserved for Gemini Pro integration follow-up work.',
  }),
}) satisfies Readonly<
  Record<string, { channels: Readonly<Partial<Record<Channel, string>>>; description?: string }>
>;

export const REVIEWER_ALIAS_MAP = Object.freeze({
  deep: 'claude-fable-5',
}) satisfies Readonly<Record<string, string>>;

function makeModelSelectorParseError(
  code: ModelSelectorParseErrorCode,
  input: string,
  message: string,
): ModelSelectorParseError {
  return new ModelSelectorParseError(code, input, message);
}

function isKnownFamilyAlias(family: string): boolean {
  return Object.hasOwn(FAMILY_ALIASES, family);
}

function isKnownChannel(channel: string): channel is Channel {
  return (CHANNELS as readonly string[]).includes(channel);
}

function isLikelyPinnedModelId(modelId: string): boolean {
  return PINNED_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix)) || /\d/.test(modelId);
}

function isFamilyLikeSelector(input: string): boolean {
  return /^[A-Za-z][A-Za-z0-9.-]*$/.test(input);
}

export function parseModelSelector(input: string): ParseModelSelectorResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: makeModelSelectorParseError(
        'empty_input',
        input,
        'Model selector input must not be empty.',
      ),
    };
  }

  if (trimmed === 'inherit') {
    return { ok: true, selector: { kind: 'inherit' } };
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex >= 0) {
    const family = trimmed.slice(0, colonIndex);
    const channelPart = trimmed.slice(colonIndex + 1).trim();
    if (isKnownFamilyAlias(family) && channelPart.length > 0) {
      if (!isKnownChannel(channelPart)) {
        return {
          ok: false,
          error: makeModelSelectorParseError(
            'unknown_channel',
            input,
            `Unknown channel "${channelPart}" for family "${family}". Known channels: ${CHANNELS.join(', ')}.`,
          ),
        };
      }

      return {
        ok: true,
        selector: { kind: 'alias', family, channel: channelPart },
      };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'malformed_pinned_id',
        input,
        `Invalid model selector "${trimmed}". Use "family[:channel]", "inherit", or a pinned model ID.`,
      ),
    };
  }

  if (isKnownFamilyAlias(trimmed)) {
    return { ok: true, selector: { kind: 'alias', family: trimmed, channel: 'stable' } };
  }

  // A concrete registered model ID takes precedence over the legacy
  // family-channel shorthand (for example, `gpt-5.6-terra` must not be
  // interpreted as the unsupported `gpt-5.6:terra` channel).
  if (Object.hasOwn(DEFAULT_MODEL_REGISTRY.models, trimmed)) {
    return { ok: true, selector: { kind: 'pinned', modelId: trimmed } };
  }

  for (const family of Object.keys(FAMILY_ALIASES)) {
    if (!trimmed.startsWith(`${family}-`)) {
      continue;
    }

    const channelPart = trimmed.slice(family.length + 1);
    if (isKnownChannel(channelPart)) {
      return {
        ok: true,
        selector: { kind: 'alias', family, channel: channelPart },
      };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_channel',
        input,
        `Unknown channel "${channelPart}" for family "${family}". Known channels: ${CHANNELS.join(', ')}.`,
      ),
    };
  }

  if (MODEL_ID_PATTERN.test(trimmed)) {
    if (isLikelyPinnedModelId(trimmed)) {
      return { ok: true, selector: { kind: 'pinned', modelId: trimmed } };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_family',
        input,
        `Unknown model family "${trimmed}". Add it to FAMILY_ALIASES or use a concrete pinned model ID.`,
      ),
    };
  }

  if (isFamilyLikeSelector(trimmed)) {
    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_family',
        input,
        `Unknown model family "${trimmed}". Add it to FAMILY_ALIASES or use a concrete pinned model ID.`,
      ),
    };
  }

  return {
    ok: false,
    error: makeModelSelectorParseError(
      'malformed_pinned_id',
      input,
      `Invalid pinned model ID "${trimmed}". Model IDs must be lowercase and may include digits, hyphens, dots, and one bracket suffix.`,
    ),
  };
}

export function isDeepSeekLikeModelId(modelId: string): boolean {
  return /^deepseek-/i.test(modelId);
}

export function configuredDeepSeekModelIds(registry: ModelRegistry): string[] {
  return Object.keys(registry.models)
    .filter((modelId) => modelId.startsWith('deepseek-'))
    .sort();
}

export function isKnownModelId(registry: ModelRegistry, modelId: string): boolean {
  return Object.hasOwn(registry.models, modelId);
}

export function normalizeReviewerModelId(
  input: string,
  registry: ModelRegistry,
): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (isKnownModelId(registry, trimmed)) {
    return trimmed;
  }

  const aliased = REVIEWER_ALIAS_MAP[trimmed as keyof typeof REVIEWER_ALIAS_MAP];
  if (aliased && isKnownModelId(registry, aliased)) {
    return aliased;
  }

  return null;
}

export function validateModelId(modelId: string): void {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelValidationError(
      modelId,
      `Error: Invalid model ID "${modelId}"\n\nModel IDs must be lowercase and may include digits, hyphens, dots, and a single bracket suffix like [1m].`,
    );
  }
}

function isReadOnlyNativeCapabilityValue(value: unknown): value is ReadOnlyNativeCapability {
  return typeof value === 'string' && (READ_ONLY_NATIVE_CAPABILITIES as readonly string[]).includes(value);
}

function isPiTransportKindValue(value: unknown): value is PiTransportKind {
  return typeof value === 'string' && (PI_TRANSPORT_KINDS as readonly string[]).includes(value);
}

function isCertificationPhaseValue(value: unknown): value is CertificationPhase {
  return typeof value === 'string' && (CERTIFICATION_PHASES as readonly string[]).includes(value);
}

function isSupportedModelStageValue(value: unknown): value is SupportedModelStage {
  return typeof value === 'string' && (SUPPORTED_MODEL_STAGES as readonly string[]).includes(value);
}

function isModelLifecycleStatusValue(value: unknown): value is ModelLifecycleStatus {
  return typeof value === 'string' && (MODEL_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

function isSafeCertificationSuiteVersion(value: string): boolean {
  return value.length > 0 && !UNSAFE_CERTIFICATION_SEGMENT.test(value);
}

function isSafeArtifactIdentitySegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[/\\\0]/.test(value);
}

export function validateNativeCapability(
  modelId: string,
  capabilities: Pick<ModelCapabilities, 'nativeCapability'>,
): void {
  const nativeCapability = capabilities.nativeCapability;
  if (!nativeCapability) {
    return;
  }

  if (!isReadOnlyNativeCapabilityValue(nativeCapability.readOnlyNative)) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative must be one of ${READ_ONLY_NATIVE_CAPABILITIES.join(', ')}`,
    );
  }

  if (
    (nativeCapability.readOnlyNative === 'certified' || nativeCapability.readOnlyNative === 'partial')
    && !nativeCapability.nativeProvider
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative=${nativeCapability.readOnlyNative} requires nativeProvider`,
    );
  }

  if (
    (nativeCapability.readOnlyNative === 'certified' || nativeCapability.readOnlyNative === 'partial')
    && !nativeCapability.piTransportKind
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative=${nativeCapability.readOnlyNative} requires piTransportKind`,
    );
  }

  if (
    nativeCapability.piTransportKind !== undefined
    && !isPiTransportKindValue(nativeCapability.piTransportKind)
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.piTransportKind must be one of ${PI_TRANSPORT_KINDS.join(', ')}`,
    );
  }

  const derived = deriveReadOnlyNativeCapability({
    nativeProvider: nativeCapability.nativeProvider,
    piTransportKind: nativeCapability.piTransportKind,
    compatFlags: nativeCapability.compatFlags,
  });

  if (nativeCapability.readOnlyNative !== derived.capability) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.readOnlyNative=${nativeCapability.readOnlyNative} contradicts compat flags (derived: ${derived.capability})`,
    );
  }

  const certification = nativeCapability.certification;
  if (!certification) {
    return;
  }

  if (!nativeCapability.nativeProvider) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification requires nativeProvider`,
    );
  }

  if (!nativeCapability.piTransportKind) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification requires piTransportKind`,
    );
  }

  if (nativeCapability.readOnlyNative === 'unsupported') {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification contradicts readOnlyNative=unsupported`,
    );
  }

  if (!isCertificationPhaseValue(certification.maxCertifiedPhase)) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.maxCertifiedPhase must be one of ${CERTIFICATION_PHASES.join(', ')}`,
    );
  }

  if (typeof certification.certifiedAt !== 'string' || certification.certifiedAt.length === 0 || Number.isNaN(Date.parse(certification.certifiedAt))) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.certifiedAt must be a valid ISO 8601 datetime`,
    );
  }

  if (
    typeof certification.certificationSuiteVersion !== 'string'
    || !isSafeCertificationSuiteVersion(certification.certificationSuiteVersion)
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.certificationSuiteVersion must be a non-empty safe path segment`,
    );
  }

  if (
    certification.knownLimitations !== undefined
    && (!Array.isArray(certification.knownLimitations) || !certification.knownLimitations.every((value) => typeof value === 'string'))
  ) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: nativeCapability.certification.knownLimitations must be an array of strings`,
    );
  }
}

export function validateSupportedModelMetadata(
  modelId: string,
  capabilities: Pick<ModelCapabilities, 'supportedModel' | 'nativeCapability'>,
): void {
  const metadata = capabilities.supportedModel;
  if (!metadata) {
    return;
  }

  if (metadata.lifecycle !== undefined && !isModelLifecycleStatusValue(metadata.lifecycle)) {
    throw new ModelValidationError(
      modelId,
      `model ${modelId}: supportedModel.lifecycle must be one of ${MODEL_LIFECYCLE_STATUSES.join(', ')}`,
    );
  }

  if (metadata.stages !== undefined) {
    if (!Array.isArray(metadata.stages) || !metadata.stages.every(isSupportedModelStageValue)) {
      throw new ModelValidationError(
        modelId,
        `model ${modelId}: supportedModel.stages must contain only ${SUPPORTED_MODEL_STAGES.join(', ')}`,
      );
    }
  }

  for (const [stage, phase] of Object.entries(metadata.requiredCertificationPhaseByStage ?? {})) {
    if (!isSupportedModelStageValue(stage) || !isCertificationPhaseValue(phase)) {
      throw new ModelValidationError(
        modelId,
        `model ${modelId}: supportedModel.requiredCertificationPhaseByStage has an invalid stage or phase`,
      );
    }
  }

  const identity = metadata.canonicalArtifactIdentity;
  if (identity) {
    for (const [name, value] of Object.entries(identity)) {
      if (typeof value !== 'string' || !isSafeArtifactIdentitySegment(value)) {
        throw new ModelValidationError(
          modelId,
          `model ${modelId}: supportedModel.canonicalArtifactIdentity.${name} must be a non-empty safe path segment`,
        );
      }
    }
  }
}

export function assertRegistryConsistency(registry: ModelRegistry): void {
  for (const [modelId, capabilities] of Object.entries(registry.models)) {
    validateNativeCapability(modelId, capabilities);
    validateSupportedModelMetadata(modelId, capabilities);
  }
}

export function resolveSelector(selector: ModelSelector, context?: ResolutionContext): ResolvedModel {
  switch (selector.kind) {
    case 'alias': {
      const entry = FAMILY_ALIASES[selector.family as keyof typeof FAMILY_ALIASES];
      if (!entry) {
        throw new ModelResolutionError(
          'unknown_alias',
          selector,
          `Unknown model family alias "${selector.family}". Known aliases: ${Object.keys(FAMILY_ALIASES).join(', ')}.`,
        );
      }
      const channel: Channel = selector.channel ?? 'stable';
      const resolvedModelId = entry.channels[channel];
      if (resolvedModelId === undefined) {
        throw new ModelResolutionError(
          'channel_unpinned',
          selector,
          `No pin registered for family "${selector.family}" channel "${channel}". Add one to FAMILY_ALIASES or choose a different channel.`,
        );
      }

      const result: ResolvedModel = {
        requested: selector,
        resolved: resolvedModelId,
        source: 'alias',
        familyChannel: channel,
      };
      return result;
    }
    case 'pinned': {
      validateModelId(selector.modelId);
      return {
        requested: selector,
        resolved: selector.modelId,
        source: 'pinned',
      };
    }
    case 'inherit': {
      if (!context?.parent) {
        throw new ModelResolutionError(
          'missing_parent',
          selector,
          'Cannot resolve "inherit" selector without a parent resolution in context.parent.',
        );
      }
      const result: ResolvedModel = {
        requested: selector,
        resolved: context.parent.resolved,
        source: 'inherited',
      };
      if (context.parentContextId !== undefined) {
        result.parentContextId = context.parentContextId;
      }
      return result;
    }
    default: {
      const _exhaustive: never = selector;
      throw new Error(`Unhandled ModelSelector kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export const DEFAULT_MODEL_REGISTRY: ModelRegistry = {
  models: {
    'claude-fable-5': {
      vendor: 'anthropic',
      class: 'frontier',
      strengths: ['frontier reasoning', 'long-horizon agentic work', 'code review', 'architecture'],
      weaknesses: ['highest cost', 'slower', 'minutes-long turns on hard tasks', 'OpenRouter dependency'],
      // Seed dates are approximate; update the global registry if exact launch
      // dates matter for the recency boost window.
      releasedAt: '2026-06-10',
      qualityScores: scores(62, 99, 95, 98, 62),
      pricing: {
        inputCostPerMTok: 10,
        outputCostPerMTok: 50,
        cacheWriteCostPerMTok: 12.5,
        cacheReadCostPerMTok: 1,
      },
      contextWindowTokens: 1_000_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 10,
      costPerMillionOutputTokensUsd: 50,
      // Anthropic models run through the Claude Code harness. They must never
      // be sent through the native OpenRouter adapter.
      agent: 'claude',
    },
    'claude-opus-4-8': {
      vendor: 'anthropic',
      class: 'frontier',
      strengths: ['long-horizon reasoning', 'code review', 'architecture', 'agentic coding'],
      weaknesses: ['higher cost', 'slower'],
      releasedAt: '2026-05-20',
      qualityScores: scores(62, 97, 88, 96, 62),
      pricing: {
        inputCostPerMTok: 5,
        outputCostPerMTok: 25,
        cacheWriteCostPerMTok: 6.25,
        cacheReadCostPerMTok: 0.5,
      },
      // Anthropic's June 2026 Opus 4.8 product page advertises a 1M context window.
      contextWindowTokens: 1_000_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 5,
      costPerMillionOutputTokensUsd: 25,
    },
    'claude-opus-4-7': {
      vendor: 'anthropic',
      class: 'frontier',
      strengths: ['long-horizon reasoning', 'code review', 'architecture'],
      weaknesses: ['higher cost', 'slower'],
      qualityScores: scores(60, 95, 85, 95, 60),
      pricing: {
        inputCostPerMTok: 5,
        outputCostPerMTok: 25,
        cacheWriteCostPerMTok: 6.25,
        cacheReadCostPerMTok: 0.5,
      },
      contextWindowTokens: 200_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 5,
      costPerMillionOutputTokensUsd: 25,
    },
    'claude-opus-4-6': {
      vendor: 'anthropic',
      class: 'frontier',
      strengths: ['long-horizon reasoning', 'code review', 'architecture'],
      weaknesses: ['higher cost', 'slower'],
      qualityScores: scores(58, 92, 82, 92, 58),
      pricing: {
        inputCostPerMTok: 5,
        outputCostPerMTok: 25,
        cacheWriteCostPerMTok: 6.25,
        cacheReadCostPerMTok: 0.5,
      },
      contextWindowTokens: 200_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 5,
      costPerMillionOutputTokensUsd: 25,
    },
    'claude-sonnet-5': {
      vendor: 'anthropic',
      class: 'strong_generalist',
      strengths: ['code generation', 'balanced quality/cost', 'instruction following'],
      weaknesses: ['less deep reasoning'],
      releasedAt: '2026-06-30',
      qualityScores: scores(77, 84, 92, 84, 80),
      // Sonnet 5's launch pricing ($2/$10; 5m cache write 2.50, 1h cache write
      // 4.00, cache read 0.20; batch 1.00/5.00) is permanent going forward, so
      // these are the durable rates rather than a temporary promotion. The 1h
      // cache-write tier has no field here; `cacheWriteCostPerMTok` carries the
      // 5m rate, which is what the cost model bills against.
      pricing: {
        inputCostPerMTok: 2,
        outputCostPerMTok: 10,
        cacheWriteCostPerMTok: 2.5,
        cacheReadCostPerMTok: 0.2,
      },
      contextWindowTokens: 1_000_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 2,
      costPerMillionOutputTokensUsd: 10,
    },
    'claude-sonnet-4-6': {
      vendor: 'anthropic',
      class: 'strong_generalist',
      strengths: ['code generation', 'balanced quality/cost', 'instruction following'],
      weaknesses: ['less deep reasoning'],
      qualityScores: scores(75, 82, 90, 82, 78),
      pricing: {
        inputCostPerMTok: 3,
        outputCostPerMTok: 15,
        cacheWriteCostPerMTok: 3.75,
        cacheReadCostPerMTok: 0.3,
      },
      contextWindowTokens: 200_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 3,
      costPerMillionOutputTokensUsd: 15,
    },
    'claude-sonnet-4-5-20250929': {
      vendor: 'anthropic',
      class: 'strong_generalist',
      strengths: ['code generation', 'balanced quality/cost', 'instruction following'],
      weaknesses: ['less deep reasoning'],
      qualityScores: scores(72, 78, 86, 78, 74),
      pricing: {
        inputCostPerMTok: 3,
        outputCostPerMTok: 15,
        cacheWriteCostPerMTok: 3.75,
        cacheReadCostPerMTok: 0.3,
      },
      contextWindowTokens: 200_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 3,
      costPerMillionOutputTokensUsd: 15,
    },
    'claude-haiku-4-5-20251001': {
      vendor: 'anthropic',
      class: 'fast_economy',
      strengths: ['speed', 'low cost', 'classification'],
      weaknesses: ['less depth on complex reasoning'],
      qualityScores: scores(88, 55, 60, 55, 92),
      pricing: {
        inputCostPerMTok: 0.8,
        outputCostPerMTok: 4,
        cacheWriteCostPerMTok: 1,
        cacheReadCostPerMTok: 0.08,
      },
      contextWindowTokens: 200_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'basic',
      costPerMillionInputTokensUsd: 0.8,
      costPerMillionOutputTokensUsd: 4,
    },
    'claude-haiku-4-5': {
      vendor: 'anthropic',
      class: 'fast_economy',
      strengths: ['speed', 'low cost', 'classification'],
      weaknesses: ['less depth on complex reasoning'],
      qualityScores: scores(88, 55, 60, 55, 92),
      pricing: {
        inputCostPerMTok: 0.8,
        outputCostPerMTok: 4,
        cacheWriteCostPerMTok: 1,
        cacheReadCostPerMTok: 0.08,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 200_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'basic',
      costPerMillionInputTokensUsd: 0.8,
      costPerMillionOutputTokensUsd: 4,
      agent: 'claude',
      supportedModel: {
        wavemillAlias: 'claude-haiku-4-5',
        providerNativeId: 'claude-haiku-4-5-20251001',
        stages: ['coding', 'review'],
        lifecycle: 'supported',
        launchEligible: true,
        routingEligible: true,
      },
    },
    'gpt-5.5': {
      vendor: 'openai',
      class: 'frontier',
      strengths: ['frontier reasoning', 'code generation', 'architecture'],
      weaknesses: ['higher cost'],
      releasedAt: '2026-05-01',
      qualityScores: scores(62, 96, 92, 94, 62),
      pricing: {
        inputCostPerMTok: 5,
        outputCostPerMTok: 30,
      },
      contextWindowTokens: 400_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 5,
      costPerMillionOutputTokensUsd: 30,
      agent: 'codex',
      codexChatgptCapability: { supported: true },
    },
    'gpt-5.4': {
      vendor: 'openai',
      class: 'frontier',
      strengths: ['frontier reasoning', 'code generation', 'architecture'],
      weaknesses: ['superseded for ChatGPT Codex launches by GPT-5.6 Terra'],
      // Retained for historical records and explicit non-Codex policy analysis.
      // Its Codex/ChatGPT capability below remains false, so it cannot launch.
      disabled: false,
      qualityScores: scores(60, 94, 90, 92, 60),
      pricing: {
        inputCostPerMTok: 2.5,
        outputCostPerMTok: 15,
        cacheReadCostPerMTok: 0.25,
      },
      contextWindowTokens: 256_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 2.5,
      costPerMillionOutputTokensUsd: 15,
      agent: 'codex',
      codexChatgptCapability: {
        supported: false,
        reason: 'HOK-2549: Codex now uses gpt-5.6-terra in place of gpt-5.4.',
      },
    },
    'gpt-5.6-sol': {
      vendor: 'openai',
      class: 'frontier',
      strengths: ['frontier professional reasoning', 'complex coding', 'tool use'],
      weaknesses: ['higher cost', 'not certified for the ChatGPT Codex launch surface'],
      defaultLadderEligible: false,
      qualityScores: scores(0, 0, 0, 0, 0),
      pricing: { inputCostPerMTok: 5, outputCostPerMTok: 30, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      contextWindowTokens: 1_050_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 5,
      costPerMillionOutputTokensUsd: 30,
      agent: 'codex',
      codexChatgptCapability: {
        supported: false,
        reason: 'gpt-5.6-sol is not certified for the ChatGPT Codex launch surface.',
      },
    },
    'gpt-5.6-terra': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: ['balanced professional reasoning', 'coding', 'tool use'],
      weaknesses: ['new routing candidate; evaluation evidence is still accumulating'],
      qualityScores: scores(62, 94, 91, 93, 66),
      pricing: { inputCostPerMTok: 2.5, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.125, cacheReadCostPerMTok: 0.25 },
      contextWindowTokens: 1_050_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 2.5,
      costPerMillionOutputTokensUsd: 15,
      agent: 'codex',
      codexChatgptCapability: { supported: true },
    },
    'gpt-5.6-luna': {
      vendor: 'openai',
      class: 'fast_economy',
      strengths: ['cost-sensitive high-volume workloads', 'tool use'],
      weaknesses: ['not certified for the ChatGPT Codex launch surface'],
      defaultLadderEligible: false,
      qualityScores: scores(0, 0, 0, 0, 0),
      pricing: { inputCostPerMTok: 1, outputCostPerMTok: 6, cacheWriteCostPerMTok: 1.25, cacheReadCostPerMTok: 0.1 },
      contextWindowTokens: 1_050_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 1,
      costPerMillionOutputTokensUsd: 6,
      agent: 'codex',
      codexChatgptCapability: {
        supported: false,
        reason: 'gpt-5.6-luna is not certified for the ChatGPT Codex launch surface.',
      },
    },
    'gpt-5.3-codex': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: ['cost-efficient coding', 'fast edits'],
      weaknesses: ['ChatGPT Codex account incompatibility', 'disabled for active routing'],
      disabled: true,
      qualityScores: scores(56, 68, 84, 62, 52),
      pricing: {
        inputCostPerMTok: 1.75,
        outputCostPerMTok: 14,
        cacheWriteCostPerMTok: 2.1875,
        cacheReadCostPerMTok: 0.44,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 256_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 1.75,
      costPerMillionOutputTokensUsd: 14,
      agent: 'codex',
    },
    'gpt-5': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: ['general reasoning', 'coding', 'broad tool support'],
      weaknesses: ['premium cost', 'not available to the ChatGPT Codex surface'],
      qualityScores: scores(72, 92, 90, 90, 70),
      pricing: { inputCostPerMTok: 3, outputCostPerMTok: 15 },
      defaultLadderEligible: false,
      contextWindowTokens: 400_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 3,
      costPerMillionOutputTokensUsd: 15,
      agent: 'codex',
      codexChatgptCapability: {
        supported: false,
        reason: 'The ChatGPT-authenticated Codex CLI does not support gpt-5.',
      },
    },
    'gpt-5-mini': {
      vendor: 'openai',
      class: 'fast_economy',
      strengths: ['fast responses', 'low-cost coding'],
      weaknesses: ['less depth than frontier GPT variants', 'not available to the ChatGPT Codex surface'],
      qualityScores: scores(60, 75, 82, 80, 62),
      pricing: { inputCostPerMTok: 0.6, outputCostPerMTok: 2.4 },
      defaultLadderEligible: false,
      contextWindowTokens: 256_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.6,
      costPerMillionOutputTokensUsd: 2.4,
      agent: 'codex',
      codexChatgptCapability: {
        supported: false,
        reason: 'The ChatGPT-authenticated Codex CLI does not support gpt-5-mini.',
      },
    },
    'gpt-4.1': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: ['coding', 'tool use', 'low-latency implementation work'],
      weaknesses: ['coding-only watchlist entry', 'not available to the ChatGPT Codex surface'],
      qualityScores: scores(52, 0, 78, 0, 50),
      pricing: { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      defaultLadderEligible: false,
      contextWindowTokens: 1_047_576,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 2,
      costPerMillionOutputTokensUsd: 8,
      // OpenAI models must use the ChatGPT-authenticated Codex harness, never
      // OpenRouter or a native API path. Keep this watchlist model fail-closed
      // until it is explicitly certified for that surface.
      agent: 'codex',
      codexChatgptCapability: {
        supported: false,
        reason: 'gpt-4.1 is not certified for the ChatGPT Codex launch surface.',
      },
    },
    'gemini-2.5-pro': {
      vendor: 'google',
      class: 'frontier',
      strengths: ['planning', 'long context', 'code review'],
      weaknesses: ['opt-in only', 'OpenRouter dependency'],
      qualityScores: scores(68, 90, 88, 89, 66),
      pricing: { inputCostPerMTok: 1.25, outputCostPerMTok: 10, cacheReadCostPerMTok: 0.125, cacheWriteCostPerMTok: 0.375 },
      defaultLadderEligible: false,
      contextWindowTokens: 1_048_576,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 1.25,
      costPerMillionOutputTokensUsd: 10,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'gemini-2.5-pro',
        providerNativeId: 'google/gemini-2.5-pro',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'gemini-2.5-flash': {
      vendor: 'google',
      class: 'fast_economy',
      strengths: ['speed', 'low cost', 'coding'],
      weaknesses: ['shallower planning than pro', 'opt-in only'],
      qualityScores: scores(58, 72, 78, 77, 65),
      pricing: { inputCostPerMTok: 0.3, outputCostPerMTok: 2.5, cacheReadCostPerMTok: 0.03, cacheWriteCostPerMTok: 0.0833333333333333 },
      defaultLadderEligible: false,
      contextWindowTokens: 1_048_576,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.3,
      costPerMillionOutputTokensUsd: 2.5,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'gemini-2.5-flash',
        providerNativeId: 'google/gemini-2.5-flash',
        stages: ['coding', 'review'],
      }),
    },
    'gemini-2.0-flash': {
      vendor: 'google',
      class: 'fast_economy',
      strengths: ['fast coding assistance', 'low latency', 'Gemini family coverage'],
      weaknesses: [
        'coding-only watchlist entry',
        'older than Gemini 2.5 flash',
        'OpenRouter dependency',
        'retired 2026-08-16: not in OpenRouter catalog (HOK-2773)',
      ],
      qualityScores: scores(52, 0, 74, 0, 60),
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0,
      costPerMillionOutputTokensUsd: 0,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'gemini-2.0-flash',
        providerNativeId: 'google/gemini-2.0-flash-001',
        stages: ['coding'],
        lifecycle: 'blocked',
      }),
    },
    'llama-4-maverick': {
      vendor: 'meta',
      class: 'strong_generalist',
      strengths: ['planning', 'cost efficiency', 'broad availability'],
      weaknesses: ['less reliable than top frontier models', 'opt-in only'],
      qualityScores: scores(56, 78, 80, 74, 54),
      pricing: { inputCostPerMTok: 0.2, outputCostPerMTok: 0.8 },
      defaultLadderEligible: false,
      contextWindowTokens: 1_048_576,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.4,
      costPerMillionOutputTokensUsd: 1.6,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'llama-4-maverick',
        providerNativeId: 'meta-llama/llama-4-maverick',
        stages: ['planning', 'coding'],
      }),
    },
    'llama-3.3-70b': {
      vendor: 'meta',
      class: 'fast_economy',
      strengths: ['budget-friendly coding', 'review coverage'],
      weaknesses: ['lower ceiling than larger frontier models', 'opt-in only'],
      qualityScores: scores(52, 66, 74, 72, 52),
      pricing: { inputCostPerMTok: 0.12, outputCostPerMTok: 0.3 },
      defaultLadderEligible: false,
      contextWindowTokens: 131_072,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'fast',
      reasoningTier: 'basic',
      costPerMillionInputTokensUsd: 0.12,
      costPerMillionOutputTokensUsd: 0.3,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'llama-3.3-70b',
        providerNativeId: 'meta-llama/llama-3.3-70b-instruct',
        stages: ['coding', 'review'],
      }),
    },
    'llama-4-scout': {
      vendor: 'meta',
      class: 'fast_economy',
      strengths: ['coding', 'low-cost open model coverage', 'long context'],
      weaknesses: ['coding-only watchlist entry', 'OpenRouter dependency'],
      qualityScores: scores(48, 0, 72, 0, 46),
      pricing: { inputCostPerMTok: 0.1, outputCostPerMTok: 0.3 },
      defaultLadderEligible: false,
      contextWindowTokens: 1_310_720,
      toolSupport: 'basic',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.1,
      costPerMillionOutputTokensUsd: 0.3,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'llama-4-scout',
        providerNativeId: 'meta-llama/llama-4-scout',
        stages: ['coding'],
      }),
    },
    'mistral-large-2': {
      vendor: 'mistral',
      class: 'strong_generalist',
      strengths: ['planning', 'coding', 'long context'],
      weaknesses: ['opt-in only', 'less tooling maturity'],
      qualityScores: scores(60, 82, 84, 82, 58),
      pricing: { inputCostPerMTok: 2, outputCostPerMTok: 6, cacheReadCostPerMTok: 0.2 },
      defaultLadderEligible: false,
      contextWindowTokens: 131_072,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 2,
      costPerMillionOutputTokensUsd: 6,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'mistral-large-2',
        providerNativeId: 'mistralai/mistral-large-2407',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'mistral-medium-3': {
      vendor: 'mistral',
      class: 'strong_generalist',
      strengths: ['agentic workflows', 'coding', 'multimodal review'],
      weaknesses: ['watchlist maturity', 'higher cost than small Mistral models'],
      qualityScores: scores(58, 78, 82, 80, 58),
      pricing: { inputCostPerMTok: 1.5, outputCostPerMTok: 7.5 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 1.5,
      costPerMillionOutputTokensUsd: 7.5,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'mistral-medium-3',
        providerNativeId: 'mistralai/mistral-medium-3-5',
        stages: ['coding'],
      }),
    },
    'devstral-small': {
      vendor: 'mistral',
      class: 'fast_economy',
      strengths: ['coding', 'multimodal understanding', 'low cost'],
      weaknesses: ['lower ceiling than larger Mistral models', 'opt-in only'],
      qualityScores: scores(50, 58, 76, 66, 50),
      pricing: { inputCostPerMTok: 0.15, outputCostPerMTok: 0.6, cacheReadCostPerMTok: 0.015 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.15,
      costPerMillionOutputTokensUsd: 0.6,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'devstral-small',
        providerNativeId: 'mistralai/mistral-small-2603',
        stages: ['coding'],
      }),
    },
    'devstral-medium': {
      vendor: 'mistral',
      class: 'strong_generalist',
      strengths: ['agentic workflows', 'coding', 'multimodal review'],
      weaknesses: ['watchlist maturity', 'higher cost than small Mistral models'],
      qualityScores: scores(58, 78, 82, 80, 58),
      pricing: { inputCostPerMTok: 1.5, outputCostPerMTok: 7.5 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'full',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 1.5,
      costPerMillionOutputTokensUsd: 7.5,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'devstral-medium',
        providerNativeId: 'mistralai/mistral-medium-3-5',
        stages: ['coding'],
      }),
    },
    'deepseek-r1': {
      vendor: 'deepseek',
      class: 'frontier',
      strengths: ['reasoning', 'planning', 'broad coverage'],
      weaknesses: ['higher latency', 'OpenRouter dependency'],
      qualityScores: scores(64, 91, 86, 87, 60),
      pricing: { inputCostPerMTok: 0.7, outputCostPerMTok: 2.5 },
      defaultLadderEligible: false,
      contextWindowTokens: 128_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.7,
      costPerMillionOutputTokensUsd: 2.5,
      agent: 'claude',
    },
    'deepseek-v3': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['coding', 'review', 'agentic tool use', 'budget efficiency'],
      weaknesses: ['reasoning defaults off unless explicitly requested', 'OpenRouter dependency'],
      qualityScores: scores(58, 74, 82, 80, 56),
      pricing: { inputCostPerMTok: 0.25, outputCostPerMTok: 0.95, cacheReadCostPerMTok: 0.13 },
      defaultLadderEligible: false,
      contextWindowTokens: 163_840,
      toolSupport: 'full',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.25,
      costPerMillionOutputTokensUsd: 0.95,
      agent: 'claude',
    },
    // HOK-2773: these native-openrouter rows are retained for historical eval
    // attribution. Retire them with lifecycle metadata instead of deleting.
    'deepseek-coder-v2': {
      vendor: 'deepseek',
      class: 'fast_economy',
      strengths: ['coding', 'low-cost implementation', 'DeepSeek family coverage'],
      weaknesses: [
        'coding-only watchlist entry',
        'OpenRouter dependency',
        'retired 2026-08-16: resolves to no native OpenRouter wire ID (HOK-2773)',
      ],
      qualityScores: scores(44, 0, 74, 0, 42),
      defaultLadderEligible: false,
      contextWindowTokens: 128_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0,
      costPerMillionOutputTokensUsd: 0,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'deepseek-coder-v2',
        providerNativeId: 'deepseek/deepseek-coder-v2-instruct',
        stages: ['coding'],
        lifecycle: 'blocked',
      }),
    },
    'qwen-2.5-coder-32b': {
      vendor: 'qwen',
      class: 'fast_economy',
      strengths: ['low-cost coding', 'challenger coverage'],
      weaknesses: [
        'narrower reasoning depth',
        'opt-in only',
        'retired 2026-08-16: no OpenRouter endpoint supports tool use (HOK-2773)',
      ],
      qualityScores: scores(52, 60, 79, 68, 54),
      pricing: { inputCostPerMTok: 0.2, outputCostPerMTok: 0.6 },
      defaultLadderEligible: false,
      contextWindowTokens: 32_768,
      toolSupport: 'none',
      multimodal: { text: true, image: false },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.2,
      costPerMillionOutputTokensUsd: 0.6,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'qwen-2.5-coder-32b',
        providerNativeId: 'qwen/qwen-2.5-coder-32b-instruct',
        stages: ['coding'],
        lifecycle: 'blocked',
      }),
    },
    'qwen-3-coder': {
      vendor: 'qwen',
      class: 'strong_generalist',
      strengths: ['planning', 'coding', 'review', 'challenger family coverage'],
      weaknesses: ['opt-in only', 'provider routing dependency'],
      qualityScores: scores(58, 72, 84, 78, 58),
      pricing: { inputCostPerMTok: 0.35, outputCostPerMTok: 1.05 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.35,
      costPerMillionOutputTokensUsd: 1.05,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'qwen-3-coder',
        providerNativeId: 'qwen/qwen3-coder',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'qwen-3-235b': {
      vendor: 'qwen',
      class: 'frontier',
      strengths: ['planning', 'coding', 'review breadth'],
      weaknesses: ['watchlist maturity', 'opt-in only'],
      qualityScores: scores(60, 86, 85, 83, 58),
      pricing: { inputCostPerMTok: 0.09, outputCostPerMTok: 0.55 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'full',
      multimodal: { text: true, image: false },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.09,
      costPerMillionOutputTokensUsd: 0.55,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'qwen-3-235b',
        providerNativeId: 'qwen/qwen3-235b-a22b-2507',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'qwen-2.5-72b': {
      vendor: 'qwen',
      class: 'fast_economy',
      strengths: ['coding', 'low-cost Qwen family coverage'],
      weaknesses: ['coding-only watchlist entry', 'OpenRouter dependency'],
      qualityScores: scores(46, 0, 72, 0, 44),
      defaultLadderEligible: false,
      contextWindowTokens: 32_768,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0,
      costPerMillionOutputTokensUsd: 0,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'qwen-2.5-72b',
        providerNativeId: 'qwen/qwen-2.5-72b-instruct',
        stages: ['coding'],
      }),
    },
    'kimi-k2': {
      vendor: 'moonshotai',
      class: 'strong_generalist',
      strengths: ['planning', 'coding', 'challenger family coverage'],
      weaknesses: ['provider routing dependency', 'opt-in only'],
      qualityScores: scores(60, 84, 84, 82, 58),
      pricing: { inputCostPerMTok: 0.57, outputCostPerMTok: 2.3 },
      defaultLadderEligible: false,
      contextWindowTokens: 131_072,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.57,
      costPerMillionOutputTokensUsd: 2.3,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'kimi-k2',
        providerNativeId: 'moonshotai/kimi-k2',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'glm-5.2': {
      vendor: 'z-ai',
      class: 'strong_generalist',
      strengths: ['reasoning', 'coding', 'long-context analysis'],
      weaknesses: ['watchlist maturity', 'provider routing dependency'],
      qualityScores: scores(58, 82, 83, 80, 56),
      pricing: { inputCostPerMTok: 1.19, outputCostPerMTok: 3.74, cacheReadCostPerMTok: 0.221 },
      defaultLadderEligible: false,
      contextWindowTokens: 1_048_576,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 1.19,
      costPerMillionOutputTokensUsd: 3.74,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'glm-5.2',
        providerNativeId: 'z-ai/glm-5.2',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'kimi-k2.7-code': {
      vendor: 'moonshotai',
      class: 'strong_generalist',
      strengths: ['coding', 'planning', 'agentic execution'],
      weaknesses: ['watchlist maturity', 'provider routing dependency'],
      qualityScores: scores(60, 86, 87, 82, 58),
      pricing: { inputCostPerMTok: 0.71, outputCostPerMTok: 3.5, cacheReadCostPerMTok: 0.15 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.71,
      costPerMillionOutputTokensUsd: 3.5,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'kimi-k2.7-code',
        providerNativeId: 'moonshotai/kimi-k2.7-code',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'kimi-k2-thinking': {
      vendor: 'moonshotai',
      class: 'frontier',
      strengths: ['reasoning', 'planning', 'challenger family coverage'],
      weaknesses: ['watchlist maturity', 'slower than kimi-k2'],
      qualityScores: scores(58, 88, 85, 84, 56),
      pricing: { inputCostPerMTok: 0.6, outputCostPerMTok: 2.5, cacheReadCostPerMTok: 0.15 },
      defaultLadderEligible: false,
      contextWindowTokens: 262_144,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.6,
      costPerMillionOutputTokensUsd: 2.5,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'kimi-k2-thinking',
        providerNativeId: 'moonshotai/kimi-k2-thinking',
        stages: ['planning', 'coding', 'review'],
      }),
    },
    'deepseek-v4-pro': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['long-context reasoning', 'code generation', 'anthropic-compatible launch'],
      weaknesses: ['opt-in only', 'pricing subject to change'],
      qualityScores: scores(64, 84, 83, 85, 62),
      pricing: {
        inputCostPerMTok: 0.435,
        outputCostPerMTok: 0.87,
        cacheWriteCostPerMTok: 0.435,
        cacheReadCostPerMTok: 0.003625,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.435,
      costPerMillionOutputTokensUsd: 0.87,
      agent: 'claude',
    },
    'deepseek-v4-pro[1m]': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['max-context tasks', 'code generation', 'anthropic-compatible launch'],
      weaknesses: ['opt-in only', 'pricing subject to change'],
      qualityScores: scores(63, 85, 82, 84, 61),
      pricing: {
        inputCostPerMTok: 0.435,
        outputCostPerMTok: 0.87,
        cacheWriteCostPerMTok: 0.435,
        cacheReadCostPerMTok: 0.003625,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.435,
      costPerMillionOutputTokensUsd: 0.87,
      agent: 'claude',
    },
    'deepseek-v4-flash': {
      vendor: 'deepseek',
      class: 'fast_economy',
      strengths: ['speed', 'low cost', 'anthropic-compatible launch'],
      weaknesses: ['less depth than pro', 'opt-in only'],
      qualityScores: scores(70, 68, 76, 70, 80),
      pricing: {
        inputCostPerMTok: 0.14,
        outputCostPerMTok: 0.28,
        cacheWriteCostPerMTok: 0.14,
        cacheReadCostPerMTok: 0.0028,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'fast',
      reasoningTier: 'basic',
      costPerMillionInputTokensUsd: 0.14,
      costPerMillionOutputTokensUsd: 0.28,
      agent: 'claude',
    },
    'deepseek-chat': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['compatibility alias for existing DeepSeek integrations'],
      weaknesses: ['compatibility alias', 'future deprecation risk'],
      qualityScores: scores(46, 70, 76, 68, 40),
      pricing: {
        inputCostPerMTok: 0.435,
        outputCostPerMTok: 0.87,
        cacheWriteCostPerMTok: 0.435,
        cacheReadCostPerMTok: 0.003625,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.435,
      costPerMillionOutputTokensUsd: 0.87,
      agent: 'claude',
    },
    'deepseek-reasoner': {
      vendor: 'deepseek',
      class: 'frontier',
      strengths: ['reasoning-oriented compatibility alias'],
      weaknesses: ['compatibility alias', 'future deprecation risk'],
      qualityScores: scores(44, 78, 74, 70, 36),
      pricing: {
        inputCostPerMTok: 0.435,
        outputCostPerMTok: 0.87,
        cacheWriteCostPerMTok: 0.435,
        cacheReadCostPerMTok: 0.003625,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'slow',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.435,
      costPerMillionOutputTokensUsd: 0.87,
      agent: 'claude',
    },
    'grok-code-fast': {
      vendor: 'x-ai',
      class: 'fast_economy',
      strengths: ['fast coding iteration', 'low-latency implementation work', 'Grok family coverage'],
      weaknesses: [
        'coding-only watchlist entry',
        'OpenRouter dependency',
        'retired 2026-08-16: not in OpenRouter catalog (HOK-2773)',
      ],
      qualityScores: scores(48, 0, 76, 0, 44),
      defaultLadderEligible: false,
      contextWindowTokens: 256_000,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'fast',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0,
      costPerMillionOutputTokensUsd: 0,
      agent: 'native-openrouter',
      nativeCapability: OPENROUTER_NATIVE_CAPABILITY,
      supportedModel: openRouterSupportedModel({
        alias: 'grok-code-fast',
        providerNativeId: 'x-ai/grok-code-fast-1',
        stages: ['coding'],
        lifecycle: 'blocked',
      }),
    },
  },
  ladders: {
    routing: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'claude-sonnet-5', 'gpt-5.5', 'gpt-5.6-terra', 'deepseek-v4-pro', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7'],
    planning: ['claude-fable-5', 'gpt-5.5', 'claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.6-terra', 'deepseek-reasoner', 'deepseek-v4-pro', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    coding: ['claude-fable-5', 'gpt-5.5', 'gpt-5.6-terra', 'deepseek-v4-pro', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'deepseek-chat', 'deepseek-v4-flash', 'claude-haiku-4-5-20251001'],
    review: ['gpt-5.5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.6-terra', 'deepseek-v4-pro', 'claude-sonnet-5', 'deepseek-reasoner', 'claude-haiku-4-5-20251001'],
    classify: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'claude-sonnet-5', 'gpt-5.5', 'gpt-5.6-terra', 'claude-fable-5'],
  },
};

export function isModelEnabled(capabilities: ModelCapabilities | undefined): boolean {
  return capabilities !== undefined && capabilities.disabled !== true;
}

export function resolveModelRegistryKey(registry: ModelRegistry, modelId: string): string {
  if (registry.models[modelId]) {
    return modelId;
  }

  const alias = resolveWavemillAliasFromOpenRouterId(modelId);
  return alias && registry.models[alias] ? alias : modelId;
}

export function getModel(registry: ModelRegistry, modelId: string): ModelCapabilities | undefined {
  if (!modelId) {
    return undefined;
  }
  return registry.models[resolveModelRegistryKey(registry, modelId)];
}

export function getLadder(registry: ModelRegistry, taskType: RegistryTaskType): string[] {
  const configured = registry.ladders[taskType];
  if (configured) {
    return configured.filter((modelId) => {
      if (isModelEnabled(registry.models[modelId])) {
        return true;
      }
      if (registry.models[modelId]) {
        return false;
      }
      warnUnknownModel(taskType, modelId);
      return false;
    });
  }

  return Object.entries(registry.models)
    .filter(([, capabilities]) => isModelEnabled(capabilities))
    .filter(([, capabilities]) => capabilities.defaultLadderEligible !== false)
    .filter(([, capabilities]) => Number.isFinite(capabilities.qualityScores[taskType]))
    .sort((left, right) => compareModels(taskType, left, right))
    .filter(([, capabilities]) => capabilities.qualityScores[taskType] > 0)
    .map(([modelId]) => modelId);
}

export function rankCandidates(
  registry: ModelRegistry,
  taskType: RegistryTaskType,
  opts?: { excluded?: string[] },
): string[] {
  const excluded = new Set(opts?.excluded ?? []);
  return getLadder(registry, taskType).filter((modelId) => !excluded.has(modelId));
}

export function mergeModelRegistry(
  defaults: ModelRegistry,
  overrides?: { models?: Record<string, ModelCapabilitiesOverride>; ladders?: Partial<Record<RegistryTaskType, string[]>> },
): ModelRegistry {
  const merged = cloneRegistry(defaults);
  if (!overrides) {
    return merged;
  }

  for (const [modelId, override] of Object.entries(overrides.models ?? {})) {
    merged.models[modelId] = mergeCapabilities(merged.models[modelId], override);
  }

  for (const taskType of TASK_TYPES) {
    const overrideLadder = overrides.ladders?.[taskType];
    if (overrideLadder) {
      merged.ladders[taskType] = [...overrideLadder];
    }
  }

  assertRegistryConsistency(merged);
  return merged;
}

export function getEffectiveRegistry(repoDir?: string): ModelRegistry {
  void repoDir;
  return DEFAULT_MODEL_REGISTRY;
}

export function normalizeSupportedModelStage(stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType): SupportedModelStage {
  if (stage === 'planner') return 'planning';
  if (stage === 'coder') return 'coding';
  if (stage === 'reviewer') return 'review';
  if (stage === 'routing' || stage === 'classify') return 'planning';
  return stage;
}

export function getRequiredCertificationPhaseForStage(
  modelId: string,
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  registry: ModelRegistry = getEffectiveRegistry(),
): CertificationPhase | undefined {
  const normalized = normalizeSupportedModelStage(stage);
  const capabilities = getModel(registry, modelId);
  const explicit = capabilities?.supportedModel?.requiredCertificationPhaseByStage?.[normalized];
  if (explicit) {
    return explicit;
  }
  if (!capabilities?.nativeCapability) {
    return undefined;
  }
  if (normalized === 'coding') return 'patch';
  if (normalized === 'planning') return 'workflow';
  return 'read-only';
}

export function resolveProviderNativeModelId(
  modelId: string,
  registry: ModelRegistry = getEffectiveRegistry(),
): { wavemillAlias: string; providerNativeId: string; provider?: NativeProviderName; transport?: PiTransportKind } | undefined {
  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return undefined;
  }
  return {
    wavemillAlias: capabilities.supportedModel?.wavemillAlias ?? modelId,
    providerNativeId: capabilities.supportedModel?.providerNativeId ?? modelId,
    provider: capabilities.supportedModel?.provider ?? capabilities.nativeCapability?.nativeProvider,
    transport: capabilities.supportedModel?.transport ?? capabilities.nativeCapability?.piTransportKind,
  };
}

export function explainModelSupportExclusion(
  modelId: string,
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  registry: ModelRegistry = getEffectiveRegistry(),
): ModelSupportExclusionReason | undefined {
  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return 'unknown-model';
  }
  const lifecycle = capabilities.supportedModel?.lifecycle ?? 'supported';
  if (lifecycle === 'blocked') return 'blocked-lifecycle';
  if (capabilities.disabled === true) return 'disabled';
  const normalized = normalizeSupportedModelStage(stage);
  const configuredStages = capabilities.supportedModel?.stages;
  if (configuredStages && !configuredStages.includes(normalized)) {
    return 'stage-incompatible';
  }
  if (stageRequiresTools(normalized) && !hasSufficientToolSupport(capabilities, normalized)) {
    return 'tool-support-insufficient';
  }
  if (!hasSufficientContextWindow(capabilities, normalized)) {
    return 'context-window-insufficient';
  }
  if ((capabilities.supportedModel?.routingEligible ?? true) === false) {
    return 'routing-ineligible';
  }
  return undefined;
}

export function stageRequiresTools(stage: SupportedModelStage): boolean {
  return STAGE_REQUIRES_TOOLS[stage] === true;
}

export function hasSufficientToolSupport(
  capabilities: Pick<ModelCapabilities, 'toolSupport'>,
  stage: SupportedModelStage,
): boolean {
  return !stageRequiresTools(stage) || !INSUFFICIENT_TOOL_SUPPORT.has(capabilities.toolSupport);
}

export function listSupportedModelsForStage(
  stage: SupportedModelStage | DescriptorModelStage | RegistryTaskType,
  registry: ModelRegistry = getEffectiveRegistry(),
): string[] {
  const normalized = normalizeSupportedModelStage(stage);
  return Object.entries(registry.models)
    .filter(([modelId]) => explainModelSupportExclusion(modelId, normalized, registry) === undefined)
    .filter(([, capabilities]) => {
      const configuredStages = capabilities.supportedModel?.stages;
      if (configuredStages) {
        return configuredStages.includes(normalized);
      }
      return (capabilities.qualityScores[normalized] ?? 0) > 0;
    })
    .map(([modelId]) => modelId);
}

/**
 * Hosted Codex authenticates through a ChatGPT account, whose model inventory
 * is narrower than the OpenAI API. Missing metadata is deliberately ineligible
 * so a new API model cannot accidentally be launched through Codex.
 */
export function isCodexChatgptLaunchEligible(capabilities: ModelCapabilities | undefined): boolean {
  return capabilities?.codexChatgptCapability?.supported === true;
}

/**
 * Explicit migrations for retired model IDs emitted by historical route
 * artifacts or external routers. These are deliberately narrow: an unknown or
 * otherwise ineligible model must still be rejected by agent resolution.
 */
export const CODEX_CHATGPT_SUCCESSOR_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'gpt-5.4': 'gpt-5.6-terra',
  'gpt-5': 'gpt-5.5',
  'gpt-5-mini': 'gpt-5.5',
});

/**
 * Returns a launchable Codex successor for a specifically retired model ID.
 * The target is checked against the effective registry so local configuration
 * cannot turn a migration into an invalid launch.
 */
export function resolveCodexChatgptSuccessor(
  modelId: string,
  registry: ModelRegistry = DEFAULT_MODEL_REGISTRY,
): string | null {
  const successor = CODEX_CHATGPT_SUCCESSOR_MODELS[modelId];
  if (!successor) return null;

  const capabilities = getModel(registry, successor);
  return capabilities?.agent === 'codex' && isCodexChatgptLaunchEligible(capabilities)
    ? successor
    : null;
}

/**
 * Use this guard at any native read-only selection site. Mere model availability
 * does not imply native read-only certification.
 */
export function isReadOnlyNativeCapable(
  modelId: string,
  opts?: { registry?: ModelRegistry; allowPartial?: boolean },
): boolean {
  const registry = opts?.registry ?? getEffectiveRegistry();
  const capability = getModel(registry, modelId)?.nativeCapability?.readOnlyNative;
  if (capability === 'certified') {
    return true;
  }
  return capability === 'partial' && opts?.allowPartial === true;
}

export type RegistryPhaseEligibilityReason = 'no-metadata' | 'stale' | 'phase-insufficient';

export type RegistryPhaseEligibility =
  | {
    eligible: true;
    modelId: string;
    phase: CertificationPhase;
    certifiedAt: string;
    suiteVersion: string;
  }
  | {
    eligible: false;
    modelId: string;
    phase: CertificationPhase;
    reason: RegistryPhaseEligibilityReason;
    certifiedAt?: string;
    suiteVersion?: string;
  };

export function evaluateRegistryPhaseEligibility(input: {
  modelId: string;
  phase: CertificationPhase;
  registry?: ModelRegistry;
  now?: Date;
}): RegistryPhaseEligibility {
  const registry = input.registry ?? getEffectiveRegistry();
  const certification = getModel(registry, input.modelId)?.nativeCapability?.certification;

  if (!certification) {
    return {
      eligible: false,
      modelId: input.modelId,
      phase: input.phase,
      reason: 'no-metadata',
    };
  }

  const now = input.now ?? new Date();
  const expiryMs = Date.parse(certification.certifiedAt) + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() >= expiryMs) {
    return {
      eligible: false,
      modelId: input.modelId,
      phase: input.phase,
      reason: 'stale',
      certifiedAt: certification.certifiedAt,
      suiteVersion: certification.certificationSuiteVersion,
    };
  }

  if (!phaseSatisfies(certification.maxCertifiedPhase, input.phase)) {
    return {
      eligible: false,
      modelId: input.modelId,
      phase: input.phase,
      reason: 'phase-insufficient',
      certifiedAt: certification.certifiedAt,
      suiteVersion: certification.certificationSuiteVersion,
    };
  }

  return {
    eligible: true,
    modelId: input.modelId,
    phase: input.phase,
    certifiedAt: certification.certifiedAt,
    suiteVersion: certification.certificationSuiteVersion,
  };
}

export type NativeReadOnlyRoutingMode = 'task' | 'certification';

export function isNativeAgentType(agent: AgentType | string): agent is Extract<AgentType, `native-${string}`> {
  return agent === 'native-openai' || agent === 'native-openrouter';
}

export function nativeAgentTypeForProvider(provider: NativeProviderName): Extract<AgentType, `native-${string}`> {
  return provider === 'openai' ? 'native-openai' : 'native-openrouter';
}

export interface NativeReadOnlyRoutingDecision {
  routable: boolean;
  certified: boolean;
  mode: NativeReadOnlyRoutingMode;
  phase: string;
  modelId: string;
  capability: ReadOnlyNativeCapability | 'unregistered';
  reason?: string;
}

export class NativeReadOnlyCertificationError extends Error {
  readonly modelId: string;
  readonly phase: string;
  readonly capability: ReadOnlyNativeCapability | 'unregistered';

  constructor(modelId: string, phase: string, capability: ReadOnlyNativeCapability | 'unregistered', message: string) {
    super(message);
    this.name = 'NativeReadOnlyCertificationError';
    this.modelId = modelId;
    this.phase = phase;
    this.capability = capability;
  }
}

export function evaluateNativeReadOnlyRouting(input: {
  modelId: string;
  phase: string;
  mode?: NativeReadOnlyRoutingMode;
  registry?: ModelRegistry;
  allowPartial?: boolean;
}): NativeReadOnlyRoutingDecision {
  const mode = input.mode ?? 'task';
  const registry = input.registry ?? getEffectiveRegistry();
  const nativeCapability = getModel(registry, input.modelId)?.nativeCapability;
  const capability: ReadOnlyNativeCapability | 'unregistered' = nativeCapability?.readOnlyNative ?? 'unregistered';
  const certified = isReadOnlyNativeCapable(input.modelId, { registry, allowPartial: input.allowPartial });

  if (mode === 'certification') {
    return {
      routable: false,
      certified,
      mode,
      phase: input.phase,
      modelId: input.modelId,
      capability,
    };
  }

  if (!certified) {
    const reason = capability === 'unregistered'
      ? `Refusing native read-only routing: model "${input.modelId}" is not registered in the model registry for the "${input.phase}" phase (capability: unregistered; required: certified). Native execution is disabled for this model — certify it via the smoke/certification path before routing.`
      : `Refusing native read-only routing: model "${input.modelId}" is not read-only-native certified for the "${input.phase}" phase (capability: ${capability}; required: certified). Native execution is disabled for this model — certify it via the smoke/certification path before routing.`;

    return {
      routable: false,
      certified: false,
      mode,
      phase: input.phase,
      modelId: input.modelId,
      capability,
      reason,
    };
  }

  return {
    routable: true,
    certified: true,
    mode,
    phase: input.phase,
    modelId: input.modelId,
    capability,
  };
}

export function assertNativeReadOnlyRoutable(input: {
  modelId: string;
  phase: string;
  mode?: NativeReadOnlyRoutingMode;
  registry?: ModelRegistry;
  allowPartial?: boolean;
}): void {
  const decision = evaluateNativeReadOnlyRouting(input);
  if (decision.mode === 'task' && !decision.routable && decision.reason) {
    throw new NativeReadOnlyCertificationError(
      decision.modelId,
      decision.phase,
      decision.capability,
      decision.reason,
    );
  }
}

export function getConfiguredModelsForDescriptorStage(
  repoDir: string | undefined,
  stage: DescriptorModelStage,
): string[] {
  void repoDir;
  const registry = getEffectiveRegistry(repoDir);
  const filterDescriptorModels = (modelIds: string[]): string[] =>
    filterDisabledModels(dedupeModelIds(modelIds))
      .filter((modelId) => {
        const capabilities = registry.models[modelId];
        return capabilities === undefined || isModelEnabled(capabilities);
      });

  return filterDescriptorModels(getLadder(registry, DESCRIPTOR_STAGE_TO_TASK_TYPE[stage]));
}

export function getConfiguredModelsForDescriptor(repoDir?: string): string[] {
  return dedupeModelIds([
    ...getConfiguredModelsForDescriptorStage(repoDir, 'planner'),
    ...getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
    ...getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'),
  ]);
}

export function resetWarningState(): void {
  warnedUnknownLadders.clear();
}
