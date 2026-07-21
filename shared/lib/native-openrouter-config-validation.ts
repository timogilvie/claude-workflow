import {
  loadWavemillConfig,
  type DeepSeekProviderStage,
} from './config.ts';
import { getEffectiveRegistry, getModel, type AgentType } from './model-registry.ts';
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
  | 'provider-stage-mismatch'
  | 'provider-model-mismatch'
  | 'native-provider-disabled'
  | 'native-provider-model-mismatch'
  | 'agent-map-mismatch'
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

const PHASE_TO_PROVIDER_STAGE: Record<NativeLaunchPhase, DeepSeekProviderStage> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

const NATIVE_OPENROUTER_AGENTS = new Set<AgentType>(['native-openrouter', 'claude-openrouter']);

function includesEquivalentModel(values: readonly string[] | undefined, identity: OpenRouterModelIdentity): boolean {
  if (!values || values.length === 0) {
    return true;
  }
  const accepted = new Set(identity.equivalentIds);
  return values.some((value) => accepted.has(value.trim()));
}

function formatModelPair(identity: OpenRouterModelIdentity): string {
  return `${identity.wavemillAlias} (${identity.openrouterId})`;
}

function firstMappedAgent(
  agentMap: Record<string, AgentType> | undefined,
  identity: OpenRouterModelIdentity,
): { key: string; agent: AgentType } | null {
  if (!agentMap) {
    return null;
  }
  for (const key of identity.equivalentIds) {
    const agent = agentMap[key];
    if (agent) {
      return { key, agent };
    }
  }
  return null;
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
  const providerStage = PHASE_TO_PROVIDER_STAGE[input.phase];
  if (providerConfig) {
    if (providerConfig.enabled !== true) {
      blockers.push({
        code: 'provider-disabled',
        surface: 'providers.openrouter.enabled',
        detail: `providers.openrouter is disabled for ${formatModelPair(identity)}.`,
        remediation: 'Set providers.openrouter.enabled to true or remove the model from OpenRouter route pools.',
      });
    }
    if (providerConfig.stages && providerConfig.stages.length > 0 && !providerConfig.stages.includes(providerStage)) {
      blockers.push({
        code: 'provider-stage-mismatch',
        surface: 'providers.openrouter.stages',
        detail: `providers.openrouter.stages does not include ${providerStage} for ${formatModelPair(identity)}.`,
        remediation: `Add ${providerStage} to providers.openrouter.stages or remove the model from ${input.phase} routing pools.`,
      });
    }
    if (!includesEquivalentModel(providerConfig.models, identity)) {
      blockers.push({
        code: 'provider-model-mismatch',
        surface: 'providers.openrouter.models',
        detail: `providers.openrouter.models does not include ${formatModelPair(identity)}.`,
        remediation: `Add either ${identity.wavemillAlias} or ${identity.openrouterId} to providers.openrouter.models.`,
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
    if (!includesEquivalentModel(nativeProviderConfig.models, identity)) {
      blockers.push({
        code: 'native-provider-model-mismatch',
        surface: 'nativeAgent.providers.openrouter.models',
        detail: `nativeAgent.providers.openrouter.models does not include ${formatModelPair(identity)}.`,
        remediation: `Add either ${identity.wavemillAlias} or ${identity.openrouterId} to nativeAgent.providers.openrouter.models.`,
      });
    }
  }

  const mappedAgent = firstMappedAgent(config.router?.agentMap, identity);
  if (mappedAgent && !NATIVE_OPENROUTER_AGENTS.has(mappedAgent.agent)) {
    blockers.push({
      code: 'agent-map-mismatch',
      surface: `router.agentMap.${mappedAgent.key}`,
      detail: `router.agentMap maps ${mappedAgent.key} to ${mappedAgent.agent}, but ${formatModelPair(identity)} requires native-openrouter.`,
      remediation: `Map ${mappedAgent.key} to native-openrouter/claude-openrouter or remove the conflicting agentMap entry.`,
    });
  }

  const registry = getEffectiveRegistry(input.repoDir);
  const capabilities = getModel(registry, identity.wavemillAlias) ?? getModel(registry, identity.openrouterId);
  const nativeProvider = capabilities?.nativeCapability?.nativeProvider;
  if (nativeProvider && nativeProvider !== 'openrouter') {
    blockers.push({
      code: 'registry-provider-mismatch',
      surface: `modelRegistry.models.${identity.wavemillAlias}.nativeCapability.nativeProvider`,
      detail: `model registry maps ${formatModelPair(identity)} to native provider ${nativeProvider}, expected openrouter.`,
      remediation: 'Update modelRegistry nativeCapability.nativeProvider to openrouter or remove the model from native-openrouter routes.',
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
