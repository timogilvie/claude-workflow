import {
  getDeepSeekProviderConfig,
  getDeepSeekConfig,
  type DeepSeekProviderConfig,
  type DeepSeekProviderStage,
} from './config.ts';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_PRIMARY_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const;
export const DEEPSEEK_COMPAT_MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const;
export const DEEPSEEK_MODEL_IDS = [
  ...DEEPSEEK_PRIMARY_MODELS,
  ...DEEPSEEK_COMPAT_MODELS,
] as const;
export const DEEPSEEK_DEFAULT_STAGES = ['planner', 'coder', 'reviewer'] as const satisfies readonly DeepSeekProviderStage[];

export interface ResolvedDeepSeekProviderConfig {
  enabled: boolean;
  apiKeyEnv: string;
  baseUrl: string;
  models: string[];
  stages: DeepSeekProviderStage[];
  effortLevel: 'low' | 'medium' | 'high';
  hasApiKey: boolean;
}

export interface DeepSeekPoolFilterResult {
  models: string[];
  warnings: string[];
}

export function isDeepSeekModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith('deepseek-');
}

function normalizeModels(models?: string[]): string[] {
  const candidates = models && models.length > 0 ? models : [...DEEPSEEK_MODEL_IDS];
  return [...new Set(candidates.filter((modelId) => isDeepSeekModel(modelId)))];
}

function normalizeStages(stages?: DeepSeekProviderStage[]): DeepSeekProviderStage[] {
  const candidates = stages && stages.length > 0 ? stages : [...DEEPSEEK_DEFAULT_STAGES];
  return [...new Set(candidates)];
}

function normalizeEffortLevel(
  value: DeepSeekProviderConfig['effortLevel'],
): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'high' ? value : 'medium';
}

export function resolveDeepSeekProviderConfig(repoDir?: string): ResolvedDeepSeekProviderConfig {
  const config = getDeepSeekProviderConfig(repoDir);
  const apiKeyEnv = config.apiKeyEnv?.trim() || 'DEEPSEEK_API_KEY';
  const hasApiKey = (process.env[apiKeyEnv] || '').trim().length > 0;

  return {
    enabled: config.enabled === true,
    apiKeyEnv,
    baseUrl: config.baseUrl?.trim() || DEEPSEEK_BASE_URL,
    models: normalizeModels(config.models),
    stages: normalizeStages(config.stages),
    effortLevel: normalizeEffortLevel(config.effortLevel),
    hasApiKey,
  };
}

export function filterDeepSeekModels(
  models: readonly string[],
  repoDir?: string,
  stage?: DeepSeekProviderStage,
): DeepSeekPoolFilterResult {
  const requested = [...new Set(models)];
  const deepSeekRequested = requested.filter((modelId) => isDeepSeekModel(modelId));
  if (deepSeekRequested.length === 0) {
    return { models: requested, warnings: [] };
  }

  const provider = resolveDeepSeekProviderConfig(repoDir);
  if (!provider.enabled) {
    return {
      models: requested.filter((modelId) => !isDeepSeekModel(modelId)),
      warnings: ['DeepSeek models were ignored because providers.deepseek.enabled is not true.'],
    };
  }

  if (stage && !provider.stages.includes(stage)) {
    return {
      models: requested.filter((modelId) => !isDeepSeekModel(modelId)),
      warnings: [`DeepSeek models were ignored for ${stage} because that stage is not enabled in providers.deepseek.stages.`],
    };
  }

  if (!provider.hasApiKey) {
    return {
      models: requested.filter((modelId) => !isDeepSeekModel(modelId)),
      warnings: [`DeepSeek models were ignored because ${provider.apiKeyEnv} is not set.`],
    };
  }

  const allowedModels = new Set(provider.models);
  const filtered = requested.filter((modelId) => !isDeepSeekModel(modelId) || allowedModels.has(modelId));
  const skippedConfiguredModels = deepSeekRequested.filter((modelId) => !allowedModels.has(modelId));

  return {
    models: filtered,
    warnings: skippedConfiguredModels.length > 0
      ? [`DeepSeek models were ignored because they are not allowlisted in providers.deepseek.models: ${skippedConfiguredModels.join(', ')}`]
      : [],
  };
}

/**
 * Filter DeepSeek models for unattended routing contexts (mill/challenge).
 *
 * This is an additional gate on top of provider-level filtering.
 * Manual launches and smoke tests are unaffected.
 *
 * @param models - Model IDs to filter
 * @param repoDir - Repository directory for config resolution
 * @returns Filtered models and warnings
 */
export function filterDeepSeekForUnattended(
  models: readonly string[],
  repoDir?: string,
): DeepSeekPoolFilterResult {
  const requested = [...new Set(models)];
  const deepSeekRequested = requested.filter((modelId) => isDeepSeekModel(modelId));

  if (deepSeekRequested.length === 0) {
    return { models: requested, warnings: [] };
  }

  const config = getDeepSeekConfig(repoDir);
  if (!config.unattendedEnabled) {
    return {
      models: requested.filter((modelId) => !isDeepSeekModel(modelId)),
      warnings: ['DeepSeek models were excluded from unattended routing because deepseek.unattendedEnabled is not true.'],
    };
  }

  return { models: requested, warnings: [] };
}

export function getDeepSeekProviderMetadata(
  modelId: string | null | undefined,
  repoDir?: string,
): { provider: 'deepseek'; endpoint: string } | null {
  if (!isDeepSeekModel(modelId)) {
    return null;
  }

  const provider = resolveDeepSeekProviderConfig(repoDir);
  return {
    provider: 'deepseek',
    endpoint: provider.baseUrl,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const repoDir = process.argv[3] || process.cwd();
  const stage = process.argv[4] as DeepSeekProviderStage | undefined;

  if (command === 'config-json') {
    console.log(JSON.stringify(resolveDeepSeekProviderConfig(repoDir)));
    process.exit(0);
  }

  if (command === 'filter-json') {
    const models = process.argv.slice(5);
    console.log(JSON.stringify(filterDeepSeekModels(models, repoDir, stage)));
    process.exit(0);
  }

  console.error('Usage: npx tsx shared/lib/deepseek-provider.ts <config-json|filter-json> [repo-dir] [stage] [models...]');
  process.exit(1);
}
