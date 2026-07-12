import {
  getNativeAgentConfig,
  type NativeAgentConfig,
  type NativeAgentAllowedPhase,
  type NativeAgentProviderConfig,
  type NativeAgentProviderName,
} from '../config.ts';
import { resolveEnvValue } from '../env-file.ts';
import {
  getEffectiveRegistry,
  type ModelRegistry,
  type ReadOnlyNativeCapability,
} from '../model-registry.ts';
import {
  evaluateNativeProviderGate,
  type CertificationPhase,
  type NativeGateMode,
  type NativeGateRejectReason,
} from './certification/index.ts';
import {
  buildPiModel,
  getRegisteredPiProviderForModel,
  type PiModel,
} from './tools/pi-adapter.ts';
export { getRegisteredPiProviderForModel } from './tools/pi-adapter.ts';

export const OPENAI_NATIVE_PROVIDER = 'openai' as const;
export const OPENROUTER_NATIVE_PROVIDER = 'openrouter' as const;

export const OPENAI_DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
export const OPENROUTER_DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export const OPENAI_DEFAULT_MODELS = ['gpt-4o'] as const;
export const OPENROUTER_DEFAULT_MODELS = ['openai/gpt-4o-mini'] as const;

export type NativeProviderStatus = 'ready' | 'unavailable' | 'skipped' | 'uncertified';

export interface NativeProviderEntryBase {
  providerName: NativeAgentProviderName;
  modelId: string;
  status: NativeProviderStatus;
  apiKeyEnv: string;
  baseUrl: string;
  headers: Record<string, string>;
}

export interface ReadyNativeProviderEntry extends NativeProviderEntryBase {
  status: 'ready';
  model: PiModel;
  certificationOnly?: boolean;
}

export interface UnavailableNativeProviderEntry extends NativeProviderEntryBase {
  status: 'unavailable';
  reason: string;
}

export interface SkippedNativeProviderEntry extends NativeProviderEntryBase {
  status: 'skipped';
  reason: string;
}

export interface UncertifiedNativeProviderEntry extends NativeProviderEntryBase {
  status: 'uncertified';
  reason: string;
  capability: ReadOnlyNativeCapability | 'unregistered';
  rejectionReason?: NativeGateRejectReason;
}

export type ResolvedNativeProviderEntry =
  | ReadyNativeProviderEntry
  | UnavailableNativeProviderEntry
  | SkippedNativeProviderEntry
  | UncertifiedNativeProviderEntry;

export interface ResolveNativeAgentProvidersOptions {
  env?: Record<string, string | undefined>;
  repoDir?: string;
  phase?: string;
  mode?: NativeGateMode;
  requiredCertificationPhase?: CertificationPhase;
  certificationMode?: boolean;
  allowPartial?: boolean;
  registry?: ModelRegistry;
  now?: Date;
}

const DEFAULT_PROVIDER_ORDER: readonly NativeAgentProviderName[] = [
  OPENAI_NATIVE_PROVIDER,
  OPENROUTER_NATIVE_PROVIDER,
] as const;

const NATIVE_AGENT_PHASE_TO_CERT_PHASE: Record<NativeAgentAllowedPhase, CertificationPhase> = {
  'task-expansion': 'read-only',
  planning: 'read-only',
  review: 'read-only',
};

const READY_ENTRY_API_KEY = Symbol('ready-native-provider-api-key');
const NATIVE_PROVIDER_REMEDIATION_REPORT = 'wavemill native-agent models report --json';

export function resolveNativeAgentProviders(
  configOrRepoDir?: NativeAgentConfig | string,
  options: ResolveNativeAgentProvidersOptions = {},
): ResolvedNativeProviderEntry[] {
  const { config, repoDir } = resolveConfigSource(configOrRepoDir, options.repoDir);
  const providers = config.providers ?? {};
  const resolved: ResolvedNativeProviderEntry[] = [];
  const phase = options.phase ?? 'planning';
  const mode = resolveProviderMode(options);
  const requiredCertificationPhase = mode === 'task'
    ? resolveRequiredCertificationPhase(phase, options.requiredCertificationPhase)
    : undefined;
  const registry = options.registry ?? getEffectiveRegistry(repoDir);

  for (const providerName of DEFAULT_PROVIDER_ORDER) {
    const providerConfig = providers[providerName];
    if (!providerConfig) {
      continue;
    }

    const apiKeyEnv = normalizeApiKeyEnv(providerName, providerConfig.apiKeyEnv);
    const baseUrl = normalizeBaseUrl(providerName, providerConfig.baseUrl);
    const headers = normalizeHeaders(providerConfig.headers);
    const modelIds = normalizeModels(providerName, providerConfig.models);

    if (providerConfig.enabled === false) {
      for (const modelId of modelIds) {
        resolved.push({
          providerName,
          modelId,
          status: 'skipped',
          apiKeyEnv,
          baseUrl,
          headers,
          reason: `nativeAgent.providers.${providerName}.enabled is false`,
        });
      }
      continue;
    }

    const apiKey = resolveApiKeyValue(apiKeyEnv, repoDir, options.env);
    if (!apiKey) {
      for (const modelId of modelIds) {
        resolved.push({
          providerName,
          modelId,
          status: 'unavailable',
          apiKeyEnv,
          baseUrl,
          headers,
          reason: `${apiKeyEnv} is not set`,
        });
      }
      continue;
    }

    for (const modelId of modelIds) {
      if (mode === 'certification') {
        const readyEntry: ReadyNativeProviderEntry = {
          providerName,
          modelId,
          status: 'ready',
          apiKeyEnv,
          baseUrl,
          headers,
          model: providerName === OPENAI_NATIVE_PROVIDER
            ? buildOpenAiResponsesModel({ modelId, baseUrl, headers })
            : buildOpenRouterModel({ modelId, baseUrl, headers }),
          certificationOnly: registry.models[modelId]?.nativeCapability?.readOnlyNative !== 'certified',
        };
        attachApiKey(readyEntry, apiKey);
        resolved.push(readyEntry);
        continue;
      }

      const decision = evaluateNativeProviderGate({
        modelId,
        mode,
        requiredPhase: requiredCertificationPhase,
        registry,
        repoDir,
        apiKeyPresent: true,
        apiKeyEnv,
        now: options.now,
      });

      if (!decision.ok) {
        resolved.push({
          providerName,
          modelId,
          status: 'uncertified',
          apiKeyEnv,
          baseUrl,
          headers,
          reason: decision.message,
          capability: decision.nativeCapability ?? 'unregistered',
          rejectionReason: decision.reason,
        });
        continue;
      }

      const readyEntry: ReadyNativeProviderEntry = {
        providerName,
        modelId,
        status: 'ready',
        apiKeyEnv,
        baseUrl,
        headers,
        model: providerName === OPENAI_NATIVE_PROVIDER
          ? buildOpenAiResponsesModel({ modelId, baseUrl, headers })
          : buildOpenRouterModel({ modelId, baseUrl, headers }),
        certificationOnly: false,
      };
      attachApiKey(readyEntry, apiKey);
      resolved.push(readyEntry);
    }
  }

  return resolved;
}

export function getNativeProviderApiKey(entry: ReadyNativeProviderEntry): string | undefined {
  return (entry as ReadyNativeProviderEntry & { [READY_ENTRY_API_KEY]?: string })[READY_ENTRY_API_KEY];
}

export function buildNativeProviderResolutionFailureMessage(
  launchLabel: string,
  entries: readonly ResolvedNativeProviderEntry[],
  requiredCertificationPhase: CertificationPhase = 'read-only',
): string {
  if (entries.length === 0) {
    return [
      `Native ${launchLabel} is unavailable: no native providers are configured.`,
      `Configure nativeAgent.providers and run ${NATIVE_PROVIDER_REMEDIATION_REPORT}.`,
    ].join(' ');
  }

  const details = entries.map((entry) => describeNativeProviderFailure(entry, requiredCertificationPhase));
  return [
    `Native ${launchLabel} is unavailable: ${details.join('; ')}.`,
    `Run ${NATIVE_PROVIDER_REMEDIATION_REPORT} to inspect current artifact eligibility.`,
  ].join(' ');
}

export function buildOpenAiResponsesModel({
  modelId,
  baseUrl = OPENAI_DEFAULT_BASE_URL,
  headers = {},
}: {
  modelId: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): PiModel {
  return buildPiModel({
    id: `${OPENAI_NATIVE_PROVIDER}:${modelId}`,
    name: modelId,
    api: 'openai-responses',
    provider: OPENAI_NATIVE_PROVIDER,
    baseUrl,
    headers,
  });
}

export function buildOpenRouterModel({
  modelId,
  baseUrl = OPENROUTER_DEFAULT_BASE_URL,
  headers = {},
}: {
  modelId: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): PiModel {
  return buildPiModel({
    id: `${OPENROUTER_NATIVE_PROVIDER}:${modelId}`,
    name: modelId,
    api: 'openai-completions',
    provider: OPENROUTER_NATIVE_PROVIDER,
    baseUrl,
    headers,
    compat: {
      thinkingFormat: 'openrouter',
    },
  });
}

function resolveConfigSource(
  configOrRepoDir: NativeAgentConfig | string | undefined,
  repoDir: string | undefined,
): { config: NativeAgentConfig; repoDir: string | undefined } {
  if (typeof configOrRepoDir === 'string' || configOrRepoDir === undefined) {
    const effectiveRepoDir = configOrRepoDir ?? repoDir;
    return {
      config: getNativeAgentConfig(effectiveRepoDir),
      repoDir: effectiveRepoDir,
    };
  }

  return { config: configOrRepoDir, repoDir };
}

function normalizeApiKeyEnv(
  providerName: NativeAgentProviderName,
  apiKeyEnv: string | undefined,
): string {
  const normalized = apiKeyEnv?.trim();
  if (normalized) {
    return normalized;
  }

  return providerName === OPENAI_NATIVE_PROVIDER
    ? OPENAI_DEFAULT_API_KEY_ENV
    : OPENROUTER_DEFAULT_API_KEY_ENV;
}

function normalizeBaseUrl(
  providerName: NativeAgentProviderName,
  baseUrl: string | undefined,
): string {
  const normalized = baseUrl?.trim();
  if (normalized) {
    return normalized;
  }

  return providerName === OPENAI_NATIVE_PROVIDER
    ? OPENAI_DEFAULT_BASE_URL
    : OPENROUTER_DEFAULT_BASE_URL;
}

function normalizeModels(
  providerName: NativeAgentProviderName,
  models: string[] | undefined,
): string[] {
  const candidates = models && models.length > 0
    ? models
    : providerName === OPENAI_NATIVE_PROVIDER
      ? [...OPENAI_DEFAULT_MODELS]
      : [...OPENROUTER_DEFAULT_MODELS];

  return [...new Set(
    candidates
      .map((modelId) => modelId.trim())
      .filter((modelId) => modelId.length > 0),
  )];
}

function normalizeHeaders(headers: NativeAgentProviderConfig['headers']): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.trim(), value])
      .filter(([name]) => name.length > 0),
  );
}

function resolveApiKeyValue(
  apiKeyEnv: string,
  repoDir: string | undefined,
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  const inlineValue = env?.[apiKeyEnv]?.trim();
  if (inlineValue) {
    return inlineValue;
  }

  return resolveEnvValue([apiKeyEnv], repoDir);
}

function attachApiKey(entry: ReadyNativeProviderEntry, apiKey: string): void {
  Object.defineProperty(entry, READY_ENTRY_API_KEY, {
    value: apiKey,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function describeNativeProviderFailure(
  entry: ResolvedNativeProviderEntry,
  requiredCertificationPhase: CertificationPhase,
): string {
  const identity = `${entry.providerName}:${entry.modelId}`;

  if (entry.status === 'unavailable') {
    return `${identity} unavailable (${entry.reason}); set ${entry.apiKeyEnv}`;
  }

  if (entry.status === 'skipped') {
    return `${identity} skipped (${entry.reason}); enable nativeAgent.providers.${entry.providerName}.enabled`;
  }

  if (entry.status === 'uncertified') {
    const certifyCommand = buildNativeProviderCertifyCommand(
      entry.providerName,
      entry.modelId,
      requiredCertificationPhase,
    );
    return `${identity} rejected (reason=${entry.rejectionReason ?? 'uncertified'}; ${entry.reason}); re-certify with ${certifyCommand}`;
  }

  return `${identity} unavailable`;
}

function buildNativeProviderCertifyCommand(
  providerName: NativeAgentProviderName,
  modelId: string,
  requiredCertificationPhase: CertificationPhase,
): string {
  return `npx tsx tools/native-agent-certify.ts --provider ${providerName} --model ${modelId} --phase ${requiredCertificationPhase}`;
}

function resolveProviderMode(options: ResolveNativeAgentProvidersOptions): NativeGateMode {
  if (options.mode) {
    return options.mode;
  }
  return options.certificationMode === true ? 'certification' : 'task';
}

function resolveRequiredCertificationPhase(
  phase: string,
  requiredCertificationPhase: CertificationPhase | undefined,
): CertificationPhase {
  if (requiredCertificationPhase) {
    return requiredCertificationPhase;
  }

  if (phase in NATIVE_AGENT_PHASE_TO_CERT_PHASE) {
    return NATIVE_AGENT_PHASE_TO_CERT_PHASE[phase as NativeAgentAllowedPhase];
  }

  throw new Error(`resolveNativeAgentProviders: unsupported task phase "${phase}" for certification gating`);
}
