import {
  getOpenRouterProviderConfig,
  type DeepSeekProviderStage,
} from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import {
  loadLaunchPriorityList,
  resolveWavemillAliasFromOpenRouterId,
} from './openrouter-catalog.ts';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const OPENROUTER_DEFAULT_STAGES = ['planner', 'coder', 'reviewer'] as const satisfies readonly DeepSeekProviderStage[];
export const OPENROUTER_DIRECT_AGENTS_ENABLED = false;

export interface ResolvedOpenRouterProviderConfig {
  enabled: boolean;
  apiKeyEnv: string;
  baseUrl: string;
  models: string[];
  stages: DeepSeekProviderStage[];
  hasApiKey: boolean;
}

export interface OpenRouterPoolFilterResult {
  models: string[];
  warnings: string[];
}

let launchPriorityByAliasCache: Map<string, { openrouterId: string; family: string }> | null = null;

function getLaunchPriorityByAlias(): Map<string, { openrouterId: string; family: string }> {
  if (!launchPriorityByAliasCache) {
    launchPriorityByAliasCache = new Map(
      loadLaunchPriorityList().map((entry) => [
        entry.wavemillAlias,
        { openrouterId: entry.openrouterId, family: entry.family },
      ]),
    );
  }
  return launchPriorityByAliasCache;
}

function normalizeModels(models?: string[]): string[] {
  const fixtureAliases = loadLaunchPriorityList().map((entry) => entry.wavemillAlias);
  const candidates = models && models.length > 0 ? models : fixtureAliases;
  return [...new Set(candidates.filter((modelId) => isOpenRouterModel(modelId)))];
}

function normalizeStages(stages?: DeepSeekProviderStage[]): DeepSeekProviderStage[] {
  const candidates = stages && stages.length > 0 ? stages : [...OPENROUTER_DEFAULT_STAGES];
  return [...new Set(candidates)];
}

export function isOpenRouterModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return false;
  }

  const entry = getLaunchPriorityByAlias().get(modelId);
  if (!entry?.openrouterId) {
    return false;
  }

  return !(
    entry.openrouterId.startsWith('anthropic/')
    || entry.openrouterId.startsWith('openai/')
    || entry.openrouterId.startsWith('deepseek/')
  );
}

export function resolveOpenRouterModelId(modelId: string | null | undefined): string | null {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return null;
  }
  return getLaunchPriorityByAlias().get(modelId)?.openrouterId ?? null;
}

export function resolveOpenRouterProviderConfig(repoDir?: string): ResolvedOpenRouterProviderConfig {
  const config = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = config.apiKeyEnv?.trim() || 'OPENROUTER_API_KEY';
  const hasApiKey = Boolean(resolveEnvValue([apiKeyEnv], repoDir));

  return {
    enabled: config.enabled === true,
    apiKeyEnv,
    baseUrl: config.baseUrl?.trim() || OPENROUTER_BASE_URL,
    models: normalizeModels(config.models),
    stages: normalizeStages(config.stages),
    hasApiKey,
  };
}

export function filterOpenRouterModels(
  models: readonly string[],
  repoDir?: string,
  stage?: DeepSeekProviderStage,
): OpenRouterPoolFilterResult {
  const requested = [...new Set(models)];
  const openRouterRequested = requested.filter((modelId) => isOpenRouterModel(modelId));
  if (openRouterRequested.length === 0) {
    return { models: requested, warnings: [] };
  }

  const provider = resolveOpenRouterProviderConfig(repoDir);
  if (!provider.enabled) {
    return {
      models: requested.filter((modelId) => !isOpenRouterModel(modelId)),
      warnings: ['OpenRouter models were ignored because providers.openrouter.enabled is not true.'],
    };
  }

  if (stage && !provider.stages.includes(stage)) {
    return {
      models: requested.filter((modelId) => !isOpenRouterModel(modelId)),
      warnings: [`OpenRouter models were ignored for ${stage} because that stage is not enabled in providers.openrouter.stages.`],
    };
  }

  if (!provider.hasApiKey) {
    return {
      models: requested.filter((modelId) => !isOpenRouterModel(modelId)),
      warnings: [`OpenRouter models were ignored because ${provider.apiKeyEnv} is not set.`],
    };
  }

  const allowedModels = new Set(provider.models);
  const filtered = requested.filter((modelId) => !isOpenRouterModel(modelId) || allowedModels.has(modelId));
  const skippedConfiguredModels = openRouterRequested.filter((modelId) => !allowedModels.has(modelId));

  return {
    models: filtered,
    warnings: skippedConfiguredModels.length > 0
      ? [`OpenRouter models were ignored because they are not allowlisted in providers.openrouter.models: ${skippedConfiguredModels.join(', ')}`]
      : [],
  };
}

export function getOpenRouterProviderMetadata(
  modelId: string | null | undefined,
  repoDir?: string,
): { provider: 'openrouter'; endpoint: string; openrouterId: string; wavemillAlias: string | null } | null {
  if (!isOpenRouterModel(modelId)) {
    return null;
  }

  const provider = resolveOpenRouterProviderConfig(repoDir);
  const openrouterId = resolveOpenRouterModelId(modelId);
  return openrouterId
    ? {
      provider: 'openrouter',
      endpoint: provider.baseUrl,
      openrouterId,
      wavemillAlias: resolveWavemillAliasFromOpenRouterId(openrouterId),
    }
    : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const repoDir = process.argv[3] || process.cwd();
  const stage = process.argv[4] as DeepSeekProviderStage | undefined;

  if (command === 'config-json') {
    console.log(JSON.stringify(resolveOpenRouterProviderConfig(repoDir)));
    process.exit(0);
  }

  if (command === 'filter-json') {
    const models = process.argv.slice(5);
    console.log(JSON.stringify(filterOpenRouterModels(models, repoDir, stage)));
    process.exit(0);
  }

  console.error('Usage: npx tsx shared/lib/openrouter-provider.ts <config-json|filter-json> [repo-dir] [stage] [models...]');
  process.exit(1);
}
