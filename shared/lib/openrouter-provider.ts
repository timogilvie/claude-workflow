import {
  getOpenRouterProviderConfig,
  type DeepSeekProviderStage,
} from './config.ts';
import { loadLaunchPriorityList } from './openrouter-catalog.ts';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_STAGES = ['planner', 'coder', 'reviewer'] as const satisfies readonly DeepSeekProviderStage[];

export interface ResolvedOpenRouterProviderConfig {
  enabled: boolean;
  apiKeyEnv: string;
  baseUrl: string;
  models: string[];
  stages: DeepSeekProviderStage[];
  effortLevel: 'low' | 'medium' | 'high';
  hasApiKey: boolean;
}

const OPENROUTER_MODELS = loadLaunchPriorityList()
  .filter((model) => model.family !== 'claude' && model.status !== 'deprecated')
  .map((model) => ({
    wavemillAlias: model.wavemillAlias,
    openrouterId: model.openrouterId,
  }));

const OPENROUTER_MODEL_ALIASES = new Set(OPENROUTER_MODELS.map((model) => model.wavemillAlias));
const OPENROUTER_MODEL_IDS_BY_ALIAS = new Map(
  OPENROUTER_MODELS.map((model) => [model.wavemillAlias, model.openrouterId] as const),
);

export function isOpenRouterModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && OPENROUTER_MODEL_ALIASES.has(modelId);
}

export function openrouterIdForModel(wavemillAlias: string): string | null {
  return OPENROUTER_MODEL_IDS_BY_ALIAS.get(wavemillAlias) ?? null;
}

function normalizeModels(models?: string[]): string[] {
  const candidates = models && models.length > 0
    ? models
    : [...OPENROUTER_MODEL_ALIASES];
  return [...new Set(candidates.filter((modelId) => isOpenRouterModel(modelId)))];
}

function normalizeStages(stages?: DeepSeekProviderStage[]): DeepSeekProviderStage[] {
  const candidates = stages && stages.length > 0 ? stages : [...OPENROUTER_DEFAULT_STAGES];
  return [...new Set(candidates)];
}

function normalizeEffortLevel(value: 'low' | 'medium' | 'high' | undefined): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'high' ? value : 'medium';
}

export function resolveOpenRouterProviderConfig(repoDir?: string): ResolvedOpenRouterProviderConfig {
  const config = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = config.apiKeyEnv?.trim() || 'OPENROUTER_API_KEY';
  const hasApiKey = (process.env[apiKeyEnv] || '').trim().length > 0;

  return {
    enabled: config.enabled === true,
    apiKeyEnv,
    baseUrl: config.baseUrl?.trim() || OPENROUTER_BASE_URL,
    models: normalizeModels(config.models),
    stages: normalizeStages(config.stages),
    effortLevel: normalizeEffortLevel(config.effortLevel),
    hasApiKey,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const repoDir = process.argv[3] || process.cwd();

  if (command === 'config-json') {
    console.log(JSON.stringify(resolveOpenRouterProviderConfig(repoDir)));
    process.exit(0);
  }

  console.error('Usage: npx tsx shared/lib/openrouter-provider.ts <config-json> [repo-dir]');
  process.exit(1);
}
