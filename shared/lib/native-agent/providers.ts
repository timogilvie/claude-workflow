import {
  getRegisteredPiApiProvider,
  type Model,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
} from './provider.ts';
import type {
  NativeAgentConfig,
  NativeAgentModelConfig,
  NativeAgentProviderApi,
  NativeAgentProviderConfig,
  NativeAgentProvidersConfig,
} from '../config.ts';

export type LiveProviderName = keyof NativeAgentProvidersConfig;
export type LiveProviderModel = Model<'openai-completions'> | Model<'openai-responses'>;
export type LiveProviderUnavailableReason = 'disabled' | 'missing_key';

export interface LiveProviderUnavailable {
  provider: LiveProviderName;
  reason: LiveProviderUnavailableReason;
  envVar?: string;
}

export interface LiveProviderResolution {
  available: LiveProviderModel[];
  unavailable: LiveProviderUnavailable[];
}

export const LIVE_PROVIDER_DEFAULTS: Record<LiveProviderName, {
  provider: LiveProviderName;
  apiKeyEnv: string;
  baseUrl: string;
}> = {
  openai: {
    provider: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
  },
  openrouter: {
    provider: 'openrouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
};

export function resolveLiveProviderModels(
  config: NativeAgentConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LiveProviderResolution {
  if (!config?.providers) {
    return { available: [], unavailable: [] };
  }

  const available: LiveProviderModel[] = [];
  const unavailable: LiveProviderUnavailable[] = [];

  for (const provider of Object.keys(config.providers) as LiveProviderName[]) {
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      continue;
    }

    if (providerConfig.enabled !== true) {
      unavailable.push({ provider, reason: 'disabled' });
      continue;
    }

    const envVar = providerConfig.apiKeyEnv?.trim() || LIVE_PROVIDER_DEFAULTS[provider].apiKeyEnv;
    if (!env[envVar]?.trim()) {
      unavailable.push({ provider, reason: 'missing_key', envVar });
      continue;
    }

    const baseUrl = providerConfig.baseUrl?.trim() || LIVE_PROVIDER_DEFAULTS[provider].baseUrl;
    for (const modelConfig of providerConfig.models ?? []) {
      available.push(buildLiveProviderModel(provider, providerConfig, modelConfig, baseUrl));
    }
  }

  return { available, unavailable };
}

export function verifyProviderDispatch(api: NativeAgentProviderApi) {
  const provider = getRegisteredPiApiProvider(api);
  if (!provider) {
    throw new Error(`Pi API provider not registered for ${api}`);
  }
  return provider;
}

function buildLiveProviderModel(
  provider: LiveProviderName,
  providerConfig: NativeAgentProviderConfig,
  modelConfig: NativeAgentModelConfig,
  baseUrl: string,
): LiveProviderModel {
  const baseModel = {
    id: modelConfig.id,
    name: modelConfig.name ?? modelConfig.id,
    provider,
    api: modelConfig.api,
    baseUrl,
    headers: providerConfig.headers,
    reasoning: modelConfig.reasoning ?? false,
    input: modelConfig.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelConfig.contextWindow ?? 200000,
    maxTokens: modelConfig.maxTokens ?? 8192,
  } as const;

  switch (modelConfig.api) {
    case 'openai-completions':
      return {
        ...baseModel,
        api: 'openai-completions',
        compat: modelConfig.compat as OpenAICompletionsCompat | undefined,
      };
    case 'openai-responses':
      return {
        ...baseModel,
        api: 'openai-responses',
        compat: modelConfig.compat as OpenAIResponsesCompat | undefined,
      };
    default:
      throw new Error(`Unsupported live provider api: ${String(modelConfig.api)}`);
  }
}
