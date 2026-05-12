import {
  getAvailableModelsForStage,
  getModelRegistryConfig,
  getRouterConfig,
  type ModelCapabilitiesOverride,
  type ModelRegistryConfig,
} from './config.ts';

export type ModelClass = 'frontier' | 'strong_generalist' | 'fast_economy';
export type RegistryTaskType = 'routing' | 'planning' | 'coding' | 'review' | 'classify';
export type DescriptorModelStage = 'planner' | 'coder' | 'reviewer';

export interface ModelCapabilities {
  vendor: string;
  class: ModelClass;
  strengths: string[];
  weaknesses: string[];
  qualityScores: Record<RegistryTaskType, number>;
  pricing?: {
    inputCostPerMTok: number;
    outputCostPerMTok: number;
    cacheWriteCostPerMTok?: number;
    cacheReadCostPerMTok?: number;
  };
  defaultLadderEligible?: boolean;
  contextWindowTokens?: number;
  agent?: string;
}

export interface ModelRegistry {
  models: Record<string, ModelCapabilities>;
  ladders: Partial<Record<RegistryTaskType, string[]>>;
}

const TASK_TYPES: RegistryTaskType[] = ['routing', 'planning', 'coding', 'review', 'classify'];
export const CLASS_RANK: Record<ModelClass, number> = {
  frontier: 3,
  strong_generalist: 2,
  fast_economy: 1,
};
const warnedUnknownLadders = new Set<string>();
const DESCRIPTOR_STAGE_TO_TASK_TYPE: Record<DescriptorModelStage, RegistryTaskType> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

function scores(
  routing: number,
  planning: number,
  coding: number,
  review: number,
  classify: number,
): Record<RegistryTaskType, number> {
  return { routing, planning, coding, review, classify };
}

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    vendor: capabilities.vendor,
    class: capabilities.class,
    strengths: [...capabilities.strengths],
    weaknesses: [...capabilities.weaknesses],
    qualityScores: { ...capabilities.qualityScores },
    pricing: capabilities.pricing ? { ...capabilities.pricing } : undefined,
    defaultLadderEligible: capabilities.defaultLadderEligible,
    contextWindowTokens: capabilities.contextWindowTokens,
    agent: capabilities.agent,
  };
}

function cloneRegistry(registry: ModelRegistry): ModelRegistry {
  return {
    models: Object.fromEntries(
      Object.entries(registry.models).map(([modelId, capabilities]) => [modelId, cloneCapabilities(capabilities)])
    ),
    ladders: Object.fromEntries(
      Object.entries(registry.ladders).map(([taskType, ladder]) => [taskType, [...ladder]])
    ) as Partial<Record<RegistryTaskType, string[]>>,
  };
}

function dedupeModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const modelId of modelIds) {
    if (typeof modelId !== 'string' || modelId.length === 0 || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    deduped.push(modelId);
  }

  return deduped;
}

function makeDefaultCapabilities(override?: ModelCapabilitiesOverride): ModelCapabilities {
  return {
    vendor: override?.vendor ?? 'custom',
    class: override?.class ?? 'strong_generalist',
    strengths: override?.strengths ? [...override.strengths] : [],
    weaknesses: override?.weaknesses ? [...override.weaknesses] : [],
    qualityScores: {
      routing: 0,
      planning: 0,
      coding: 0,
      review: 0,
      classify: 0,
      ...override?.qualityScores,
    },
    pricing: override?.pricing ? { ...override.pricing } : undefined,
    defaultLadderEligible: override?.defaultLadderEligible ?? true,
    contextWindowTokens: override?.contextWindowTokens,
    agent: override?.agent,
  };
}

function mergeCapabilities(
  base: ModelCapabilities | undefined,
  override: ModelCapabilitiesOverride,
): ModelCapabilities {
  const seed = base ? cloneCapabilities(base) : makeDefaultCapabilities(override);

  return {
    vendor: override.vendor ?? seed.vendor,
    class: override.class ?? seed.class,
    strengths: override.strengths ? [...override.strengths] : seed.strengths,
    weaknesses: override.weaknesses ? [...override.weaknesses] : seed.weaknesses,
    qualityScores: {
      ...seed.qualityScores,
      ...override.qualityScores,
    },
    pricing: override.pricing ? { ...override.pricing } : seed.pricing ? { ...seed.pricing } : undefined,
    defaultLadderEligible: override.defaultLadderEligible ?? seed.defaultLadderEligible ?? true,
    contextWindowTokens: override.contextWindowTokens ?? seed.contextWindowTokens,
    agent: override.agent ?? seed.agent,
  };
}

function warnUnknownModel(taskType: RegistryTaskType, modelId: string): void {
  const key = `${taskType}:${modelId}`;
  if (warnedUnknownLadders.has(key)) {
    return;
  }
  warnedUnknownLadders.add(key);
  console.warn(
    `Ignoring unknown model "${modelId}" in modelRegistry.ladders.${taskType}`
  );
}

function compareModels(
  taskType: RegistryTaskType,
  [leftId, left]: [string, ModelCapabilities],
  [rightId, right]: [string, ModelCapabilities],
): number {
  const scoreDelta = right.qualityScores[taskType] - left.qualityScores[taskType];
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const classDelta = CLASS_RANK[right.class] - CLASS_RANK[left.class];
  if (classDelta !== 0) {
    return classDelta;
  }

  return leftId.localeCompare(rightId);
}

export class ModelValidationError extends Error {
  readonly modelId: string;

  constructor(modelId: string, message: string) {
    super(message);
    this.name = 'ModelValidationError';
    this.modelId = modelId;
  }
}

const MODEL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\[[a-z0-9]+\])?$/;
const PINNED_MODEL_PREFIXES = ['claude-', 'gpt-', 'deepseek-', 'gemini-'] as const;

export type ModelSelector =
  | { kind: 'alias'; family: string; channel?: string }
  | { kind: 'pinned'; modelId: string }
  | { kind: 'inherit' };

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';

export interface ResolvedModel {
  requested: ModelSelector;
  resolved: string;
  source: ResolutionSource;
  familyChannel?: string;
  parentContextId?: string;
}

export interface ResolutionContext {
  parent?: ResolvedModel;
  parentContextId?: string;
}

export type ModelSelectorParseErrorCode = 'empty_input' | 'unknown_family' | 'malformed_pinned_id';

export class ModelSelectorParseError extends Error {
  readonly code: ModelSelectorParseErrorCode;
  readonly input: string;

  constructor(code: ModelSelectorParseErrorCode, input: string, message: string) {
    super(message);
    this.name = 'ModelSelectorParseError';
    this.code = code;
    this.input = input;
  }
}

export type ParseModelSelectorResult =
  | { ok: true; selector: ModelSelector }
  | { ok: false; error: ModelSelectorParseError };

export class ModelResolutionError extends Error {
  readonly selector: ModelSelector;

  constructor(selector: ModelSelector, message: string) {
    super(message);
    this.name = 'ModelResolutionError';
    this.selector = selector;
  }
}

export const FAMILY_ALIASES = Object.freeze({
  opus: Object.freeze({
    recommendedModelId: 'claude-opus-4-7',
    description: 'Stable Anthropic frontier alias for the Opus family.',
  }),
  sonnet: Object.freeze({
    recommendedModelId: 'claude-sonnet-4-6',
    description: 'Stable Anthropic generalist alias for the Sonnet family.',
  }),
  haiku: Object.freeze({
    recommendedModelId: 'claude-haiku-4-5-20251001',
    description: 'Stable Anthropic economy alias for the Haiku family.',
  }),
  'gpt-5.5': Object.freeze({
    recommendedModelId: 'gpt-5.5',
    description: 'Stable OpenAI frontier alias for the GPT-5.5 family.',
  }),
  'gemini-pro': Object.freeze({
    recommendedModelId: 'gemini-pro',
    description: 'Selector alias reserved for Gemini Pro integration follow-up work.',
  }),
}) satisfies Readonly<Record<string, { recommendedModelId: string; description?: string }>>;

function makeModelSelectorParseError(
  code: ModelSelectorParseErrorCode,
  input: string,
  message: string,
): ModelSelectorParseError {
  return new ModelSelectorParseError(code, input, message);
}

function isKnownFamilyAlias(family: string): boolean {
  return Object.hasOwn(FAMILY_ALIASES, family);
}

function isLikelyPinnedModelId(modelId: string): boolean {
  return PINNED_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix)) || /\d/.test(modelId);
}

function isFamilyLikeSelector(input: string): boolean {
  return /^[A-Za-z][A-Za-z0-9.-]*$/.test(input);
}

export function parseModelSelector(input: string): ParseModelSelectorResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: makeModelSelectorParseError(
        'empty_input',
        input,
        'Model selector input must not be empty.',
      ),
    };
  }

  if (trimmed === 'inherit') {
    return { ok: true, selector: { kind: 'inherit' } };
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex >= 0) {
    const family = trimmed.slice(0, colonIndex);
    const channel = trimmed.slice(colonIndex + 1).trim();
    if (isKnownFamilyAlias(family) && channel.length > 0) {
      return {
        ok: true,
        selector: { kind: 'alias', family, channel },
      };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'malformed_pinned_id',
        input,
        `Invalid model selector "${trimmed}". Use "family[:channel]", "inherit", or a pinned model ID.`,
      ),
    };
  }

  if (isKnownFamilyAlias(trimmed)) {
    return { ok: true, selector: { kind: 'alias', family: trimmed } };
  }

  if (MODEL_ID_PATTERN.test(trimmed)) {
    if (isLikelyPinnedModelId(trimmed)) {
      return { ok: true, selector: { kind: 'pinned', modelId: trimmed } };
    }

    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_family',
        input,
        `Unknown model family "${trimmed}". Add it to FAMILY_ALIASES or use a concrete pinned model ID.`,
      ),
    };
  }

  if (isFamilyLikeSelector(trimmed)) {
    return {
      ok: false,
      error: makeModelSelectorParseError(
        'unknown_family',
        input,
        `Unknown model family "${trimmed}". Add it to FAMILY_ALIASES or use a concrete pinned model ID.`,
      ),
    };
  }

  return {
    ok: false,
    error: makeModelSelectorParseError(
      'malformed_pinned_id',
      input,
      `Invalid pinned model ID "${trimmed}". Model IDs must be lowercase and may include digits, hyphens, dots, and one bracket suffix.`,
    ),
  };
}

export function isDeepSeekLikeModelId(modelId: string): boolean {
  return /^deepseek-/i.test(modelId);
}

export function configuredDeepSeekModelIds(registry: ModelRegistry): string[] {
  return Object.keys(registry.models)
    .filter((modelId) => modelId.startsWith('deepseek-'))
    .sort();
}

export function isKnownModelId(registry: ModelRegistry, modelId: string): boolean {
  return Object.hasOwn(registry.models, modelId);
}

export function validateModelId(modelId: string): void {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelValidationError(
      modelId,
      `Error: Invalid model ID "${modelId}"\n\nModel IDs must be lowercase and may include digits, hyphens, dots, and a single bracket suffix like [1m].`,
    );
  }
}

export function resolveSelector(selector: ModelSelector, context?: ResolutionContext): ResolvedModel {
  switch (selector.kind) {
    case 'alias': {
      const entry = FAMILY_ALIASES[selector.family];
      const result: ResolvedModel = {
        requested: selector,
        resolved: entry.recommendedModelId,
        source: 'alias',
      };
      if (selector.channel !== undefined) {
        result.familyChannel = selector.channel;
      }
      return result;
    }
    case 'pinned':
      validateModelId(selector.modelId);
      return {
        requested: selector,
        resolved: selector.modelId,
        source: 'pinned',
      };
    case 'inherit': {
      if (!context?.parent) {
        throw new ModelResolutionError(
          selector,
          'Cannot resolve "inherit" selector without a parent resolution in context.parent.',
        );
      }
      const result: ResolvedModel = {
        requested: selector,
        resolved: context.parent.resolved,
        source: 'inherited',
      };
      if (context.parentContextId !== undefined) {
        result.parentContextId = context.parentContextId;
      }
      return result;
    }
    default: {
      const _exhaustive: never = selector;
      throw new ModelResolutionError(_exhaustive, 'Unhandled ModelSelector kind');
    }
  }
}

export const DEFAULT_MODEL_REGISTRY: ModelRegistry = {
  models: {
    'claude-opus-4-7': {
      vendor: 'anthropic',
      class: 'frontier',
      strengths: ['long-horizon reasoning', 'code review', 'architecture'],
      weaknesses: ['higher cost', 'slower'],
      qualityScores: scores(60, 95, 85, 95, 60),
    },
    'claude-opus-4-6': {
      vendor: 'anthropic',
      class: 'frontier',
      strengths: ['long-horizon reasoning', 'code review', 'architecture'],
      weaknesses: ['higher cost', 'slower'],
      qualityScores: scores(58, 92, 82, 92, 58),
    },
    'claude-sonnet-4-6': {
      vendor: 'anthropic',
      class: 'strong_generalist',
      strengths: ['code generation', 'balanced quality/cost', 'instruction following'],
      weaknesses: ['less deep reasoning'],
      qualityScores: scores(75, 82, 90, 82, 78),
    },
    'claude-sonnet-4-5-20250929': {
      vendor: 'anthropic',
      class: 'strong_generalist',
      strengths: ['code generation', 'balanced quality/cost', 'instruction following'],
      weaknesses: ['less deep reasoning'],
      qualityScores: scores(72, 78, 86, 78, 74),
    },
    'claude-haiku-4-5-20251001': {
      vendor: 'anthropic',
      class: 'fast_economy',
      strengths: ['speed', 'low cost', 'classification'],
      weaknesses: ['less depth on complex reasoning'],
      qualityScores: scores(88, 55, 60, 55, 92),
    },
    'gpt-5.5': {
      vendor: 'openai',
      class: 'frontier',
      strengths: ['frontier reasoning', 'code generation', 'architecture'],
      weaknesses: ['higher cost'],
      qualityScores: scores(62, 96, 92, 94, 62),
    },
    'gpt-5.4': {
      vendor: 'openai',
      class: 'frontier',
      strengths: ['frontier reasoning', 'code generation', 'architecture'],
      weaknesses: ['higher cost'],
      qualityScores: scores(60, 94, 90, 92, 60),
    },
    'deepseek-v4-pro': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['long-context reasoning', 'code generation', 'anthropic-compatible launch'],
      weaknesses: ['opt-in only', 'pricing subject to change'],
      qualityScores: scores(64, 84, 83, 85, 62),
      pricing: {
        inputCostPerMTok: 0.435,
        outputCostPerMTok: 0.87,
        cacheWriteCostPerMTok: 0.435,
        cacheReadCostPerMTok: 0.003625,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      agent: 'claude',
    },
    'deepseek-v4-pro[1m]': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['max-context tasks', 'code generation', 'anthropic-compatible launch'],
      weaknesses: ['opt-in only', 'pricing subject to change'],
      qualityScores: scores(63, 85, 82, 84, 61),
      pricing: {
        inputCostPerMTok: 0.435,
        outputCostPerMTok: 0.87,
        cacheWriteCostPerMTok: 0.435,
        cacheReadCostPerMTok: 0.003625,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      agent: 'claude',
    },
    'deepseek-v4-flash': {
      vendor: 'deepseek',
      class: 'fast_economy',
      strengths: ['speed', 'low cost', 'anthropic-compatible launch'],
      weaknesses: ['less depth than pro', 'opt-in only'],
      qualityScores: scores(70, 68, 76, 70, 80),
      pricing: {
        inputCostPerMTok: 0.14,
        outputCostPerMTok: 0.28,
        cacheWriteCostPerMTok: 0.14,
        cacheReadCostPerMTok: 0.0028,
      },
      defaultLadderEligible: false,
      contextWindowTokens: 1_000_000,
      agent: 'claude',
    },
    'deepseek-chat': {
      vendor: 'deepseek',
      class: 'strong_generalist',
      strengths: ['compatibility alias for existing DeepSeek integrations'],
      weaknesses: ['compatibility alias', 'future deprecation risk'],
      qualityScores: scores(46, 70, 76, 68, 40),
      agent: 'claude',
    },
    'deepseek-reasoner': {
      vendor: 'deepseek',
      class: 'frontier',
      strengths: ['reasoning-oriented compatibility alias'],
      weaknesses: ['compatibility alias', 'future deprecation risk'],
      qualityScores: scores(44, 78, 74, 70, 36),
      agent: 'claude',
    },
  },
  ladders: {
    routing: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'claude-sonnet-4-6', 'gpt-5.5', 'gpt-5.4', 'deepseek-v4-pro', 'claude-opus-4-7'],
    planning: ['gpt-5.5', 'claude-opus-4-7', 'gpt-5.4', 'deepseek-reasoner', 'deepseek-v4-pro', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    coding: ['gpt-5.5', 'gpt-5.4', 'deepseek-v4-pro', 'claude-sonnet-4-6', 'claude-opus-4-7', 'deepseek-chat', 'deepseek-v4-flash', 'claude-haiku-4-5-20251001'],
    review: ['claude-opus-4-7', 'gpt-5.5', 'gpt-5.4', 'deepseek-v4-pro', 'claude-sonnet-4-6', 'deepseek-reasoner', 'claude-haiku-4-5-20251001'],
    classify: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'claude-sonnet-4-6', 'gpt-5.5', 'gpt-5.4'],
  },
};

export function getModel(registry: ModelRegistry, modelId: string): ModelCapabilities | undefined {
  if (!modelId) {
    return undefined;
  }
  return registry.models[modelId];
}

export function getLadder(registry: ModelRegistry, taskType: RegistryTaskType): string[] {
  const configured = registry.ladders[taskType];
  if (configured) {
    return configured.filter((modelId) => {
      if (registry.models[modelId]) {
        return true;
      }
      warnUnknownModel(taskType, modelId);
      return false;
    });
  }

  return Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.defaultLadderEligible !== false)
    .filter(([, capabilities]) => Number.isFinite(capabilities.qualityScores[taskType]))
    .sort((left, right) => compareModels(taskType, left, right))
    .filter(([, capabilities]) => capabilities.qualityScores[taskType] > 0)
    .map(([modelId]) => modelId);
}

export function rankCandidates(
  registry: ModelRegistry,
  taskType: RegistryTaskType,
  opts?: { excluded?: string[] },
): string[] {
  const excluded = new Set(opts?.excluded ?? []);
  return getLadder(registry, taskType).filter((modelId) => !excluded.has(modelId));
}

/**
 * Merge config overrides into the seeded registry.
 *
 * Arrays replace the default value when present. `qualityScores` merges per task.
 * Unknown ladder model IDs are retained in the merged data and filtered during lookup
 * so the effective output remains deterministic while surfacing config mistakes.
 */
export function mergeModelRegistry(
  defaults: ModelRegistry,
  overrides?: ModelRegistryConfig,
): ModelRegistry {
  const merged = cloneRegistry(defaults);
  if (!overrides) {
    return merged;
  }

  for (const [modelId, override] of Object.entries(overrides.models ?? {})) {
    merged.models[modelId] = mergeCapabilities(merged.models[modelId], override);
  }

  for (const taskType of TASK_TYPES) {
    const overrideLadder = overrides.ladders?.[taskType];
    if (overrideLadder) {
      merged.ladders[taskType] = [...overrideLadder];
    }
  }

  return merged;
}

export function getEffectiveRegistry(repoDir?: string): ModelRegistry {
  return mergeModelRegistry(DEFAULT_MODEL_REGISTRY, getModelRegistryConfig(repoDir));
}

export function getConfiguredModelsForDescriptorStage(
  repoDir: string | undefined,
  stage: DescriptorModelStage,
): string[] {
  const configuredModels = getAvailableModelsForStage(getRouterConfig(repoDir), stage);
  if (configuredModels && configuredModels.length > 0) {
    return dedupeModelIds(configuredModels);
  }

  return dedupeModelIds(getLadder(getEffectiveRegistry(repoDir), DESCRIPTOR_STAGE_TO_TASK_TYPE[stage]));
}

export function getConfiguredModelsForDescriptor(repoDir?: string): string[] {
  return dedupeModelIds([
    ...getConfiguredModelsForDescriptorStage(repoDir, 'planner'),
    ...getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
    ...getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'),
  ]);
}

export function resetWarningState(): void {
  warnedUnknownLadders.clear();
}
