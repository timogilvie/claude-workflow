import {
  loadWavemillConfig,
} from './config.ts';
import { listEffectiveModelsForStage } from './effective-models.ts';
import { getEffectiveRegistry, getModel } from './model-registry.ts';
import {
  OPENROUTER_DEFAULT_API_KEY_ENV,
  OPENROUTER_DEFAULT_BASE_URL,
} from './native-agent/providers.ts';
import {
  resolveOpenRouterModelIdentity,
  type OpenRouterModelIdentity,
  type RoleEligibility,
} from './openrouter-catalog.ts';

export type NativeLaunchPhase = RoleEligibility;

export type NativeOpenRouterConfigBlockerCode =
  | 'unknown-openrouter-model'
  | 'provider-disabled'
  | 'native-provider-disabled'
  | 'global-projection-missing'
  | 'registry-provider-mismatch';

export interface NativeOpenRouterConfigBlocker {
  code: NativeOpenRouterConfigBlockerCode;
  surface: string;
  detail: string;
  remediation: string;
}

export interface NativeOpenRouterCommandMetadata {
  agent: 'native-openrouter';
  provider: 'openrouter';
  wavemillAlias: string;
  openrouterId: string;
  providerName: string;
  providerModel: string;
  commandModel: string;
  apiBaseUrl: string;
  apiKeyEnv: string;
}

export interface NativeOpenRouterConfigValidation {
  ok: boolean;
  identity?: OpenRouterModelIdentity;
  command?: NativeOpenRouterCommandMetadata;
  blockers: NativeOpenRouterConfigBlocker[];
}

const PHASE_TO_EFFECTIVE_STAGE: Record<NativeLaunchPhase, 'planning' | 'coding' | 'review'> = {
  planning: 'planning',
  coding: 'coding',
  review: 'review',
};

function formatModelPair(identity: OpenRouterModelIdentity): string {
  return `${identity.wavemillAlias} (${identity.openrouterId})`;
}

function buildCommandMetadata(config: ReturnType<typeof loadWavemillConfig>, identity: OpenRouterModelIdentity): NativeOpenRouterCommandMetadata {
  const providerConfig = config.nativeAgent?.providers?.openrouter ?? config.providers?.openrouter;
  return {
    agent: 'native-openrouter',
    provider: 'openrouter',
    wavemillAlias: identity.wavemillAlias,
    openrouterId: identity.openrouterId,
    providerName: identity.provider,
    providerModel: identity.providerModel,
    commandModel: identity.openrouterId,
    apiBaseUrl: providerConfig?.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL,
    apiKeyEnv: providerConfig?.apiKeyEnv?.trim() || OPENROUTER_DEFAULT_API_KEY_ENV,
  };
}

export function validateNativeOpenRouterConfig(input: {
  repoDir?: string;
  model: string;
  phase: NativeLaunchPhase;
}): NativeOpenRouterConfigValidation {
  const config = loadWavemillConfig(input.repoDir);
  const identity = resolveOpenRouterModelIdentity(input.model);
  const blockers: NativeOpenRouterConfigBlocker[] = [];

  if (!identity?.nativeOpenRouter) {
    return {
      ok: false,
      blockers: [{
        code: 'unknown-openrouter-model',
        surface: 'launch.model',
        detail: `Unknown native OpenRouter model "${input.model}".`,
        remediation: 'Use a launch-priority wavemill alias or OpenRouter ID such as qwen-3-coder or qwen/qwen3-coder.',
      }],
    };
  }

  const providerConfig = config.providers?.openrouter;
  if (providerConfig) {
    if (providerConfig.enabled !== true) {
      blockers.push({
        code: 'provider-disabled',
        surface: 'providers.openrouter.enabled',
        detail: `providers.openrouter is disabled for ${formatModelPair(identity)}.`,
        remediation: 'Set providers.openrouter.enabled to true or remove the model from OpenRouter route pools.',
      });
    }
  }

  const nativeProviderConfig = config.nativeAgent?.providers?.openrouter;
  if (nativeProviderConfig) {
    if (nativeProviderConfig.enabled === false) {
      blockers.push({
        code: 'native-provider-disabled',
        surface: 'nativeAgent.providers.openrouter.enabled',
        detail: `nativeAgent.providers.openrouter is disabled for ${formatModelPair(identity)}.`,
        remediation: 'Enable nativeAgent.providers.openrouter or route this model to a non-native agent.',
      });
    }
  }

  const effectiveModels = listEffectiveModelsForStage(PHASE_TO_EFFECTIVE_STAGE[input.phase], { repoDir: input.repoDir }).models;
  if (!effectiveModels.includes(identity.wavemillAlias) && !effectiveModels.includes(identity.openrouterId)) {
    blockers.push({
      code: 'global-projection-missing',
      surface: `globalEffectiveModels.${input.phase}`,
      detail: `Global effective-model projection for ${input.phase} does not include ${formatModelPair(identity)}.`,
      remediation: 'Add the model to the global v2 certification catalog/effective-model projection before routing it through native OpenRouter.',
    });
  }

  const registry = getEffectiveRegistry(input.repoDir);
  const capabilities = getModel(registry, identity.wavemillAlias) ?? getModel(registry, identity.openrouterId);
  const nativeProvider = capabilities?.nativeCapability?.nativeProvider;
  if (nativeProvider && nativeProvider !== 'openrouter') {
    blockers.push({
      code: 'registry-provider-mismatch',
      surface: `globalModelRegistry.models.${identity.wavemillAlias}.nativeCapability.nativeProvider`,
      detail: `global model registry maps ${formatModelPair(identity)} to native provider ${nativeProvider}, expected openrouter.`,
      remediation: 'Update the global v2 certification catalog/effective-model projection or remove the model from native-openrouter routes.',
    });
  }

  const command = buildCommandMetadata(config, identity);
  return {
    ok: blockers.length === 0,
    identity,
    command,
    blockers,
  };
}
