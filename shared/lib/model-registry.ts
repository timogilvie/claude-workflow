import {
  getModelRegistryConfig,
  type ModelCapabilitiesOverride,
  type ModelRegistryConfig,
} from './config.ts';

export type ModelClass = 'frontier' | 'strong_generalist' | 'fast_economy';
export type RegistryTaskType = 'routing' | 'planning' | 'coding' | 'review' | 'classify';

export interface ModelCapabilities {
  vendor: string;
  class: ModelClass;
  strengths: string[];
  weaknesses: string[];
  qualityScores: Record<RegistryTaskType, number>;
}

export interface ModelRegistry {
  models: Record<string, ModelCapabilities>;
  ladders: Partial<Record<RegistryTaskType, string[]>>;
}

const TASK_TYPES: RegistryTaskType[] = ['routing', 'planning', 'coding', 'review', 'classify'];
const CLASS_RANK: Record<ModelClass, number> = {
  frontier: 3,
  strong_generalist: 2,
  fast_economy: 1,
};
const warnedUnknownLadders = new Set<string>();

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
  },
  ladders: {
    routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'],
    planning: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    coding: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    review: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
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

export function resetWarningState(): void {
  warnedUnknownLadders.clear();
}
