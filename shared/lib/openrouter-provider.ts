import {
  getOpenRouterProviderConfig,
  type DeepSeekProviderStage,
} from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import {
  loadLaunchPriorityList,
  resolveOpenRouterModelIdentity,
} from './openrouter-catalog.ts';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const OPENROUTER_DEFAULT_STAGES = ['planner', 'coder', 'reviewer'] as const satisfies readonly DeepSeekProviderStage[];
export const OPENROUTER_DIRECT_AGENTS_ENABLED = false;
export const OPENROUTER_DIRECT_AGENTS_ENV = 'OPENROUTER_DIRECT_AGENTS_ENABLED';

export interface ResolvedOpenRouterProviderConfig {
  enabled: boolean;
  apiKeyEnv: string;
  baseUrl: string;
  models: string[];
  stages: DeepSeekProviderStage[];
  hasApiKey: boolean;
  directAgentsEnabled: boolean;
}

export interface OpenRouterPoolFilterResult {
  models: string[];
  warnings: string[];
}

function normalizeModels(): string[] {
  const fixtureAliases = loadLaunchPriorityList().map((entry) => entry.wavemillAlias);
  return [...new Set(
    fixtureAliases
      .map((modelId) => resolveOpenRouterModelIdentity(modelId))
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity?.nativeOpenRouter))
      .map((identity) => identity.wavemillAlias),
  )];
}

function normalizeStages(stages?: DeepSeekProviderStage[]): DeepSeekProviderStage[] {
  const candidates = stages && stages.length > 0 ? stages : [...OPENROUTER_DEFAULT_STAGES];
  return [...new Set(candidates)];
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

export function isOpenRouterDirectAgentsEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const configured = env[OPENROUTER_DIRECT_AGENTS_ENV];
  if (typeof configured === 'undefined') {
    return OPENROUTER_DIRECT_AGENTS_ENABLED;
  }
  return isTruthyEnvValue(configured);
}

export function isOpenRouterModel(modelId: string | null | undefined): boolean {
  return resolveOpenRouterModelIdentity(modelId)?.nativeOpenRouter === true;
}

export function resolveOpenRouterModelId(modelId: string | null | undefined): string | null {
  const identity = resolveOpenRouterModelIdentity(modelId);
  return identity?.nativeOpenRouter ? identity.openrouterId : null;
}

export function resolveOpenRouterProviderConfig(repoDir?: string): ResolvedOpenRouterProviderConfig {
  const config = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = config.apiKeyEnv?.trim() || 'OPENROUTER_API_KEY';
  const hasApiKey = Boolean(resolveEnvValue([apiKeyEnv], repoDir));

  return {
    enabled: config.enabled === true,
    apiKeyEnv,
    baseUrl: config.baseUrl?.trim() || OPENROUTER_BASE_URL,
    models: normalizeModels(),
    stages: normalizeStages(),
    hasApiKey,
    directAgentsEnabled: isOpenRouterDirectAgentsEnabled(),
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

  if (!provider.hasApiKey) {
    return {
      models: requested.filter((modelId) => !isOpenRouterModel(modelId)),
      warnings: [`OpenRouter models were ignored because ${provider.apiKeyEnv} is not set.`],
    };
  }

  return { models: requested, warnings: [] };
}

export function getOpenRouterProviderMetadata(
  modelId: string | null | undefined,
  repoDir?: string,
): { provider: 'openrouter'; endpoint: string; openrouterId: string; wavemillAlias: string | null } | null {
  if (!isOpenRouterModel(modelId)) {
    return null;
  }

  const provider = resolveOpenRouterProviderConfig(repoDir);
  const identity = resolveOpenRouterModelIdentity(modelId);
  return identity?.nativeOpenRouter
    ? {
      provider: 'openrouter',
      endpoint: provider.baseUrl,
      openrouterId: identity.openrouterId,
      wavemillAlias: identity.wavemillAlias,
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
