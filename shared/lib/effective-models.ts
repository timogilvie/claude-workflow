import {
  getNativeAgentConfig,
  type NativeAgentAllowedPhase,
} from './config.ts';
import { isDisabledModel } from './disabled-models.ts';
import {
  getModel,
  getRequiredCertificationPhaseForStage,
  isCodexChatgptLaunchEligible,
  normalizeSupportedModelStage,
  resolveProviderNativeModelId,
  type AgentType,
  type ModelCapabilities,
  type ModelLifecycleStatus,
  type ModelRegistry,
  type NativeProviderName,
  type ReadOnlyNativeCapability,
  type SupportedModelStage,
} from './model-registry.ts';
import {
  evaluateEligibility,
  loadGlobalCertification,
} from './native-agent/certification/loader.ts';
import { resolveCertificationStorageIdentity } from './native-agent/certification/identity.ts';
import type {
  CertificationPhase,
  NativeCertificationArtifact,
} from './native-agent/certification/schema.ts';
import { checkIdentity } from './native-agent/certification/validator.ts';
import {
  isOpenRouterModel,
  resolveOpenRouterProviderConfig,
} from './openrouter-provider.ts';
import {
  resolveLaunchPriorityModel,
  resolveOpenRouterModelIdentity,
  type RoleEligibility,
} from './openrouter-catalog.ts';

export type EffectiveModelStage = 'expansion' | 'planning' | 'coding' | 'review';
export type EffectiveModelSource = 'registry' | 'provider' | 'certification' | 'policy' | 'runtime';

export type EffectiveModelReasonCode =
  | 'invalid-model-id'
  | 'unknown-model'
  | 'missing-registry-alias'
  | 'disabled'
  | 'blocked-lifecycle'
  | 'deprecated-lifecycle'
  | 'routing-ineligible'
  | 'stage-incompatible'
  | 'role-ineligible'
  | 'model-excluded'
  | 'provider-disabled'
  | 'stage-not-enabled'
  | 'model-not-allowlisted'
  | 'missing-api-key'
  | 'direct-agent-disabled'
  | 'codex-chatgpt-ineligible'
  | 'no-native-capability'
  | 'native-unsupported'
  | 'provider-mismatch'
  | 'missing-artifact'
  | 'malformed-artifact'
  | 'wrong-identity'
  | 'wrong-suite'
  | 'stale-artifact'
  | 'insufficient-phase'
  | 'scenario-failure'
  | 'missing-certification-metadata'
  | 'patch-coding-disabled';

export interface EffectiveModelExclusion {
  code: EffectiveModelReasonCode;
  source: EffectiveModelSource;
  message: string;
  severity: 'error' | 'warning';
  artifactPath?: string;
  artifactScope?: 'global';
  requiredPhase?: CertificationPhase;
  foundPhase?: CertificationPhase;
  requiredSuiteVersion?: string;
  foundSuiteVersion?: string;
  certifiedAt?: string;
  apiKeyEnv?: string;
  lifecycle?: ModelLifecycleStatus;
  nativeCapability?: ReadOnlyNativeCapability | 'unregistered';
  nativeProvider?: NativeProviderName;
  eligibleRoles?: readonly RoleEligibility[];
  allowedNativeAgentPhases?: readonly NativeAgentAllowedPhase[];
}

export interface EffectiveModelIdentity {
  requestedId: string;
  canonicalAlias: string;
  providerNativeId: string;
  nativeProvider?: NativeProviderName;
  artifactProvider?: string;
  artifactModel?: string;
  equivalentIds: readonly string[];
}

export interface EffectiveModelArtifact {
  requiredPhase?: CertificationPhase;
  requiredSuiteVersion?: string;
  path?: string;
  scope?: 'global';
  artifact?: NativeCertificationArtifact;
}

export interface EffectiveModelRuntime {
  apiKeyEnv?: string;
  hasApiKey?: boolean;
  providerEnabled?: boolean;
  directAgentsEnabled?: boolean;
}

export interface EffectiveModelCandidate {
  requestedId: string;
  stage: EffectiveModelStage;
  usable: boolean;
  launchable: boolean;
  agent?: AgentType;
  capabilities?: ModelCapabilities;
  identity: EffectiveModelIdentity;
  artifact: EffectiveModelArtifact;
  runtime: EffectiveModelRuntime;
  exclusions: EffectiveModelExclusion[];
}

export interface ResolveEffectiveModelInput {
  modelId: string;
  stage: EffectiveModelStage | 'planner' | 'coder' | 'reviewer' | 'plan' | 'implementation';
  registry: ModelRegistry;
  repoDir?: string;
  now?: Date;
  apiKeyPresent?: boolean;
  apiKeyEnv?: string;
  checkRuntime?: boolean;
  requireDirectAgent?: boolean;
  requirePatchCoding?: boolean;
}

const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._/-]+(?:\[[A-Za-z0-9._-]+\])?$/;

export function normalizeEffectiveModelStage(
  stage: ResolveEffectiveModelInput['stage'],
): EffectiveModelStage {
  if (stage === 'planner' || stage === 'plan') return 'planning';
  if (stage === 'coder' || stage === 'implementation') return 'coding';
  if (stage === 'reviewer') return 'review';
  return normalizeSupportedModelStage(stage);
}

export function requiredCertificationPhaseForEffectiveStage(
  stage: ResolveEffectiveModelInput['stage'],
  modelId: string,
  registry: ModelRegistry,
): CertificationPhase | undefined {
  return getRequiredCertificationPhaseForStage(modelId, normalizeEffectiveModelStage(stage), registry);
}

export function resolveEffectiveModel(input: ResolveEffectiveModelInput): EffectiveModelCandidate {
  const requestedId = input.modelId.trim();
  const stage = normalizeEffectiveModelStage(input.stage);
  const exclusions: EffectiveModelExclusion[] = [];
  const openrouterIdentity = resolveOpenRouterModelIdentity(requestedId);
  const canonicalAlias = openrouterIdentity?.wavemillAlias ?? requestedId;
  const capabilities = getModel(input.registry, canonicalAlias) ?? getModel(input.registry, requestedId);
  const registryId = capabilities ? (getModel(input.registry, canonicalAlias) ? canonicalAlias : requestedId) : canonicalAlias;
  const providerIdentity = resolveProviderNativeModelId(registryId, input.registry);
  const nativeProvider = providerIdentity?.provider;
  const canonicalArtifactIdentity = capabilities?.supportedModel?.canonicalArtifactIdentity;
  const storageIdentity = canonicalArtifactIdentity
    ? { provider: canonicalArtifactIdentity.provider, model: canonicalArtifactIdentity.model }
    : nativeProvider
    ? resolveCertificationStorageIdentity(nativeProvider, providerIdentity?.providerNativeId ?? registryId)
    : undefined;
  const identity: EffectiveModelIdentity = {
    requestedId,
    canonicalAlias: providerIdentity?.wavemillAlias ?? canonicalAlias,
    providerNativeId: providerIdentity?.providerNativeId ?? openrouterIdentity?.openrouterId ?? requestedId,
    ...(nativeProvider ? { nativeProvider } : {}),
    ...(storageIdentity ? { artifactProvider: storageIdentity.provider, artifactModel: storageIdentity.model } : {}),
    equivalentIds: openrouterIdentity?.equivalentIds ?? [requestedId],
  };
  const artifact: EffectiveModelArtifact = {};
  const runtime: EffectiveModelRuntime = {};

  const reject = (exclusion: EffectiveModelExclusion): void => {
    exclusions.push({ severity: 'error', ...exclusion });
  };

  if (!requestedId || !SAFE_MODEL_ID_PATTERN.test(requestedId)) {
    reject({
      code: 'invalid-model-id',
      source: 'registry',
      message: `Invalid model identifier: ${requestedId || '(empty)'}`,
    });
  }

  if (!capabilities) {
    reject({
      code: 'unknown-model',
      source: 'registry',
      message: `Model is not present in the Wavemill registry: ${requestedId}`,
    });
    return finishCandidate(input, stage, identity, artifact, runtime, exclusions);
  }

  const lifecycle = capabilities.supportedModel?.lifecycle ?? 'supported';
  if (capabilities.disabled === true || isDisabledModel(identity.canonicalAlias)) {
    reject({ code: 'disabled', source: 'registry', message: 'Model is disabled.', lifecycle });
  }
  if (lifecycle === 'blocked') {
    reject({ code: 'blocked-lifecycle', source: 'registry', message: 'Model lifecycle is blocked.', lifecycle });
  }
  if (lifecycle === 'deprecated') {
    reject({ code: 'deprecated-lifecycle', source: 'registry', message: 'Model lifecycle is deprecated.', lifecycle });
  }
  const supportedStages = capabilities.supportedModel?.stages;
  if (supportedStages && !supportedStages.includes(stage)) {
    reject({ code: 'stage-incompatible', source: 'registry', message: `Model does not support ${stage}.` });
  }
  if ((capabilities.supportedModel?.routingEligible ?? true) === false) {
    reject({ code: 'routing-ineligible', source: 'registry', message: 'Model is not routing eligible.' });
  }

  const roleEligibility = launchPriorityRoleEligibility(identity.canonicalAlias, stage);
  if (!roleEligibility.eligible) {
    reject({
      code: 'role-ineligible',
      source: 'policy',
      message: `Model is not launch-priority eligible for ${stage}.`,
      eligibleRoles: roleEligibility.eligibleRoles,
    });
  }

  const resolvedAgent = capabilities.agent
    ?? (capabilities.nativeCapability?.nativeProvider
      ? (capabilities.nativeCapability.nativeProvider === 'openai' ? 'native-openai' : 'native-openrouter')
      : undefined);

  if (resolvedAgent === 'codex' && !isCodexChatgptLaunchEligible(capabilities)) {
    reject({
      code: 'codex-chatgpt-ineligible',
      source: 'runtime',
      message: capabilities.codexChatgptCapability?.reason ?? 'Model is not available through ChatGPT-authenticated Codex.',
    });
  }

  if (isOpenRouterModel(identity.canonicalAlias) || nativeProvider === 'openrouter') {
    applyOpenRouterRuntime(input, stage, identity, runtime, reject);
  }

  if (input.requirePatchCoding) {
    const patchCodingEnabled = getNativeAgentConfig(input.repoDir).patchCoding?.enabled === true;
    if (!patchCodingEnabled) {
      reject({
        code: 'patch-coding-disabled',
        source: 'runtime',
        message: 'Native patch coding is not enabled.',
      });
    }
  }

  if (capabilities.nativeCapability) {
    evaluateNativeCertification({
      input,
      stage,
      registryId,
      capabilities,
      nativeProvider,
      identity,
      artifact,
      reject,
    });
  }

  return finishCandidate(input, stage, identity, artifact, runtime, exclusions, capabilities, resolvedAgent);
}

function applyOpenRouterRuntime(
  input: ResolveEffectiveModelInput,
  stage: EffectiveModelStage,
  identity: EffectiveModelIdentity,
  runtime: EffectiveModelRuntime,
  reject: (exclusion: EffectiveModelExclusion) => void,
): void {
  if (input.checkRuntime === false) return;
  const provider = resolveOpenRouterProviderConfig(input.repoDir);
  runtime.apiKeyEnv = provider.apiKeyEnv;
  runtime.hasApiKey = provider.hasApiKey;
  runtime.providerEnabled = provider.enabled;
  runtime.directAgentsEnabled = provider.directAgentsEnabled;

  if (!provider.enabled) {
    reject({ code: 'provider-disabled', source: 'runtime', message: 'OpenRouter provider is disabled.' });
  }
  const providerStage = stage === 'planning' ? 'planner' : stage === 'coding' ? 'coder' : stage === 'review' ? 'reviewer' : undefined;
  if (providerStage && !provider.stages.includes(providerStage)) {
    reject({ code: 'stage-not-enabled', source: 'runtime', message: `OpenRouter provider is disabled for ${providerStage}.` });
  }
  if (!provider.hasApiKey) {
    reject({ code: 'missing-api-key', source: 'runtime', message: `${provider.apiKeyEnv} is not set.`, apiKeyEnv: provider.apiKeyEnv });
  }
  if (!new Set(provider.models).has(identity.canonicalAlias)) {
    reject({ code: 'model-not-allowlisted', source: 'runtime', message: 'Model is not allowlisted for OpenRouter.' });
  }
  if (input.requireDirectAgent && !provider.directAgentsEnabled) {
    reject({ code: 'direct-agent-disabled', source: 'runtime', message: 'OpenRouter direct agents are disabled.' });
  }
}

function evaluateNativeCertification(args: {
  input: ResolveEffectiveModelInput;
  stage: EffectiveModelStage;
  registryId: string;
  capabilities: ModelCapabilities;
  nativeProvider?: NativeProviderName;
  identity: EffectiveModelIdentity;
  artifact: EffectiveModelArtifact;
  reject: (exclusion: EffectiveModelExclusion) => void;
}): void {
  const nativeCapability = args.capabilities.nativeCapability;
  const capability = nativeCapability?.readOnlyNative ?? 'unregistered';
  if (!nativeCapability || !args.nativeProvider) {
    args.reject({
      code: 'no-native-capability',
      source: 'registry',
      message: 'Model has no native provider capability.',
      nativeCapability: capability,
    });
    return;
  }
  if (nativeCapability.readOnlyNative === 'unsupported') {
    args.reject({
      code: 'native-unsupported',
      source: 'registry',
      message: 'Model native capability is unsupported.',
      nativeCapability: capability,
      nativeProvider: args.nativeProvider,
    });
  }
  const requiredPhase = requiredCertificationPhaseForEffectiveStage(args.stage, args.registryId, args.input.registry);
  const requiredSuiteVersion = nativeCapability.certification?.certificationSuiteVersion
    ?? args.capabilities.supportedModel?.certificationSuiteVersion
    ?? args.capabilities.supportedModel?.canonicalArtifactIdentity?.suiteVersion;
  artifactAssign(args.artifact, {
    ...(requiredPhase ? { requiredPhase } : {}),
    ...(requiredSuiteVersion ? { requiredSuiteVersion } : {}),
  });
  if (!requiredPhase || !requiredSuiteVersion) {
    args.reject({
      code: 'missing-certification-metadata',
      source: 'certification',
      message: 'Model is missing certification metadata.',
      nativeCapability: capability,
      nativeProvider: args.nativeProvider,
    });
    return;
  }

  if (args.input.apiKeyPresent === false) {
    args.reject({
      code: 'missing-api-key',
      source: 'runtime',
      message: `${args.input.apiKeyEnv ?? 'provider API key'} is not set.`,
      apiKeyEnv: args.input.apiKeyEnv,
      nativeCapability: capability,
      nativeProvider: args.nativeProvider,
    });
  }

  const artifactProvider = args.identity.artifactProvider ?? args.nativeProvider;
  const artifactModel = args.identity.artifactModel ?? args.identity.providerNativeId;
  const loaded = loadGlobalCertification(artifactProvider, artifactModel, requiredSuiteVersion);
  artifactAssign(args.artifact, {
    path: loaded.path,
    scope: 'global',
  });
  if (!loaded.ok) {
    args.reject({
      code: loaded.reason === 'malformed' ? 'malformed-artifact' : 'missing-artifact',
      source: 'certification',
      message: loaded.reason === 'malformed' ? 'Certification artifact is malformed.' : 'Certification artifact is missing.',
      artifactPath: loaded.path,
      artifactScope: 'global',
      requiredPhase,
      requiredSuiteVersion,
      nativeCapability: capability,
      nativeProvider: args.nativeProvider,
    });
    return;
  }
  args.artifact.artifact = loaded.artifact;

  const identityError = checkIdentity(loaded.artifact, artifactProvider, artifactModel);
  if (identityError) {
    args.reject({
      code: 'wrong-identity',
      source: 'certification',
      message: identityError.message,
      artifactPath: loaded.path,
      artifactScope: 'global',
      requiredPhase,
      foundPhase: loaded.artifact.phase,
      requiredSuiteVersion,
      foundSuiteVersion: loaded.artifact.suiteVersion,
      certifiedAt: loaded.artifact.certifiedAt,
      nativeCapability: capability,
      nativeProvider: args.nativeProvider,
    });
    return;
  }

  const eligibility = evaluateEligibility(loaded.artifact, requiredSuiteVersion, requiredPhase, args.input.now);
  if (!eligibility.eligible) {
    args.reject({
      code: mapCertificationReason(eligibility.reason),
      source: 'certification',
      message: `Certification is not eligible: ${eligibility.reason}.`,
      artifactPath: loaded.path,
      artifactScope: 'global',
      requiredPhase,
      foundPhase: eligibility.artifact?.phase,
      requiredSuiteVersion,
      foundSuiteVersion: eligibility.artifact?.suiteVersion,
      certifiedAt: eligibility.artifact?.certifiedAt,
      nativeCapability: capability,
      nativeProvider: args.nativeProvider,
    });
  }
}

function artifactAssign(artifact: EffectiveModelArtifact, values: Partial<EffectiveModelArtifact>): void {
  Object.assign(artifact, values);
}

function mapCertificationReason(reason: 'missing' | 'malformed' | 'wrong-version' | 'stale' | 'phase-insufficient' | 'scenario-failure'): EffectiveModelReasonCode {
  switch (reason) {
    case 'missing':
      return 'missing-artifact';
    case 'malformed':
      return 'malformed-artifact';
    case 'wrong-version':
      return 'wrong-suite';
    case 'stale':
      return 'stale-artifact';
    case 'phase-insufficient':
      return 'insufficient-phase';
    case 'scenario-failure':
      return 'scenario-failure';
  }
}

function finishCandidate(
  input: ResolveEffectiveModelInput,
  stage: EffectiveModelStage,
  identity: EffectiveModelIdentity,
  artifact: EffectiveModelArtifact,
  runtime: EffectiveModelRuntime,
  exclusions: EffectiveModelExclusion[],
  capabilities?: ModelCapabilities,
  agent?: AgentType,
): EffectiveModelCandidate {
  return {
    requestedId: input.modelId,
    stage,
    usable: exclusions.length === 0,
    launchable: exclusions.length === 0,
    ...(agent ? { agent } : {}),
    ...(capabilities ? { capabilities } : {}),
    identity,
    artifact,
    runtime,
    exclusions,
  };
}

function launchPriorityRoleEligibility(modelId: string, stage: EffectiveModelStage): {
  eligible: boolean;
  eligibleRoles?: readonly RoleEligibility[];
} {
  if (stage === 'expansion') {
    return { eligible: true };
  }
  const launchPriorityModel = resolveLaunchPriorityModel(modelId);
  if (!launchPriorityModel) {
    return { eligible: true };
  }
  return {
    eligible: launchPriorityModel.roleEligibility.includes(stage),
    eligibleRoles: launchPriorityModel.roleEligibility,
  };
}

export function projectEffectiveModels(input: Omit<ResolveEffectiveModelInput, 'modelId'> & { models: readonly string[] }): EffectiveModelCandidate[] {
  return [...new Set(input.models)].map((modelId) => resolveEffectiveModel({ ...input, modelId }));
}

export type EffectiveRouterRole = 'planner' | 'coder' | 'reviewer';
export type EffectiveChallengeStage = 'plan' | 'implementation' | 'review';

export function selectEffectiveRouterCandidates(input: {
  models: readonly string[];
  role: EffectiveRouterRole;
  registry: ModelRegistry;
  repoDir?: string;
  now?: Date;
}): { eligible: string[]; rejected: EffectiveModelCandidate[]; candidates: EffectiveModelCandidate[] } {
  const candidates = projectEffectiveModels({
    models: input.models,
    stage: input.role,
    registry: input.registry,
    repoDir: input.repoDir,
    now: input.now,
    apiKeyPresent: true,
    apiKeyEnv: 'ROUTER_FILTER_UNUSED',
    checkRuntime: false,
  });
  return {
    eligible: candidates.filter((candidate) => candidate.usable).map((candidate) => candidate.requestedId),
    rejected: candidates.filter((candidate) => !candidate.usable),
    candidates,
  };
}

export function selectEffectiveChallengeCandidates(input: {
  models: readonly string[];
  stage: EffectiveChallengeStage;
  registry: ModelRegistry;
  repoDir?: string;
  now?: Date;
}): { eligible: string[]; rejected: EffectiveModelCandidate[]; candidates: EffectiveModelCandidate[] } {
  const candidates = projectEffectiveModels({
    models: input.models,
    stage: input.stage,
    registry: input.registry,
    repoDir: input.repoDir,
    now: input.now,
    apiKeyPresent: true,
    apiKeyEnv: 'CHALLENGE_FILTER_UNUSED',
    checkRuntime: false,
    requirePatchCoding: input.stage === 'implementation',
  });
  return {
    eligible: candidates.filter((candidate) => candidate.usable).map((candidate) => candidate.requestedId),
    rejected: candidates.filter((candidate) => !candidate.usable),
    candidates,
  };
}
