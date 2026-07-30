import { resolve } from 'node:path';
import {
  getAvailableModelsForStage,
  getNativeAgentConfig,
  getOpenRouterProviderConfig,
  getRouterConfig,
} from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import {
  OPENROUTER_DIRECT_AGENTS_ENV,
  filterOpenRouterModels,
  isOpenRouterDirectAgentsEnabled,
  resolveOpenRouterProviderConfig,
} from './openrouter-provider.ts';
import {
  resolveOpenRouterIdFromWavemillAlias,
  resolveWavemillAliasFromOpenRouterId,
} from './openrouter-catalog.ts';
import {
  getEffectiveRegistry,
  getModel,
  isModelEnabled,
  type AgentType,
  type ModelCapabilities,
} from './model-registry.ts';
import { tryResolveAgent } from './model-router.ts';
import {
  buildGlobalCertificationPath,
  filterNativeModels,
  STAGE_PHASE_REQUIREMENT,
  type RouterCertificationRejection,
} from './native-agent/certification/index.ts';
import {
  collectRecentSelections,
  detectZeroTraffic,
  renderZeroTrafficAlert,
  type RecentSelection,
  type ZeroTrafficAlert,
} from './openrouter-zero-traffic.ts';

export const OPENROUTER_DOCTOR_STAGES = ['planner', 'coder', 'reviewer'] as const;
export type OpenRouterDoctorStage = typeof OPENROUTER_DOCTOR_STAGES[number];
export type OpenRouterDoctorReasonCode =
  | 'PROVIDER_DISABLED'
  | 'MISSING_API_KEY'
  | 'DIRECT_AGENTS_DISABLED'
  | 'MISSING_REGISTRY_ALIAS'
  | 'CERTIFICATION_REJECTED'
  | 'AGENT_FALLBACK_TO_CODEX'
  | 'STAGE_NOT_PERMITTED'
  | 'OPERATING_MODE_RESTRICTED';

export interface OpenRouterDoctorReason {
  reason: OpenRouterDoctorReasonCode;
  detail: string;
  configSurface: string;
  remediation: string;
}

export interface OpenRouterDoctorCell {
  stage: OpenRouterDoctorStage;
  eligible: boolean;
  observedSelections: number;
  primaryReason: OpenRouterDoctorReason | null;
  secondaryReasons: OpenRouterDoctorReason[];
}

export interface OpenRouterDoctorModelReport {
  id: string;
  alias: string | null;
  nativeProviderId: string | null;
  registryModelId: string | null;
  storagePath: string | null;
  configSurfaces: string[];
  eligibleStages: OpenRouterDoctorStage[];
  cells: OpenRouterDoctorCell[];
}

export interface OpenRouterDoctorSummary {
  configuredModelCount: number;
  eligibleCellCount: number;
  eligibleModelCount: number;
  operatingMode: OperatingMode;
  providerEnabled: boolean;
  providerApiKeyEnv: string;
  providerHasApiKey: boolean;
  nativeApiKeyEnv: string;
  nativeHasApiKey: boolean;
  directAgentsEnabled: boolean;
  observedSelectionCount: number;
  routerPoolEligibleCounts: Record<OpenRouterDoctorStage, number>;
  challengePoolEligibleCounts: Record<'plan' | 'implementation' | 'review', number>;
  topBlockingReasons: Array<{ reason: OpenRouterDoctorReasonCode; count: number }>;
}

export interface OpenRouterDoctorReport {
  repoDir: string;
  generatedAt: string;
  lookback: number;
  models: OpenRouterDoctorModelReport[];
  recentSelections: RecentSelection[];
  zeroTrafficCells: Array<{ modelId: string; stage: OpenRouterDoctorStage; observedSelections: number }>;
  zeroTrafficAlert: ZeroTrafficAlert | null;
  zeroTrafficAlertText: string | null;
  summary: OpenRouterDoctorSummary;
}

export interface DiagnoseOpenRouterOptions {
  repoDir?: string;
  stage?: OpenRouterDoctorStage;
  lookback?: number;
}

interface CandidateAccumulator {
  key: string;
  alias: string | null;
  nativeProviderId: string | null;
  configSurfaces: Set<string>;
  providerConfiguredValues: Set<string>;
  nativeConfiguredValues: Set<string>;
}

const CHALLENGE_STAGE_BY_DOCTOR_STAGE: Record<OpenRouterDoctorStage, 'plan' | 'implementation' | 'review'> = {
  planner: 'plan',
  coder: 'implementation',
  reviewer: 'review',
};
const DOCTOR_STAGE_BY_AGENT_PHASE: Record<OpenRouterDoctorStage, 'planning' | 'coding' | 'review'> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};
const ALLOWED_CLASSES_BY_OPERATING_MODE: Record<OperatingMode, Set<string> | null> = {
  normal: null,
  constrained: new Set(['strong_generalist', 'fast_economy']),
  survival: new Set(['fast_economy']),
};

function normalizeList(values?: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function buildReason(
  reason: OpenRouterDoctorReasonCode,
  detail: string,
  configSurface: string,
  remediation: string,
): OpenRouterDoctorReason {
  return {
    reason,
    detail,
    configSurface,
    remediation,
  };
}

function appendReason(target: OpenRouterDoctorReason[], reason: OpenRouterDoctorReason): void {
  if (target.some((entry) =>
    entry.reason === reason.reason
    && entry.detail === reason.detail
    && entry.configSurface === reason.configSurface
  )) {
    return;
  }
  target.push(reason);
}

function deriveCandidateKey(alias: string | null, nativeProviderId: string | null, fallback: string): string {
  return `${alias ?? ''}|${nativeProviderId ?? fallback}`;
}

function isRawOpenRouterId(value: string): boolean {
  return value.includes('/');
}

function collectConfiguredCandidates(repoDir: string): CandidateAccumulator[] {
  const providerModels = normalizeList(getOpenRouterProviderConfig(repoDir).models);
  const nativeModels = normalizeList(getNativeAgentConfig(repoDir).providers?.openrouter?.models);
  const byKey = new Map<string, CandidateAccumulator>();

  const ensureCandidate = (input: {
    alias: string | null;
    nativeProviderId: string | null;
    configuredValue: string;
    configSurface: string;
    source: 'provider' | 'native';
  }): CandidateAccumulator => {
    const key = deriveCandidateKey(input.alias, input.nativeProviderId, input.configuredValue);
    const existing = byKey.get(key);
    if (existing) {
      existing.configSurfaces.add(input.configSurface);
      if (input.source === 'provider') {
        existing.providerConfiguredValues.add(input.configuredValue);
      } else {
        existing.nativeConfiguredValues.add(input.configuredValue);
      }
      return existing;
    }

    const created: CandidateAccumulator = {
      key,
      alias: input.alias,
      nativeProviderId: input.nativeProviderId,
      configSurfaces: new Set([input.configSurface]),
      providerConfiguredValues: new Set(input.source === 'provider' ? [input.configuredValue] : []),
      nativeConfiguredValues: new Set(input.source === 'native' ? [input.configuredValue] : []),
    };
    byKey.set(key, created);
    return created;
  };

  for (const value of providerModels) {
    const alias = isRawOpenRouterId(value) ? resolveWavemillAliasFromOpenRouterId(value) : value;
    const nativeProviderId = isRawOpenRouterId(value) ? value : resolveOpenRouterIdFromWavemillAlias(value);
    ensureCandidate({
      alias,
      nativeProviderId,
      configuredValue: value,
      configSurface: 'providers.openrouter.models',
      source: 'provider',
    });
  }

  for (const value of nativeModels) {
    ensureCandidate({
      alias: resolveWavemillAliasFromOpenRouterId(value),
      nativeProviderId: value,
      configuredValue: value,
      configSurface: 'nativeAgent.providers.openrouter.models',
      source: 'native',
    });
  }

  return [...byKey.values()];
}

function resolveRegistryModelId(
  candidate: CandidateAccumulator,
  registry: ReturnType<typeof getEffectiveRegistry>,
): string | null {
  for (const modelId of [candidate.alias, candidate.nativeProviderId]) {
    if (modelId && registry.models[modelId]) {
      return modelId;
    }
  }
  return null;
}

function resolveStoragePath(
  repoDir: string,
  candidate: CandidateAccumulator,
  registryModelId: string | null,
  capabilities: ModelCapabilities | undefined,
): string | null {
  const suiteVersion = capabilities?.nativeCapability?.certification?.certificationSuiteVersion ?? 'v1';
  const modelId = candidate.nativeProviderId ?? registryModelId;
  if (!modelId) {
    return null;
  }
  try {
    return buildGlobalCertificationPath('openrouter', modelId, suiteVersion);
  } catch {
    return null;
  }
}

function isAllowedInOperatingMode(capabilities: ModelCapabilities | undefined, operatingMode: OperatingMode): boolean {
  const allowed = ALLOWED_CLASSES_BY_OPERATING_MODE[operatingMode];
  if (!allowed || !capabilities) {
    return true;
  }
  return allowed.has(capabilities.class);
}

function stagePoolValues(
  repoDir: string,
  stage: OpenRouterDoctorStage,
  fallbackModels: string[],
): string[] {
  const routerConfig = getRouterConfig(repoDir);
  return normalizeList(getAvailableModelsForStage(routerConfig, stage) ?? fallbackModels);
}

function candidateAppearsInPool(candidate: CandidateAccumulator, pool: readonly string[]): boolean {
  if (pool.length === 0) {
    return false;
  }

  const values = new Set([
    candidate.alias,
    candidate.nativeProviderId,
    ...candidate.providerConfiguredValues,
    ...candidate.nativeConfiguredValues,
  ].filter(Boolean));
  return pool.some((entry) => values.has(entry));
}

function filterSpecificProviderModel(
  modelId: string,
  repoDir: string,
  stage: OpenRouterDoctorStage,
): string[] {
  const filtered = filterOpenRouterModels([modelId], repoDir, stage);
  return filtered.models.includes(modelId) ? [] : filtered.warnings;
}

function mapProviderWarningsToReasons(
  warnings: readonly string[],
  providerApiKeyEnv: string,
  stage: OpenRouterDoctorStage,
): OpenRouterDoctorReason[] {
  const reasons: OpenRouterDoctorReason[] = [];
  for (const warning of warnings) {
    if (warning.includes('providers.openrouter.enabled is not true')) {
      appendReason(reasons, buildReason(
        'PROVIDER_DISABLED',
        warning,
        'providers.openrouter.enabled',
        'Set providers.openrouter.enabled to true or remove the OpenRouter alias from routing pools.',
      ));
      continue;
    }

    if (warning.includes('that stage is not enabled')) {
      appendReason(reasons, buildReason(
        'STAGE_NOT_PERMITTED',
        warning,
        'providers.openrouter.stages',
        `Add ${stage} to providers.openrouter.stages or remove the model from ${stage} routing pools.`,
      ));
      continue;
    }

    if (warning.includes('not set')) {
      appendReason(reasons, buildReason(
        'MISSING_API_KEY',
        warning,
        `env:${providerApiKeyEnv}`,
        `Export ${providerApiKeyEnv} or set it in the repo .env file before using OpenRouter models.`,
      ));
      continue;
    }

    if (warning.includes('not allowlisted')) {
      appendReason(reasons, buildReason(
        'STAGE_NOT_PERMITTED',
        warning,
        'providers.openrouter.models',
        'Add the alias to providers.openrouter.models or remove it from router/challenge pools.',
      ));
    }
  }
  return reasons;
}

function mapCertificationRejection(
  candidate: CandidateAccumulator,
  rejection: RouterCertificationRejection,
  storagePath: string | null,
): OpenRouterDoctorReason {
  const configSurface = rejection.reason === 'no-native-capability'
    ? `modelRegistry.models.${rejection.modelId}`
    : 'nativeAgent.providers.openrouter.models';
  const detailParts = [
    `Native certification rejected ${rejection.modelId} for ${rejection.role}.`,
    `reason=${rejection.reason}`,
    `requiredPhase=${rejection.requestedPhase}`,
  ];
  if (rejection.certifiedPhase) {
    detailParts.push(`certifiedPhase=${rejection.certifiedPhase}`);
  }
  if (storagePath) {
    detailParts.push(`artifactPath=${storagePath}`);
  }
  return buildReason(
    'CERTIFICATION_REJECTED',
    detailParts.join(' '),
    configSurface,
    `Refresh the certification artifact for ${candidate.nativeProviderId ?? rejection.modelId} with phase ${STAGE_PHASE_REQUIREMENT[rejection.role]}.`,
  );
}

function resolveAgentFallbackReason(
  modelId: string,
  repoDir: string,
  stage: OpenRouterDoctorStage,
): OpenRouterDoctorReason | null {
  const routerConfig = getRouterConfig(repoDir);
  const explicitAgent = routerConfig.agentMap?.[modelId];

  // An explicit Codex mapping is invalid for an OpenRouter candidate even
  // when the stricter agent resolver rejects it before producing an agent.
  if (explicitAgent === 'codex') {
    return buildReason(
      'AGENT_FALLBACK_TO_CODEX',
      `router.agentMap resolves ${modelId} to codex for ${stage}.`,
      `router.agentMap.${modelId}`,
      `Map ${modelId} to a native OpenRouter agent or remove it from ${stage} routing pools.`,
    );
  }

  const resolution = tryResolveAgent(
    modelId,
    routerConfig.agentMap ?? {},
    (routerConfig.defaultAgent ?? 'claude') as AgentType,
    repoDir,
    DOCTOR_STAGE_BY_AGENT_PHASE[stage],
  );

  if (!resolution.ok) {
    return null;
  }

  if (resolution.agent !== 'codex') {
    return null;
  }

  return buildReason(
    'AGENT_FALLBACK_TO_CODEX',
    `Model ${modelId} resolves to codex for ${stage}.`,
    `modelRegistry.models.${modelId}.agent`,
    `Give ${modelId} an OpenRouter/native mapping instead of codex, or remove it from ${stage} routing pools.`,
  );
}

function evaluateCell(input: {
  repoDir: string;
  stage: OpenRouterDoctorStage;
  candidate: CandidateAccumulator;
  providerEnabled: boolean;
  providerApiKeyEnv: string;
  providerHasApiKey: boolean;
  nativeApiKeyEnv: string;
  nativeHasApiKey: boolean;
  directAgentsEnabled: boolean;
  operatingMode: OperatingMode;
  registry: ReturnType<typeof getEffectiveRegistry>;
  registryModelId: string | null;
  capabilities: ModelCapabilities | undefined;
  storagePath: string | null;
  fallbackModels: string[];
  observedSelections: number;
}): OpenRouterDoctorCell {
  const reasons: OpenRouterDoctorReason[] = [];
  const secondaryReasons: OpenRouterDoctorReason[] = [];
  const stagePool = stagePoolValues(input.repoDir, input.stage, input.fallbackModels);

  if (!candidateAppearsInPool(input.candidate, stagePool)) {
    appendReason(reasons, buildReason(
      'STAGE_NOT_PERMITTED',
      `Model is not present in the effective ${input.stage} pool.`,
      `router.availableModels.${input.stage}`,
      `Add ${input.candidate.alias ?? input.candidate.nativeProviderId ?? input.candidate.key} to the ${input.stage} pool or remove the OpenRouter config entry.`,
    ));
  }

  const providerRawId = [...input.candidate.providerConfiguredValues].find(isRawOpenRouterId);
  if (providerRawId) {
    appendReason(reasons, buildReason(
      'MISSING_REGISTRY_ALIAS',
      `providers.openrouter.models contains raw OpenRouter ID "${providerRawId}" instead of a Wavemill alias.`,
      'providers.openrouter.models',
      `Replace "${providerRawId}" with "${input.candidate.alias ?? providerRawId}".`,
    ));
  }

  if (input.candidate.providerConfiguredValues.size > 0 && input.candidate.alias) {
    const warnings = filterSpecificProviderModel(input.candidate.alias, input.repoDir, input.stage);
    for (const reason of mapProviderWarningsToReasons(warnings, input.providerApiKeyEnv, input.stage)) {
      appendReason(reasons, reason);
    }
  }

  if (!input.directAgentsEnabled && input.candidate.providerConfiguredValues.size > 0) {
    appendReason(secondaryReasons, buildReason(
      'DIRECT_AGENTS_DISABLED',
      `${OPENROUTER_DIRECT_AGENTS_ENV} is not enabled; direct claude-openrouter launches stay disabled.`,
      `env:${OPENROUTER_DIRECT_AGENTS_ENV}`,
      `Export ${OPENROUTER_DIRECT_AGENTS_ENV}=1 only if direct OpenRouter launches are intentionally enabled; otherwise keep the native-openrouter path healthy.`,
    ));
  }

  const needsNativeKey = input.candidate.nativeConfiguredValues.size > 0;
  if (needsNativeKey && !input.nativeHasApiKey) {
    appendReason(reasons, buildReason(
      'MISSING_API_KEY',
      `${input.nativeApiKeyEnv} is not set for native OpenRouter access.`,
      `env:${input.nativeApiKeyEnv}`,
      `Export ${input.nativeApiKeyEnv} or set it in the repo .env file before using native OpenRouter models.`,
    ));
  }

  if (!input.registryModelId || !input.capabilities || !isModelEnabled(input.capabilities)) {
    appendReason(reasons, buildReason(
      'MISSING_REGISTRY_ALIAS',
      `No enabled registry entry could be resolved for alias=${input.candidate.alias ?? 'none'} rawId=${input.candidate.nativeProviderId ?? 'none'}.`,
      'modelRegistry.models',
      'Add a matching modelRegistry entry or fix the alias/raw ID in the config.',
    ));
  } else {
    if (!isAllowedInOperatingMode(input.capabilities, input.operatingMode)) {
      appendReason(reasons, buildReason(
        'OPERATING_MODE_RESTRICTED',
        `Operating mode ${input.operatingMode} excludes model class ${input.capabilities.class}.`,
        '.wavemill/quota-state.json',
        `Wait for quota recovery or remove ${input.registryModelId} from the active ${input.stage} pool.`,
      ));
    }

    const nativeResult = filterNativeModels(
      [input.registryModelId],
      input.stage,
      input.registry,
      input.repoDir,
    );
    if (nativeResult.rejected[0]) {
      appendReason(reasons, mapCertificationRejection(input.candidate, nativeResult.rejected[0], input.storagePath));
    }

    const codexFallbackReason = resolveAgentFallbackReason(input.registryModelId, input.repoDir, input.stage);
    if (codexFallbackReason) {
      appendReason(reasons, codexFallbackReason);
    }
  }

  return {
    stage: input.stage,
    eligible: reasons.length === 0,
    observedSelections: input.observedSelections,
    primaryReason: reasons[0] ?? null,
    secondaryReasons: [...reasons.slice(1), ...secondaryReasons],
  };
}

function summarizeBlockingReasons(models: readonly OpenRouterDoctorModelReport[]): Array<{ reason: OpenRouterDoctorReasonCode; count: number }> {
  const counts = new Map<OpenRouterDoctorReasonCode, number>();
  for (const model of models) {
    for (const cell of model.cells) {
      if (!cell.primaryReason) {
        continue;
      }
      counts.set(cell.primaryReason.reason, (counts.get(cell.primaryReason.reason) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => ({ reason, count }));
}

function calculateObservedSelections(
  entry: { id: string; alias: string | null; nativeProviderId: string | null; registryModelId: string | null },
  stage: OpenRouterDoctorStage,
  recentSelections: readonly RecentSelection[],
  lookback: number,
): number {
  const observed = recentSelections.slice(0, lookback);
  const keys = new Set([entry.id, entry.alias, entry.nativeProviderId, entry.registryModelId].filter(Boolean));
  return observed.filter((selection) => selection.stage === stage && keys.has(selection.model)).length;
}

export function diagnoseOpenRouter(options: DiagnoseOpenRouterOptions = {}): OpenRouterDoctorReport {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const lookback = Number.isInteger(options.lookback) && (options.lookback as number) > 0
    ? options.lookback as number
    : 20;
  const activeStages = options.stage ? [options.stage] : [...OPENROUTER_DOCTOR_STAGES];
  const provider = resolveOpenRouterProviderConfig(repoDir);
  const nativeProviderConfig = getNativeAgentConfig(repoDir).providers?.openrouter;
  const nativeApiKeyEnv = nativeProviderConfig?.apiKeyEnv?.trim() || 'OPENROUTER_API_KEY';
  const nativeHasApiKey = Boolean(resolveEnvValue([nativeApiKeyEnv], repoDir));
  const directAgentsEnabled = isOpenRouterDirectAgentsEnabled();
  const operatingMode = getCurrentOperatingMode(repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const configuredCandidates = collectConfiguredCandidates(repoDir);
  const fallbackModels = normalizeList(
    configuredCandidates.flatMap((candidate) => [
      ...candidate.providerConfiguredValues,
      ...candidate.nativeConfiguredValues,
      candidate.alias ?? '',
      candidate.nativeProviderId ?? '',
    ]),
  );
  const recentSelections = collectRecentSelections({ repoDir });

  const models: OpenRouterDoctorModelReport[] = configuredCandidates.map((candidate) => {
    const registryModelId = resolveRegistryModelId(candidate, registry);
    const capabilities = registryModelId ? getModel(registry, registryModelId) : undefined;
    const storagePath = resolveStoragePath(repoDir, candidate, registryModelId, capabilities);
    const id = candidate.alias ?? candidate.nativeProviderId ?? candidate.key;

    const cells = activeStages.map((stage) => evaluateCell({
      repoDir,
      stage,
      candidate,
      providerEnabled: provider.enabled,
      providerApiKeyEnv: provider.apiKeyEnv,
      providerHasApiKey: provider.hasApiKey,
      nativeApiKeyEnv,
      nativeHasApiKey,
      directAgentsEnabled,
      operatingMode,
      registry,
      registryModelId,
      capabilities,
      storagePath,
      fallbackModels,
      observedSelections: calculateObservedSelections(
        { id, alias: candidate.alias, nativeProviderId: candidate.nativeProviderId, registryModelId },
        stage,
        recentSelections,
        lookback,
      ),
    }));

    return {
      id,
      alias: candidate.alias,
      nativeProviderId: candidate.nativeProviderId,
      registryModelId,
      storagePath,
      configSurfaces: [...candidate.configSurfaces].sort(),
      eligibleStages: cells.filter((cell) => cell.eligible).map((cell) => cell.stage),
      cells,
    };
  });

  const eligibleCellCount = models.reduce((sum, model) => sum + model.cells.filter((cell) => cell.eligible).length, 0);
  const eligibleModelCount = models.filter((model) => model.eligibleStages.length > 0).length;
  const routerPoolEligibleCounts = Object.fromEntries(
    OPENROUTER_DOCTOR_STAGES.map((stage) => [
      stage,
      models.filter((model) => model.cells.some((cell) => cell.stage === stage && cell.eligible)).length,
    ]),
  ) as Record<OpenRouterDoctorStage, number>;
  const challengePoolEligibleCounts = Object.fromEntries(
    OPENROUTER_DOCTOR_STAGES.map((stage) => [
      CHALLENGE_STAGE_BY_DOCTOR_STAGE[stage],
      models.filter((model) => model.cells.some((cell) => cell.stage === stage && cell.eligible)).length,
    ]),
  ) as Record<'plan' | 'implementation' | 'review', number>;
  const zeroTrafficCells = models.flatMap((model) =>
    model.cells
      .filter((cell) => cell.observedSelections === 0)
      .map((cell) => ({
        modelId: model.id,
        stage: cell.stage,
        observedSelections: cell.observedSelections,
      }))
  );

  const summary: OpenRouterDoctorSummary = {
    configuredModelCount: models.length,
    eligibleCellCount,
    eligibleModelCount,
    operatingMode,
    providerEnabled: provider.enabled,
    providerApiKeyEnv: provider.apiKeyEnv,
    providerHasApiKey: provider.hasApiKey,
    nativeApiKeyEnv,
    nativeHasApiKey,
    directAgentsEnabled,
    observedSelectionCount: recentSelections.slice(0, lookback).length,
    routerPoolEligibleCounts,
    challengePoolEligibleCounts,
    topBlockingReasons: summarizeBlockingReasons(models),
  };

  const report: OpenRouterDoctorReport = {
    repoDir,
    generatedAt: new Date().toISOString(),
    lookback,
    models,
    recentSelections,
    zeroTrafficCells,
    zeroTrafficAlert: null,
    zeroTrafficAlertText: null,
    summary,
  };

  const zeroTrafficAlert = detectZeroTraffic({
    repoDir,
    report,
    lookback,
    recentSelections,
  });

  report.zeroTrafficAlert = zeroTrafficAlert;
  report.zeroTrafficAlertText = zeroTrafficAlert ? renderZeroTrafficAlert(zeroTrafficAlert) : null;
  return report;
}

function formatStageCell(cell: OpenRouterDoctorCell): string {
  const status = cell.eligible ? 'eligible' : `blocked ${cell.primaryReason?.reason ?? 'UNKNOWN'}`;
  const reasons = [
    cell.primaryReason?.detail,
    ...cell.secondaryReasons.map((reason) => `${reason.reason}: ${reason.detail}`),
  ].filter(Boolean);
  const suffix = reasons.length > 0 ? ` — ${reasons.join(' | ')}` : '';
  return `  ${cell.stage}: ${status}; observed=${cell.observedSelections}${suffix}`;
}

export function renderOpenRouterDoctorReport(report: OpenRouterDoctorReport): string {
  const lines = [
    `OpenRouter doctor (${report.repoDir})`,
    `provider.enabled=${report.summary.providerEnabled} apiKey=${report.summary.providerHasApiKey ? 'present' : `missing:${report.summary.providerApiKeyEnv}`} directAgents=${report.summary.directAgentsEnabled} operatingMode=${report.summary.operatingMode}`,
    `configured=${report.summary.configuredModelCount} eligibleModels=${report.summary.eligibleModelCount} eligibleCells=${report.summary.eligibleCellCount} observedSelections=${report.summary.observedSelectionCount}`,
  ];

  for (const model of report.models) {
    lines.push(`- ${model.id} (alias=${model.alias ?? 'none'} raw=${model.nativeProviderId ?? 'none'} registry=${model.registryModelId ?? 'none'})`);
    if (model.storagePath) {
      lines.push(`  storage=${model.storagePath}`);
    }
    for (const cell of model.cells) {
      lines.push(formatStageCell(cell));
    }
  }

  if (report.zeroTrafficAlertText) {
    lines.push('');
    lines.push(report.zeroTrafficAlertText);
  }

  return lines.join('\n');
}
