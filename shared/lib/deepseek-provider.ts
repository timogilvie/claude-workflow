import {
  getDeepSeekProviderConfig,
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
    stages: normalizeStages(),
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
  if (!requested.some((modelId) => isDeepSeekModel(modelId))) {
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
      warnings: [`DeepSeek models were ignored for ${stage} because the global provider stage policy does not enable that stage.`],
    };
  }

  if (!provider.hasApiKey) {
    return {
      models: requested.filter((modelId) => !isDeepSeekModel(modelId)),
      warnings: [`DeepSeek models were ignored because ${provider.apiKeyEnv} is not set.`],
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
