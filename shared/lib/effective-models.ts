import {
  getNativeAgentConfig,
  getOpenRouterProviderConfig,
  type NativeAgentAllowedPhase,
} from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import { findModelExclusion } from './model-exclusions.ts';
import {
  getEffectiveRegistry,
  getModel,
  isModelEnabled,
  nativeAgentTypeForProvider,
  type AgentType,
  type ModelCapabilities,
  type ModelLifecycleStatus,
  type ModelRegistry,
  type NativeProviderName,
  type ReadOnlyNativeCapability,
} from './model-registry.ts';
import {
  resolveLaunchPriorityModel,
  resolveOpenRouterModelIdentity,
  type RoleEligibility,
} from './openrouter-catalog.ts';
import { isOpenRouterDirectAgentsEnabled } from './openrouter-provider.ts';
import { isPatchCodingEnabled } from './native-agent/coding-gate.ts';
import {
  buildGlobalCertificationPath,
  evaluateEligibility,
  loadGlobalCertification,
} from './native-agent/certification/loader.ts';
import { resolveCertificationStorageIdentity } from './native-agent/certification/identity.ts';
import { checkIdentity } from './native-agent/certification/validator.ts';
import type {
  CertificationPhase,
  NativeCertificationArtifact,
} from './native-agent/certification/schema.ts';
import type {
  RouterCertificationRejection,
  RouterCertificationRejectionReason,
  RouterRole,
} from './native-agent/certification/router-filter.ts';

export type EffectiveModelStage =
  | RouterRole
  | 'plan'
  | 'implementation'
  | 'review'
  | 'planning'
  | 'coding';

export type EffectiveModelUseCase =
  | 'router'
  | 'challenge'
  | 'provider-gate'
  | 'agent-resolution'
  | 'audit'
  | 'doctor'
  | 'report'
  | 'certification';

export type EffectiveModelReasonCode =
  | 'missing_api_key'
  | 'unregistered_model'
  | 'no_native_capability'
  | 'missing_artifact'
  | 'malformed_artifact'
  | 'wrong_identity'
  | 'wrong_suite'
  | 'stale_artifact'
  | 'insufficient_phase'
  | 'scenario_failure'
  | 'provider_disabled'
  | 'provider_stage_disabled'
  | 'provider_model_not_allowed'
  | 'direct_agents_disabled'
  | 'patch_coding_disabled'
  | 'model_disabled'
  | 'lifecycle_blocked'
  | 'stage_not_supported'
  | 'routing_ineligible'
  | 'role_ineligible'
  | 'phase_not_allowed'
  | 'model_excluded';

export interface EffectiveModelReason {
  code: EffectiveModelReasonCode;
  message: string;
}

export interface EffectiveModelIdentity {
  input: string;
  modelId: string;
  wavemillAlias: string;
  providerNativeId: string;
  nativeProvider?: NativeProviderName;
  storageProvider?: string;
  storageModel?: string;
  openrouterId?: string;
}

export interface EffectiveModelCertification {
  requiredPhase?: CertificationPhase;
  certifiedPhase?: CertificationPhase;
  requiredSuiteVersion?: string;
  foundSuiteVersion?: string;
  certifiedAt?: string;
  artifactPath?: string;
  artifactScope?: 'global';
  artifactIdentity?: { provider: string; model: string };
  artifact?: NativeCertificationArtifact;
}

export interface EffectiveModelProviderReadiness {
  provider?: NativeProviderName;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyEnv?: string;
  stageEnabled: boolean;
  modelAllowed: boolean;
  directAgentsEnabled?: boolean;
  agent?: AgentType;
}

export interface EffectiveModelPolicy {
  lifecycle: ModelLifecycleStatus;
  launchRoles?: readonly RoleEligibility[];
  allowedNativeAgentPhases?: readonly NativeAgentAllowedPhase[];
  exclusionReason?: string;
}

export interface EffectiveModelProjection {
  modelId: string;
  requestedStage: EffectiveModelStage;
  routerRole: RouterRole;
  requestedLaunchPhase: RoleEligibility;
  useCase: EffectiveModelUseCase;
  eligible: boolean;
  reasons: EffectiveModelReason[];
  primaryReason?: EffectiveModelReasonCode;
  identity: EffectiveModelIdentity;
  registry: {
    registered: boolean;
    nativeCapability?: ReadOnlyNativeCapability | 'unregistered';
    capabilities?: ModelCapabilities;
  };
  providerReadiness: EffectiveModelProviderReadiness;
  certification: EffectiveModelCertification;
  policy: EffectiveModelPolicy;
}

export interface ProjectEffectiveModelsOptions {
  models: readonly string[];
  stage: EffectiveModelStage;
  useCase?: EffectiveModelUseCase;
  repoDir?: string;
  registry?: ModelRegistry;
  now?: Date;
  apiKeyPresent?: boolean;
  apiKeyEnv?: string;
  requireNative?: boolean;
  requireCertification?: boolean;
  requirePatchCoding?: boolean;
}

const ROLE_PHASE: Record<RouterRole, CertificationPhase> = {
  reviewer: 'read-only',
  coder: 'patch',
  planner: 'workflow',
};

const ROLE_LAUNCH_PHASE: Record<RouterRole, RoleEligibility> = {
  reviewer: 'review',
  coder: 'coding',
  planner: 'planning',
};

function routerRoleForStage(stage: EffectiveModelStage): RouterRole {
  switch (stage) {
    case 'planner':
    case 'plan':
    case 'planning':
      return 'planner';
    case 'coder':
    case 'implementation':
    case 'coding':
      return 'coder';
    case 'reviewer':
    case 'review':
      return 'reviewer';
  }
}

function addReason(row: { reasons: EffectiveModelReason[] }, code: EffectiveModelReasonCode, message: string): void {
  row.reasons.push({ code, message });
}

function isLegacyNativeShim(capabilities: ModelCapabilities | undefined): boolean {
  const agent = capabilities?.agent as string | undefined;
  return agent === 'claude-openrouter' || agent === 'claude-deepseek';
}

function lifecycleFor(capabilities: ModelCapabilities | undefined): ModelLifecycleStatus {
  return capabilities?.supportedModel?.lifecycle ?? 'supported';
}

function resolveIdentity(modelId: string, capabilities: ModelCapabilities | undefined): EffectiveModelIdentity {
  const openrouter = resolveOpenRouterModelIdentity(modelId);
  const nativeProvider = capabilities?.nativeCapability?.nativeProvider
    ?? capabilities?.supportedModel?.provider
    ?? (openrouter?.nativeOpenRouter ? 'openrouter' : undefined);
  const wavemillAlias = capabilities?.supportedModel?.wavemillAlias
    ?? openrouter?.wavemillAlias
    ?? modelId;
  const providerNativeId = capabilities?.supportedModel?.providerNativeId
    ?? openrouter?.openrouterId
    ?? modelId;
  const storage = nativeProvider
    ? resolveCertificationStorageIdentity(nativeProvider, providerNativeId)
    : undefined;
  return {
    input: modelId,
    modelId: wavemillAlias,
    wavemillAlias,
    providerNativeId,
    ...(nativeProvider ? { nativeProvider } : {}),
    ...(storage ? { storageProvider: storage.provider, storageModel: storage.model } : {}),
    ...(openrouter?.openrouterId ? { openrouterId: openrouter.openrouterId } : {}),
  };
}

function evaluateOpenRouterProvider(
  row: EffectiveModelProjection,
  repoDir: string | undefined,
  role: RouterRole,
): void {
  if (row.identity.nativeProvider !== 'openrouter') {
    return;
  }

  const config = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = config.apiKeyEnv?.trim() || 'OPENROUTER_API_KEY';
  const hasApiKey = Boolean(resolveEnvValue([apiKeyEnv], repoDir));
  const stages = config.stages && config.stages.length > 0 ? config.stages : ['planner', 'coder', 'reviewer'];
  const configuredModels = config.models && config.models.length > 0
    ? config.models
    : undefined;
  const allowedAliases = configuredModels
    ? new Set(configuredModels.map((model) => resolveOpenRouterModelIdentity(model)?.wavemillAlias ?? model))
    : undefined;
  const directAgentsEnabled = isOpenRouterDirectAgentsEnabled();

  row.providerReadiness = {
    ...row.providerReadiness,
    enabled: config.enabled === true,
    hasApiKey,
    apiKeyEnv,
    stageEnabled: stages.includes(role),
    modelAllowed: !allowedAliases || allowedAliases.has(row.identity.wavemillAlias),
    directAgentsEnabled,
  };

  if (config.enabled !== true) {
    addReason(row, 'provider_disabled', 'OpenRouter provider is disabled.');
  }
  if (!stages.includes(role)) {
    addReason(row, 'provider_stage_disabled', `OpenRouter is not enabled for ${role}.`);
  }
  if (!hasApiKey) {
    addReason(row, 'missing_api_key', `${apiKeyEnv} is not set.`);
  }
  if (allowedAliases && !allowedAliases.has(row.identity.wavemillAlias)) {
    addReason(row, 'provider_model_not_allowed', 'OpenRouter model is not allowlisted.');
  }
  if (!directAgentsEnabled) {
    addReason(row, 'direct_agents_disabled', 'OpenRouter direct agents are disabled.');
  }
}

function evaluateCertification(row: EffectiveModelProjection, now: Date): void {
  const provider = row.identity.nativeProvider;
  const certMeta = row.registry.capabilities?.nativeCapability?.certification;
  const suiteVersion = certMeta?.certificationSuiteVersion?.trim();
  row.certification.requiredPhase = ROLE_PHASE[row.routerRole];
  row.certification.requiredSuiteVersion = suiteVersion;

  if (!provider || !row.identity.storageProvider || !row.identity.storageModel) {
    addReason(row, 'unregistered_model', 'Model has no native provider metadata.');
    return;
  }
  if (!suiteVersion) {
    addReason(row, 'wrong_suite', 'Model has no required certification suite metadata.');
    return;
  }

  row.certification.artifactPath = buildGlobalCertificationPath(provider, row.identity.providerNativeId, suiteVersion);
  row.certification.artifactScope = 'global';

  const loaded = loadGlobalCertification(provider, row.identity.providerNativeId, suiteVersion);
  if (!loaded.ok) {
    addReason(
      row,
      loaded.reason === 'malformed' ? 'malformed_artifact' : 'missing_artifact',
      loaded.reason === 'malformed' ? 'Certification artifact is malformed.' : 'Certification artifact is missing.',
    );
    if (loaded.path) row.certification.artifactPath = loaded.path;
    return;
  }

  row.certification.artifact = loaded.artifact;
  row.certification.artifactPath = loaded.path;
  row.certification.certifiedPhase = loaded.artifact.phase;
  row.certification.foundSuiteVersion = loaded.artifact.suiteVersion;
  row.certification.certifiedAt = loaded.artifact.certifiedAt;
  row.certification.artifactIdentity = {
    provider: loaded.artifact.provider,
    model: loaded.artifact.model,
  };

  const identityError = checkIdentity(loaded.artifact, row.identity.storageProvider, row.identity.storageModel);
  if (identityError) {
    addReason(row, 'wrong_identity', identityError.message);
    return;
  }

  const eligibility = evaluateEligibility(
    loaded.artifact,
    suiteVersion,
    row.certification.requiredPhase,
    now,
  );
  if (!eligibility.eligible) {
    const code: EffectiveModelReasonCode =
      eligibility.reason === 'wrong-version' ? 'wrong_suite'
        : eligibility.reason === 'stale' ? 'stale_artifact'
        : eligibility.reason === 'scenario-failure' ? 'scenario_failure'
        : 'insufficient_phase';
    addReason(row, code, `Certification rejected: ${eligibility.reason}.`);
  }
}

function evaluatePolicy(row: EffectiveModelProjection, repoDir: string | undefined): void {
  const capabilities = row.registry.capabilities;
  if (capabilities && !isModelEnabled(capabilities)) {
    addReason(row, 'model_disabled', 'Model is disabled in the registry.');
  }

  if (row.policy.lifecycle === 'blocked') {
    addReason(row, 'lifecycle_blocked', 'Model lifecycle is blocked.');
  }

  const stages = capabilities?.supportedModel?.stages;
  const supportedStage = row.routerRole === 'planner' ? 'planning'
    : row.routerRole === 'coder' ? 'coding'
      : 'review';
  if (stages && !stages.includes(supportedStage)) {
    addReason(row, 'stage_not_supported', `Model does not support ${supportedStage}.`);
  }
  if ((capabilities?.supportedModel?.routingEligible ?? true) === false) {
    addReason(row, 'routing_ineligible', 'Model is not routing eligible.');
  }

  const launchPriority = resolveLaunchPriorityModel(row.modelId);
  if (launchPriority) {
    row.policy.launchRoles = launchPriority.roleEligibility;
    if (!launchPriority.roleEligibility.includes(row.requestedLaunchPhase)) {
      addReason(row, 'role_ineligible', 'Launch-priority metadata excludes this role.');
    }
  }

  const nativeConfig = getNativeAgentConfig(repoDir);
  if (nativeConfig.enabled === true && row.requestedLaunchPhase !== 'coding') {
    const allowed = nativeConfig.allowedPhases ?? [];
    row.policy.allowedNativeAgentPhases = allowed;
    if (!allowed.includes(row.requestedLaunchPhase as NativeAgentAllowedPhase)) {
      addReason(row, 'phase_not_allowed', 'nativeAgent.allowedPhases excludes this launch phase.');
    }
  }

  const exclusion = findModelExclusion(row.modelId, row.routerRole, repoDir)
    ?? findModelExclusion(row.identity.input, row.routerRole, repoDir);
  if (exclusion) {
    row.policy.exclusionReason = exclusion.reason;
    addReason(row, 'model_excluded', exclusion.reason || 'Model is excluded by configuration.');
  }
}

function makeProjection(options: ProjectEffectiveModelsOptions, modelId: string): EffectiveModelProjection {
  const registry = options.registry ?? getEffectiveRegistry(options.repoDir);
  const capabilities = getModel(registry, modelId);
  const role = routerRoleForStage(options.stage);
  const identity = resolveIdentity(modelId, capabilities);
  const nativeProvider = capabilities?.nativeCapability?.nativeProvider ?? identity.nativeProvider;
  const row: EffectiveModelProjection = {
    modelId,
    requestedStage: options.stage,
    routerRole: role,
    requestedLaunchPhase: ROLE_LAUNCH_PHASE[role],
    useCase: options.useCase ?? 'router',
    eligible: false,
    reasons: [],
    identity,
    registry: {
      registered: Boolean(capabilities),
      nativeCapability: capabilities?.nativeCapability?.readOnlyNative,
      ...(capabilities ? { capabilities } : {}),
    },
    providerReadiness: {
      provider: nativeProvider,
      enabled: true,
      hasApiKey: true,
      stageEnabled: true,
      modelAllowed: true,
      agent: nativeProvider ? nativeAgentTypeForProvider(nativeProvider) : capabilities?.agent,
    },
    certification: {},
    policy: {
      lifecycle: lifecycleFor(capabilities),
    },
  };

  if (options.apiKeyPresent === false) {
    row.providerReadiness.hasApiKey = false;
    row.providerReadiness.apiKeyEnv = options.apiKeyEnv;
    addReason(row, 'missing_api_key', `${options.apiKeyEnv ?? 'API key'} is not set.`);
  }

  evaluatePolicy(row, options.repoDir);

  if (!capabilities) {
    if (options.requireNative) {
      row.registry.nativeCapability = 'unregistered';
      addReason(row, 'unregistered_model', 'Model is not registered.');
    }
  } else if (!capabilities.nativeCapability) {
    if (options.requireNative || isLegacyNativeShim(capabilities)) {
      row.registry.nativeCapability = 'unregistered';
      addReason(row, 'no_native_capability', 'Model has no native capability metadata.');
    }
  } else {
    if (options.useCase === 'provider-gate' || options.useCase === 'doctor') {
      evaluateOpenRouterProvider(row, options.repoDir, role);
    }
    if (options.requireCertification !== false) {
      evaluateCertification(row, options.now ?? new Date());
    }
  }

  if (options.requirePatchCoding || (options.useCase === 'challenge' && role === 'coder')) {
    if (capabilities?.nativeCapability) {
      const gate = options.repoDir ? isPatchCodingEnabled(options.repoDir) : { enabled: false, reason: 'config_disabled' as const };
      if (!gate.enabled) {
        addReason(row, 'patch_coding_disabled', `Native patch coding is disabled: ${gate.reason}.`);
      }
    }
  }

  row.primaryReason = row.reasons[0]?.code;
  row.eligible = row.reasons.length === 0;
  return row;
}

export function projectEffectiveModels(options: ProjectEffectiveModelsOptions): EffectiveModelProjection[] {
  return [...new Set(options.models)].map((modelId) => makeProjection(options, modelId));
}

export function projectEffectiveModel(
  options: Omit<ProjectEffectiveModelsOptions, 'models'> & { modelId: string },
): EffectiveModelProjection {
  return projectEffectiveModels({ ...options, models: [options.modelId] })[0]!;
}

export function routerReasonFromProjection(code: EffectiveModelReasonCode | undefined): RouterCertificationRejectionReason {
  switch (code) {
    case 'unregistered_model':
    case 'no_native_capability':
    case 'provider_disabled':
    case 'provider_stage_disabled':
    case 'provider_model_not_allowed':
    case 'direct_agents_disabled':
    case 'patch_coding_disabled':
      return 'no-native-capability';
    case 'malformed_artifact':
      return 'malformed';
    case 'wrong_suite':
    case 'wrong_identity':
      return 'wrong-suite';
    case 'stale_artifact':
      return 'stale';
    case 'insufficient_phase':
    case 'scenario_failure':
      return 'insufficient-phase';
    case 'role_ineligible':
      return 'role-ineligible';
    case 'phase_not_allowed':
      return 'phase-not-allowed';
    case 'missing_api_key':
    case 'missing_artifact':
    case 'model_disabled':
    case 'lifecycle_blocked':
    case 'stage_not_supported':
    case 'routing_ineligible':
    case 'model_excluded':
    default:
      return 'missing';
  }
}

export function rejectionFromProjection(row: EffectiveModelProjection): RouterCertificationRejection {
  const nativeCapability = row.registry.nativeCapability ?? 'unregistered';
  const reason = row.primaryReason === 'wrong_suite' && !row.certification.requiredSuiteVersion
    ? 'missing'
    : routerReasonFromProjection(row.primaryReason);
  return {
    modelId: row.modelId,
    role: row.routerRole,
    requestedLaunchPhase: row.requestedLaunchPhase,
    requestedPhase: row.certification.requiredPhase ?? ROLE_PHASE[row.routerRole],
    ...(row.certification.certifiedPhase ? { certifiedPhase: row.certification.certifiedPhase } : {}),
    nativeCapability,
    ...(row.identity.nativeProvider ? { nativeProvider: row.identity.nativeProvider } : {}),
    ...(row.policy.launchRoles ? { eligibleRoles: row.policy.launchRoles } : {}),
    ...(row.policy.allowedNativeAgentPhases ? { allowedNativeAgentPhases: row.policy.allowedNativeAgentPhases } : {}),
    requiredSuiteVersion: row.certification.requiredSuiteVersion ?? '',
    reason,
    ...(row.certification.artifactPath ? { artifactPath: row.certification.artifactPath } : {}),
    artifactScope: 'global',
  };
}

export function projectRouterCandidates(options: {
  models: readonly string[];
  role: RouterRole;
  registry?: ModelRegistry;
  repoDir?: string;
  now?: Date;
}): { eligible: string[]; rejected: RouterCertificationRejection[]; projections: EffectiveModelProjection[] } {
  const projections = projectEffectiveModels({
    models: options.models,
    stage: options.role,
    useCase: 'router',
    repoDir: options.repoDir,
    registry: options.registry,
    now: options.now,
  });
  return {
    eligible: projections.filter((row) => row.eligible).map((row) => row.modelId),
    rejected: projections.filter((row) => !row.eligible).map(rejectionFromProjection),
    projections,
  };
}

export function projectChallengeCandidates(options: {
  models: readonly string[];
  stage: EffectiveModelStage;
  registry?: ModelRegistry;
  repoDir?: string;
  now?: Date;
}): { eligible: string[]; rejected: RouterCertificationRejection[]; projections: EffectiveModelProjection[] } {
  const projections = projectEffectiveModels({
    models: options.models,
    stage: options.stage,
    useCase: 'challenge',
    repoDir: options.repoDir,
    registry: options.registry,
    now: options.now,
    requirePatchCoding: routerRoleForStage(options.stage) === 'coder',
  });
  return {
    eligible: projections.filter((row) => row.eligible).map((row) => row.modelId),
    rejected: projections.filter((row) => !row.eligible).map(rejectionFromProjection),
    projections,
  };
}
