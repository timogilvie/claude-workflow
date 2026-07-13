import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getAvailableModelsForStage,
  getRouterConfig,
  loadWavemillConfig,
} from './config.ts';
import {
  buildEvalSummary,
  clearChallengeSchedulerCache,
  modelStageCount,
  type ChallengeStage,
} from './challenge-scheduler.ts';
import { explainChallengePool } from './challenge-mode.ts';
import { selectLeastUsedChallenger } from './challenge-coverage-selector.ts';
import type { EvalRecord } from './eval-schema.ts';
import { loadRouterConfig, tryResolveAgent } from './model-router.ts';
import type { AgentResolutionPhase } from './model-agent-resolution.ts';
import { getEffectiveRegistry, type AgentType, type ModelClass, type ModelCapabilities } from './model-registry.ts';
import {
  evaluateNativeProviderGate,
  type NativeGateRejectReason,
} from './native-agent/certification/eligibility-gate.ts';
import {
  filterNativeModels,
  STAGE_PHASE_REQUIREMENT,
  type RouterCertificationRejectionReason,
} from './native-agent/certification/router-filter.ts';
import { resolveOpenRouterIdFromWavemillAlias, resolveWavemillAliasFromOpenRouterId } from './openrouter-catalog.ts';
import {
  explainOpenRouterProviderGate,
  isOpenRouterModel,
  type OpenRouterProviderGateExplanation,
} from './openrouter-provider.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import { explainStagePool } from './workflow-router.ts';

export type DoctorStage = 'planner' | 'coder' | 'reviewer';

export type BlockReason =
  | 'provider_disabled'
  | 'missing_api_key'
  | 'direct_agents_disabled'
  | 'stage_not_allowlisted'
  | 'model_not_allowlisted'
  | 'missing_registry_alias'
  | 'agent_resolution_failed'
  | 'certification_missing'
  | 'certification_stale'
  | 'certification_wrong_suite'
  | 'certification_malformed'
  | 'certification_insufficient_phase'
  | 'not_in_router_pool'
  | 'not_in_challenge_pool'
  | 'operating_mode_excluded';

export interface ModelIdentity {
  key: string;
  wavemillAlias: string | null;
  nativeProviderId: string | null;
  vendor: string | null;
  registryPresent: boolean;
  sourceSurfaces: string[];
}

export interface GateFailure {
  reason: BlockReason;
  configSurface: string;
  detail: string;
  remediation: string;
  pool?: 'router' | 'challenge';
}

export interface StageVerdict {
  stage: DoctorStage;
  eligible: boolean;
  routerEligible: boolean;
  challengeEligible: boolean;
  primaryReason: BlockReason | null;
  failedGates: GateFailure[];
  resolvedAgent: AgentType | null;
}

export interface ModelDiagnosis {
  identity: ModelIdentity;
  stages: Record<DoctorStage, StageVerdict>;
}

export interface OpenRouterAlert {
  code:
    | 'no_eligible_openrouter_candidates'
    | 'no_eligible_challenge_candidates'
    | 'zero_openrouter_recent_traffic';
  message: string;
  dominantReason: BlockReason | null;
}

export interface RecentTrafficSummary {
  window: number;
  usableRecords: number;
  openRouterRecords: number;
  sampledModels: string[];
}

export interface ZeroTrafficCell {
  model: string;
  stage: DoctorStage;
  primaryReason: BlockReason | null;
}

export interface OpenRouterDoctorReport {
  repoDir: string;
  operatingMode: OperatingMode;
  providerConfigured: boolean;
  providerEnabled: boolean;
  apiKeyEnv: string;
  apiKeyPresent: boolean;
  models: ModelDiagnosis[];
  zeroTrafficCells: ZeroTrafficCell[];
  nextChallengeModel: string | null;
  recentTraffic: RecentTrafficSummary;
  alerts: OpenRouterAlert[];
  notes: string[];
}

export interface DoctorOptions {
  repoDir?: string;
  stages?: DoctorStage[];
  recentWindow?: number;
  now?: Date;
}

interface MutableIdentity {
  key: string;
  wavemillAlias: string | null;
  nativeProviderId: string | null;
  vendor: string | null;
  registryPresent: boolean;
  sourceSurfaces: Set<string>;
}

interface StageContext {
  providerGate: OpenRouterProviderGateExplanation;
  routerPool: ReturnType<typeof explainStagePool>;
  challengePool: ReturnType<typeof explainChallengePool>;
  operatingMode: OperatingMode;
  routerAgentMap: Record<string, AgentType>;
  routerDefaultAgent: AgentType;
}

const DEFAULT_RECENT_WINDOW = 20;
const STAGES: readonly DoctorStage[] = ['planner', 'coder', 'reviewer'];
const STAGE_TO_CHALLENGE_STAGE: Record<DoctorStage, ChallengeStage> = {
  planner: 'plan',
  coder: 'implementation',
  reviewer: 'review',
};
const STAGE_TO_AGENT_PHASE: Record<DoctorStage, AgentResolutionPhase> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

const REMEDIATION_BY_REASON: Record<BlockReason, string> = {
  provider_disabled: 'Set providers.openrouter.enabled to true.',
  missing_api_key: 'Export the configured OpenRouter API key env var before starting mill.',
  direct_agents_disabled: 'Use a certified native OpenRouter model or enable the direct OpenRouter agent path.',
  stage_not_allowlisted: 'Add this stage to providers.openrouter.stages.',
  model_not_allowlisted: 'Add the Wavemill alias to providers.openrouter.models.',
  missing_registry_alias: 'Use a known Wavemill alias or add a registry/catalog entry for this model.',
  agent_resolution_failed: 'Fix router.agentMap or registry metadata so the model resolves to an OpenRouter-capable agent.',
  certification_missing: 'Run native certification for this model and phase.',
  certification_stale: 'Re-run native certification to refresh the expired artifact.',
  certification_wrong_suite: 'Re-run native certification with the suite version required by the registry.',
  certification_malformed: 'Repair or regenerate the native certification artifact.',
  certification_insufficient_phase: 'Certify the model for the required planner/coder/reviewer phase.',
  not_in_router_pool: 'Add the alias to router.availableModels or router.models for this stage.',
  not_in_challenge_pool: 'Add the alias to challenge.models or the router challenge source pool.',
  operating_mode_excluded: 'Wait for quota recovery or use a degraded-mode-eligible model class.',
};

function uniq(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function stageList(requested?: readonly DoctorStage[]): DoctorStage[] {
  if (!requested || requested.length === 0) {
    return [...STAGES];
  }
  return uniq(requested).filter((stage): stage is DoctorStage => STAGES.includes(stage as DoctorStage));
}

function pushFailure(target: GateFailure[], failure: GateFailure): void {
  if (target.some((existing) => existing.reason === failure.reason && existing.pool === failure.pool)) {
    return;
  }
  target.push(failure);
}

function nativeReasonToBlockReason(reason: NativeGateRejectReason): BlockReason {
  switch (reason) {
    case 'missing_api_key':
    case 'missing_artifact':
      return 'certification_missing';
    case 'wrong_suite':
      return 'certification_wrong_suite';
    case 'stale_artifact':
      return 'certification_stale';
    case 'insufficient_phase':
      return 'certification_insufficient_phase';
    case 'unregistered_model':
      return 'missing_registry_alias';
  }
}

function routerCertReasonToBlockReason(reason: RouterCertificationRejectionReason): BlockReason {
  switch (reason) {
    case 'missing':
      return 'certification_missing';
    case 'malformed':
      return 'certification_malformed';
    case 'wrong-suite':
      return 'certification_wrong_suite';
    case 'stale':
      return 'certification_stale';
    case 'insufficient-phase':
      return 'certification_insufficient_phase';
    case 'no-native-capability':
      return 'direct_agents_disabled';
  }
}

function storageIdFromAlias(alias: string | null): string | null {
  if (!alias) {
    return null;
  }
  return resolveOpenRouterIdFromWavemillAlias(alias);
}

function isOpenRouterNativeModel(capabilities: ModelCapabilities | undefined): boolean {
  return capabilities?.nativeCapability?.nativeProvider === 'openrouter';
}

function operatingModeAllowsModel(modelClass: ModelClass | undefined, operatingMode: OperatingMode): boolean {
  if (!modelClass || operatingMode === 'normal') {
    return true;
  }
  if (operatingMode === 'survival') {
    return modelClass === 'fast_economy';
  }
  return modelClass === 'strong_generalist' || modelClass === 'fast_economy';
}

function isUnexpectedFallbackAgent(
  identity: ModelIdentity,
  capabilities: ModelCapabilities | undefined,
  agent: AgentType,
): boolean {
  if (agent !== 'codex' && agent !== 'claude') {
    return false;
  }
  if (!identity.wavemillAlias || !isOpenRouterModel(identity.wavemillAlias)) {
    return false;
  }
  return capabilities?.vendor !== 'openai' && capabilities?.vendor !== 'anthropic' && capabilities?.vendor !== 'deepseek';
}

function evalFilePath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
}

function readLastJsonlLines(filePath: string, limit: number): string[] {
  if (!existsSync(filePath) || limit <= 0) {
    return [];
  }

  const size = statSync(filePath).size;
  if (size <= 0) {
    return [];
  }

  const fd = openSync(filePath, 'r');
  const chunkSize = 8192;
  const chunks: string[] = [];
  const lines: string[] = [];
  let position = size;

  try {
    while (position > 0 && lines.length <= limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, position);
      chunks.unshift(buffer.toString('utf-8'));
      const combined = chunks.join('');
      lines.splice(0, lines.length, ...combined.split('\n'));
    }
  } finally {
    closeSync(fd);
  }

  return lines.map((line) => line.trim()).filter(Boolean).slice(-limit);
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractRoutingChosenModel(record: Record<string, unknown>): string | null {
  const routingDecision = record.routingDecision as Record<string, unknown> | undefined;
  if (!routingDecision || typeof routingDecision !== 'object') {
    return null;
  }
  const chosen = routingDecision.chosen;
  if (chosen && typeof chosen === 'object' && !Array.isArray(chosen)) {
    return stringField((chosen as Record<string, unknown>).modelId);
  }
  if (typeof chosen === 'number' && Array.isArray(routingDecision.candidates)) {
    const candidate = routingDecision.candidates[chosen] as Record<string, unknown> | undefined;
    return stringField(candidate?.modelId);
  }
  return null;
}

function extractRouteArtifactModels(route: unknown): string[] {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return [];
  }
  const record = route as Record<string, unknown>;
  return uniq([
    stringField(record.planner),
    stringField(record.coder),
    stringField(record.reviewer),
  ].filter((value): value is string => Boolean(value)));
}

function extractModelsFromEvalRecord(record: Record<string, unknown>): string[] {
  const models = new Set<string>();
  const add = (value: unknown) => {
    const model = stringField(value);
    if (model) {
      models.add(model);
    }
  };

  add(record.modelId);
  const executedPlanning = record.executedPlanning as Record<string, unknown> | undefined;
  add(executedPlanning?.model);
  add(extractRoutingChosenModel(record));

  const challengeRouteContext = record.challengeRouteContext as Record<string, unknown> | undefined;
  for (const route of [
    challengeRouteContext?.bootstrapRoute,
    challengeRouteContext?.expandedRoute,
  ]) {
    for (const model of extractRouteArtifactModels(route)) {
      models.add(model);
    }
  }

  const routeProvenance = record.routeProvenance as Record<string, unknown> | undefined;
  for (const route of [
    routeProvenance?.activeRoute,
    routeProvenance?.bootstrapRoute,
    routeProvenance?.expandedRoute,
  ]) {
    for (const model of extractRouteArtifactModels(route)) {
      models.add(model);
    }
  }

  return [...models];
}

function isOpenRouterTrafficModel(
  modelId: string,
  diagnosisSet: ReadonlySet<string>,
  repoDir: string,
): boolean {
  if (diagnosisSet.has(modelId) || isOpenRouterModel(modelId)) {
    return true;
  }
  return getEffectiveRegistry(repoDir).models[modelId]?.nativeCapability?.nativeProvider === 'openrouter';
}

function analyzeRecentTraffic(
  repoDir: string,
  recentWindow: number,
  diagnosisSet: ReadonlySet<string>,
): RecentTrafficSummary {
  const filePath = evalFilePath(repoDir);
  const lines = readLastJsonlLines(filePath, Math.max(recentWindow * 8, 80));
  const sampledModels = new Set<string>();
  let usableRecords = 0;
  let openRouterRecords = 0;

  for (let index = lines.length - 1; index >= 0 && usableRecords < recentWindow; index -= 1) {
    const parsed = parseJsonLine(lines[index] || '');
    if (!parsed) {
      continue;
    }
    const models = extractModelsFromEvalRecord(parsed);
    if (models.length === 0) {
      continue;
    }
    usableRecords += 1;
    const openRouterModels = models.filter((model) => isOpenRouterTrafficModel(model, diagnosisSet, repoDir));
    if (openRouterModels.length > 0) {
      openRouterRecords += 1;
      for (const model of openRouterModels) {
        sampledModels.add(model);
      }
    }
  }

  return {
    window: recentWindow,
    usableRecords,
    openRouterRecords,
    sampledModels: [...sampledModels].sort(),
  };
}

function collectModelIdentities(repoDir: string): ModelIdentity[] {
  const config = loadWavemillConfig(repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const identities = new Map<string, MutableIdentity>();

  function upsert(rawValue: string, sourceSurface: string, mode: 'alias' | 'native-id'): void {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return;
    }

    if (mode === 'alias' && !isOpenRouterModel(trimmed)) {
      return;
    }

    const alias = mode === 'alias'
      ? trimmed
      : resolveWavemillAliasFromOpenRouterId(trimmed);
    const nativeProviderId = mode === 'native-id'
      ? trimmed
      : storageIdFromAlias(trimmed);
    const key = alias ?? `native:${trimmed}`;
    const capabilities = alias ? registry.models[alias] : undefined;
    const vendor = capabilities?.vendor ?? (nativeProviderId?.split('/')[0] ?? null);

    const existing = identities.get(key);
    if (existing) {
      existing.sourceSurfaces.add(sourceSurface);
      if (!existing.nativeProviderId && nativeProviderId) {
        existing.nativeProviderId = nativeProviderId;
      }
      if (!existing.vendor && vendor) {
        existing.vendor = vendor;
      }
      existing.registryPresent = existing.registryPresent || Boolean(alias && registry.models[alias]);
      return;
    }

    identities.set(key, {
      key,
      wavemillAlias: alias,
      nativeProviderId,
      vendor,
      registryPresent: Boolean(alias && registry.models[alias]),
      sourceSurfaces: new Set([sourceSurface]),
    });
  }

  for (const model of config.providers?.openrouter?.models ?? []) {
    upsert(model, 'providers.openrouter.models', 'alias');
  }
  for (const model of config.nativeAgent?.providers?.openrouter?.models ?? []) {
    upsert(model, 'nativeAgent.providers.openrouter.models', 'native-id');
  }
  for (const model of config.router?.models ?? []) {
    upsert(model, 'router.models', 'alias');
  }
  for (const stage of STAGES) {
    for (const model of config.router?.availableModels?.[stage] ?? []) {
      upsert(model, `router.availableModels.${stage}`, 'alias');
    }
  }
  for (const model of config.challenge?.models ?? []) {
    upsert(model, 'challenge.models', 'alias');
  }

  return [...identities.values()]
    .map((identity) => ({
      key: identity.key,
      wavemillAlias: identity.wavemillAlias,
      nativeProviderId: identity.nativeProviderId,
      vendor: identity.vendor,
      registryPresent: identity.registryPresent,
      sourceSurfaces: [...identity.sourceSurfaces].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function configuredRouterPool(stage: DoctorStage, repoDir: string): string[] {
  const routerConfig = getRouterConfig(repoDir);
  const explicit = routerConfig.availableModels?.[stage];
  if (explicit && explicit.length > 0) {
    return uniq(explicit);
  }
  if (routerConfig.models && routerConfig.models.length > 0) {
    return uniq(routerConfig.models);
  }
  return uniq(explainStagePool(stage, repoDir).basePool);
}

function configuredChallengePool(repoDir: string): string[] {
  const config = loadWavemillConfig(repoDir);
  if (config.challenge?.models && config.challenge.models.length > 0) {
    return uniq(config.challenge.models);
  }
  if (config.router?.models && config.router.models.length > 0) {
    return uniq(config.router.models);
  }
  return uniq(explainChallengePool('implementation', repoDir).configuredPool);
}

function buildStageContext(
  repoDir: string,
  stage: DoctorStage,
  now: Date | undefined,
): StageContext {
  const routerOptions = loadRouterConfig(repoDir);
  return {
    providerGate: explainOpenRouterProviderGate('__placeholder__', repoDir, stage),
    routerPool: explainStagePool(stage, repoDir),
    challengePool: explainChallengePool(STAGE_TO_CHALLENGE_STAGE[stage], repoDir, { now }),
    operatingMode: getCurrentOperatingMode(repoDir),
    routerAgentMap: routerOptions.agentMap ?? {},
    routerDefaultAgent: routerOptions.defaultAgent ?? 'codex',
  };
}

function diagnoseStage(
  identity: ModelIdentity,
  stage: DoctorStage,
  repoDir: string,
  now: Date | undefined,
  operatingMode: OperatingMode,
): StageVerdict {
  const alias = identity.wavemillAlias;
  const registry = getEffectiveRegistry(repoDir);
  const capabilities = alias ? registry.models[alias] : undefined;
  const routerOptions = loadRouterConfig(repoDir);
  const providerGate = alias
    ? explainOpenRouterProviderGate(alias, repoDir, stage)
    : explainOpenRouterProviderGate('', repoDir, stage);
  const routerPool = explainStagePool(stage, repoDir);
  const challengePool = explainChallengePool(STAGE_TO_CHALLENGE_STAGE[stage], repoDir, { now });
  const failures: GateFailure[] = [];

  if (!providerGate.enabled) {
    pushFailure(failures, {
      reason: 'provider_disabled',
      configSurface: 'providers.openrouter.enabled',
      detail: 'providers.openrouter.enabled is not true.',
      remediation: REMEDIATION_BY_REASON.provider_disabled,
    });
  }

  if (!providerGate.hasApiKey) {
    pushFailure(failures, {
      reason: 'missing_api_key',
      configSurface: `env:${providerGate.apiKeyEnv}`,
      detail: `${providerGate.apiKeyEnv} is absent or blank.`,
      remediation: REMEDIATION_BY_REASON.missing_api_key,
    });
  }

  if (!providerGate.stageAllowed) {
    pushFailure(failures, {
      reason: 'stage_not_allowlisted',
      configSurface: 'providers.openrouter.stages',
      detail: `${stage} is not enabled in providers.openrouter.stages.`,
      remediation: REMEDIATION_BY_REASON.stage_not_allowlisted,
    });
  }

  if (alias && !providerGate.modelAllowed) {
    pushFailure(failures, {
      reason: 'model_not_allowlisted',
      configSurface: 'providers.openrouter.models',
      detail: `${alias} is not allowlisted in providers.openrouter.models.`,
      remediation: REMEDIATION_BY_REASON.model_not_allowlisted,
    });
  }

  if (!alias || !identity.registryPresent || (alias && !providerGate.registryAliasPresent)) {
    pushFailure(failures, {
      reason: 'missing_registry_alias',
      configSurface: identity.sourceSurfaces[0] ?? 'providers.openrouter.models',
      detail: identity.nativeProviderId
        ? `${identity.nativeProviderId} does not resolve to a known Wavemill alias.`
        : 'No registry-backed Wavemill alias was found for this model.',
      remediation: REMEDIATION_BY_REASON.missing_registry_alias,
    });
  }

  const nativeCapable = isOpenRouterNativeModel(capabilities);
  if (alias && !nativeCapable && !providerGate.directAgentsEnabled) {
    pushFailure(failures, {
      reason: 'direct_agents_disabled',
      configSurface: providerGate.directAgentsEnv,
      detail: `${providerGate.directAgentsEnv} is disabled and ${alias} has no native OpenRouter path.`,
      remediation: REMEDIATION_BY_REASON.direct_agents_disabled,
    });
  }

  let resolvedAgent: AgentType | null = null;
  if (alias && identity.registryPresent) {
    const resolution = tryResolveAgent(
      alias,
      routerOptions.agentMap ?? {},
      routerOptions.defaultAgent ?? 'codex',
      repoDir,
      STAGE_TO_AGENT_PHASE[stage],
    );

    if (!resolution.ok) {
      if (!(nativeCapable && resolution.reason === 'uncertified')) {
        pushFailure(failures, {
          reason: 'agent_resolution_failed',
          configSurface: routerOptions.agentMap?.[alias] ? `router.agentMap.${alias}` : 'shared/lib/model-agent-resolution.ts',
          detail: resolution.diagnostic,
          remediation: REMEDIATION_BY_REASON.agent_resolution_failed,
        });
      }
    } else {
      resolvedAgent = resolution.agent;
      if (isUnexpectedFallbackAgent(identity, capabilities, resolution.agent)) {
        pushFailure(failures, {
          reason: 'agent_resolution_failed',
          configSurface: routerOptions.agentMap?.[alias] ? `router.agentMap.${alias}` : 'shared/lib/model-agent-resolution.ts',
          detail: `${alias} resolved to ${resolution.agent}, so OpenRouter traffic would fall back away from the configured model.`,
          remediation: REMEDIATION_BY_REASON.agent_resolution_failed,
        });
      }
    }
  }

  if (alias && nativeCapable) {
    const certResult = providerGate.hasApiKey
      ? filterNativeModels([alias], stage, registry, repoDir, now)
      : { eligible: [], rejected: [] };

    const certRejection = certResult.rejected[0];
    if (certRejection) {
      const mappedReason = routerCertReasonToBlockReason(certRejection.reason);
      pushFailure(failures, {
        reason: mappedReason,
        configSurface: `modelRegistry.models.${alias}.nativeCapability.certification`,
        detail: `Native certification rejected for ${stage}: ${certRejection.reason}.`,
        remediation: REMEDIATION_BY_REASON[mappedReason],
      });
    }
  }

  if (!operatingModeAllowsModel(capabilities?.class, operatingMode)) {
    pushFailure(failures, {
      reason: 'operating_mode_excluded',
      configSurface: 'wavemill quota status',
      detail: `${operatingMode} mode excludes ${capabilities?.class ?? 'this'} models from the degraded router pool.`,
      remediation: REMEDIATION_BY_REASON.operating_mode_excluded,
    });
  }

  if (alias && !configuredRouterPool(stage, repoDir).includes(alias)) {
    pushFailure(failures, {
      reason: 'not_in_router_pool',
      configSurface: `router.availableModels.${stage}`,
      detail: `${alias} is not present in the configured ${stage} router pool.`,
      remediation: REMEDIATION_BY_REASON.not_in_router_pool,
      pool: 'router',
    });
  }

  if (alias && !configuredChallengePool(repoDir).includes(alias)) {
    pushFailure(failures, {
      reason: 'not_in_challenge_pool',
      configSurface: 'challenge.models',
      detail: `${alias} is not present in the configured challenge pool.`,
      remediation: REMEDIATION_BY_REASON.not_in_challenge_pool,
      pool: 'challenge',
    });
  }

  const commonFailureReasons = new Set(
    failures
      .filter((failure) => failure.pool !== 'router' && failure.pool !== 'challenge')
      .map((failure) => failure.reason),
  );

  const routerEligible = Boolean(
    alias
    && !commonFailureReasons.size
    && routerPool.models.includes(alias)
    && operatingModeAllowsModel(capabilities?.class, operatingMode),
  );
  const challengeEligible = Boolean(
    alias
    && !commonFailureReasons.size
    && challengePool.eligibleModels.includes(alias)
    && operatingModeAllowsModel(capabilities?.class, operatingMode),
  );

  return {
    stage,
    eligible: routerEligible || challengeEligible,
    routerEligible,
    challengeEligible,
    primaryReason: failures[0]?.reason ?? null,
    failedGates: failures,
    resolvedAgent,
  };
}

function nextChallengeModel(repoDir: string, notes: string[]): string | null {
  const pool = explainChallengePool('implementation', repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const openRouterEligible = pool.eligibleModels.filter((model) =>
    isOpenRouterModel(model) || registry.models[model]?.nativeCapability?.nativeProvider === 'openrouter',
  );
  if (openRouterEligible.length === 0) {
    return null;
  }
  if (openRouterEligible.length === 1) {
    return openRouterEligible[0] ?? null;
  }
  if (pool.eligibleModels.length < 2) {
    return null;
  }

  clearChallengeSchedulerCache(repoDir);
  const summary = buildEvalSummary(repoDir);
  const routerConfig = loadRouterConfig(repoDir);
  const primaryModel = routerConfig.defaultModel
    ?? pool.eligibleModels.find((model) =>
      !isOpenRouterModel(model) && registry.models[model]?.nativeCapability?.nativeProvider !== 'openrouter',
    )
    ?? pool.eligibleModels[0]
    ?? '';

  const selection = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel,
    candidates: openRouterEligible,
    coverage: (model, stage) => modelStageCount(summary, model, stage),
    rotationSeed: `doctor:${repoDir}`,
  });

  if (!selection.model) {
    notes.push('No eligible implementation-stage challenger could be selected from the current challenge pool.');
    return null;
  }
  return selection.model;
}

function dominantReason(models: ModelDiagnosis[]): BlockReason | null {
  const counts = new Map<BlockReason, number>();
  for (const model of models) {
    for (const stage of STAGES) {
      const reason = model.stages[stage].primaryReason;
      if (!reason || reason === 'operating_mode_excluded') {
        continue;
      }
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

export function diagnoseOpenRouter(options: DoctorOptions = {}): OpenRouterDoctorReport {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const recentWindow = options.recentWindow ?? DEFAULT_RECENT_WINDOW;
  const now = options.now;
  const operatingMode = getCurrentOperatingMode(repoDir);
  const identities = collectModelIdentities(repoDir);
  const providerGate = explainOpenRouterProviderGate('__placeholder__', repoDir);
  const selectedStages = stageList(options.stages);
  const models = identities.map((identity) => {
    const stages = Object.fromEntries(
      STAGES.map((stage) => [
        stage,
        selectedStages.includes(stage)
          ? diagnoseStage(identity, stage, repoDir, now, operatingMode)
          : {
            stage,
            eligible: false,
            routerEligible: false,
            challengeEligible: false,
            primaryReason: null,
            failedGates: [],
            resolvedAgent: null,
          } satisfies StageVerdict,
      ]),
    ) as Record<DoctorStage, StageVerdict>;

    return { identity, stages };
  });

  const diagnosisSet = new Set<string>();
  for (const model of models) {
    if (model.identity.wavemillAlias) {
      diagnosisSet.add(model.identity.wavemillAlias);
    }
    if (model.identity.nativeProviderId) {
      diagnosisSet.add(model.identity.nativeProviderId);
    }
  }

  const recentTraffic = analyzeRecentTraffic(repoDir, recentWindow, diagnosisSet);
  const zeroTrafficCells = models.flatMap((model) =>
    selectedStages
      .filter((stage) => !model.stages[stage].eligible)
      .map((stage) => ({
        model: model.identity.wavemillAlias ?? model.identity.nativeProviderId ?? model.identity.key,
        stage,
        primaryReason: model.stages[stage].primaryReason,
      } satisfies ZeroTrafficCell)),
  );

  const notes: string[] = [];
  const alerts: OpenRouterAlert[] = [];
  const anyRouterEligible = models.some((model) =>
    selectedStages.some((stage) => model.stages[stage].routerEligible),
  );
  const anyChallengeEligible = models.some((model) =>
    selectedStages.some((stage) => model.stages[stage].challengeEligible),
  );
  const dominant = dominantReason(models);

  if (providerGate.enabled && !anyRouterEligible) {
    alerts.push({
      code: 'no_eligible_openrouter_candidates',
      message: 'OpenRouter is configured, but no eligible planner/coder/reviewer router candidates remain.',
      dominantReason: dominant,
    });
  }

  if (providerGate.enabled && !anyChallengeEligible) {
    alerts.push({
      code: 'no_eligible_challenge_candidates',
      message: 'OpenRouter is configured, but no eligible challenge candidates remain.',
      dominantReason: dominant,
    });
  }

  if (providerGate.enabled && recentTraffic.usableRecords >= 5 && recentTraffic.openRouterRecords === 0) {
    alerts.push({
      code: 'zero_openrouter_recent_traffic',
      message: `The last ${recentTraffic.usableRecords} usable eval records routed only Claude/Codex traffic.`,
      dominantReason: dominant,
    });
  }

  const onlyOperatingMode = models.length > 0 && models.every((model) =>
    selectedStages.every((stage) =>
      model.stages[stage].primaryReason === null
      || model.stages[stage].primaryReason === 'operating_mode_excluded',
    ),
  );
  const filteredAlerts = onlyOperatingMode
    ? alerts.filter((alert) => alert.code !== 'no_eligible_openrouter_candidates')
    : alerts;

  return {
    repoDir,
    operatingMode,
    providerConfigured: identities.length > 0,
    providerEnabled: providerGate.enabled,
    apiKeyEnv: providerGate.apiKeyEnv,
    apiKeyPresent: providerGate.hasApiKey,
    models,
    zeroTrafficCells,
    nextChallengeModel: nextChallengeModel(repoDir, notes),
    recentTraffic,
    alerts: filteredAlerts,
    notes,
  };
}

function formatStageVerdict(stage: StageVerdict): string {
  if (stage.eligible) {
    const pools = [
      stage.routerEligible ? 'router' : null,
      stage.challengeEligible ? 'challenge' : null,
    ].filter((value): value is string => Boolean(value));
    return `${stage.stage}: eligible via ${pools.join('+')}`;
  }
  const failure = stage.failedGates[0];
  if (!failure) {
    return `${stage.stage}: blocked`;
  }
  return `${stage.stage}: blocked reason=${failure.reason} surface=${failure.configSurface} remediation=${failure.remediation}`;
}

export function formatDoctorReport(report: OpenRouterDoctorReport): string {
  const lines: string[] = [];
  lines.push(`OpenRouter doctor (${report.repoDir})`);
  lines.push(`provider: ${report.providerEnabled ? 'enabled' : 'disabled'}  api_key: ${report.apiKeyPresent ? 'present' : 'missing'} (${report.apiKeyEnv})  operating_mode: ${report.operatingMode}`);

  for (const model of report.models) {
    lines.push('');
    lines.push(`${model.identity.wavemillAlias ?? '(no alias)'}${model.identity.nativeProviderId ? `  native=${model.identity.nativeProviderId}` : ''}`);
    lines.push(`sources: ${model.identity.sourceSurfaces.join(', ')}`);
    for (const stage of STAGES) {
      lines.push(`  ${formatStageVerdict(model.stages[stage])}`);
    }
  }

  lines.push('');
  lines.push(`zero-traffic cells: ${report.zeroTrafficCells.length}`);
  lines.push(`recent traffic: openrouter=${report.recentTraffic.openRouterRecords}/${report.recentTraffic.usableRecords} usable recent records`);
  lines.push(`next challenge model: ${report.nextChallengeModel ?? 'none'}`);

  if (report.alerts.length > 0) {
    lines.push('');
    lines.push('alerts:');
    for (const alert of report.alerts) {
      lines.push(`  ${alert.code}: ${alert.message}${alert.dominantReason ? ` (reason=${alert.dominantReason})` : ''}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('notes:');
    for (const note of report.notes) {
      lines.push(`  ${note}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatZeroTrafficWarning(report: OpenRouterDoctorReport): string | null {
  if (!report.providerEnabled || report.alerts.length === 0) {
    return null;
  }
  const dominantAlert = report.alerts[0];
  if (!dominantAlert) {
    return null;
  }
  return `OpenRouter configured but ${dominantAlert.code.replaceAll('_', ' ')}${dominantAlert.dominantReason ? ` (${dominantAlert.dominantReason})` : ''}. Run wavemill doctor openrouter.`;
}
