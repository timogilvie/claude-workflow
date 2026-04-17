/**
 * Model capability registry with task-specific fallback ladders.
 *
 * Provides:
 * - Canonical registry of supported models (vendor, class tier, strengths, weaknesses)
 * - Per-task quality scores (routing, planning, coding, review, classify)
 * - Task-specific ranked ladders (deterministic model selection)
 * - Config-overridable defaults with shallow merge semantics
 *
 * @module model-registry
 */

import { resolve } from 'node:path';
import { getModelRegistryConfig } from './config.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Model vendor identifier (extensible for future vendors).
 */
export type ModelVendor = 'anthropic' | 'openai' | string;

/**
 * Model class tier: frontier (best), strong_generalist (versatile), fast_economy (cheap/fast).
 */
export type ModelClass = 'frontier' | 'strong_generalist' | 'fast_economy';

/**
 * Task profile: capability area for which models are ranked.
 * Distinct from TaskType (feature/bugfix); these are stage/capability profiles.
 */
export type ModelTaskProfile = 'routing' | 'planning' | 'coding' | 'review' | 'classify';

/**
 * Model capability descriptor: vendor, class tier, strengths/weaknesses, per-task quality scores.
 */
export interface ModelCapability {
  modelId: string;
  vendor: ModelVendor;
  class: ModelClass;
  strengths: string[];
  weaknesses: string[];
  /** Per-profile quality scores, range 0..1. Missing profile => 0 (treated as unsuitable). */
  taskScores: Partial<Record<ModelTaskProfile, number>>;
  /** Optional: mark retired models so they're excluded from ladders by default. */
  deprecated?: boolean;
}

/**
 * Per-task profile configuration (overridable from config).
 */
export interface TaskProfileConfig {
  /** Explicit ladder override. When present, used as a tiebreaker after score sort. */
  ladder?: string[];
}

/**
 * The loaded model registry: all capabilities and per-task profile configs.
 */
export interface ModelRegistry {
  models: Map<string, ModelCapability>;
  taskProfiles: Record<ModelTaskProfile, TaskProfileConfig>;
}

// ────────────────────────────────────────────────────────────────
// Seed Data
// ────────────────────────────────────────────────────────────────

/**
 * Hand-tuned seed models covering all known model IDs.
 * Scores are heuristic anchors based on task descriptions and current usage patterns.
 * Eval-derived overrides remain the job of existing routers.
 *
 * | Model | Class | routing | planning | coding | review | classify |
 * |-------|-------|---------|----------|--------|--------|----------|
 * | claude-opus-4-7 | frontier | 0.88 | 0.97 | 0.95 | 0.96 | 0.82 |
 * | claude-opus-4-6 | frontier | 0.86 | 0.94 | 0.92 | 0.94 | 0.80 |
 * | claude-sonnet-4-6 | strong_generalist | 0.85 | 0.88 | 0.90 | 0.88 | 0.86 |
 * | claude-sonnet-4-5-20250929 | strong_generalist | 0.83 | 0.85 | 0.88 | 0.85 | 0.84 |
 * | claude-haiku-4-5-20251001 | fast_economy | 0.80 | 0.65 | 0.70 | 0.72 | 0.92 |
 * | gpt-5.4 | strong_generalist | 0.80 | 0.86 | 0.89 | 0.84 | 0.82 |
 * | gpt-5.3-codex | strong_generalist | 0.75 | 0.78 | 0.91 | 0.80 | 0.70 |
 * | gpt-5.3-codex-spark | fast_economy | 0.70 | 0.60 | 0.78 | 0.68 | 0.75 |
 */
const SEED_MODELS: ModelCapability[] = [
  {
    modelId: 'claude-opus-4-7',
    vendor: 'anthropic',
    class: 'frontier',
    strengths: ['long-horizon reasoning', 'planning', 'code generation'],
    weaknesses: ['cost', 'latency'],
    taskScores: {
      routing: 0.88,
      planning: 0.97,
      coding: 0.95,
      review: 0.96,
      classify: 0.82,
    },
  },
  {
    modelId: 'claude-opus-4-6',
    vendor: 'anthropic',
    class: 'frontier',
    strengths: ['long-horizon reasoning', 'planning', 'code generation'],
    weaknesses: ['cost', 'latency'],
    taskScores: {
      routing: 0.86,
      planning: 0.94,
      coding: 0.92,
      review: 0.94,
      classify: 0.80,
    },
  },
  {
    modelId: 'claude-sonnet-4-6',
    vendor: 'anthropic',
    class: 'strong_generalist',
    strengths: ['balanced performance', 'reasoning', 'versatile'],
    weaknesses: ['slightly lower reasoning than opus'],
    taskScores: {
      routing: 0.85,
      planning: 0.88,
      coding: 0.90,
      review: 0.88,
      classify: 0.86,
    },
  },
  {
    modelId: 'claude-sonnet-4-5-20250929',
    vendor: 'anthropic',
    class: 'strong_generalist',
    strengths: ['balanced performance', 'reasoning', 'versatile'],
    weaknesses: ['slightly lower reasoning than opus'],
    taskScores: {
      routing: 0.83,
      planning: 0.85,
      coding: 0.88,
      review: 0.85,
      classify: 0.84,
    },
  },
  {
    modelId: 'claude-haiku-4-5-20251001',
    vendor: 'anthropic',
    class: 'fast_economy',
    strengths: ['speed', 'cost efficiency', 'classification'],
    weaknesses: ['limited reasoning', 'shorter context window'],
    taskScores: {
      routing: 0.80,
      planning: 0.65,
      coding: 0.70,
      review: 0.72,
      classify: 0.92,
    },
  },
  {
    modelId: 'gpt-5.4',
    vendor: 'openai',
    class: 'strong_generalist',
    strengths: ['strong reasoning', 'code generation', 'versatile'],
    weaknesses: ['variable latency'],
    taskScores: {
      routing: 0.80,
      planning: 0.86,
      coding: 0.89,
      review: 0.84,
      classify: 0.82,
    },
  },
  {
    modelId: 'gpt-5.3-codex',
    vendor: 'openai',
    class: 'strong_generalist',
    strengths: ['code generation', 'specialized for coding'],
    weaknesses: ['less capable at non-code tasks'],
    taskScores: {
      routing: 0.75,
      planning: 0.78,
      coding: 0.91,
      review: 0.80,
      classify: 0.70,
    },
  },
  {
    modelId: 'gpt-5.3-codex-spark',
    vendor: 'openai',
    class: 'fast_economy',
    strengths: ['cost efficiency', 'code generation', 'speed'],
    weaknesses: ['lower reasoning capability'],
    taskScores: {
      routing: 0.70,
      planning: 0.60,
      coding: 0.78,
      review: 0.68,
      classify: 0.75,
    },
  },
];

/**
 * Default task profile ladders (deterministic rank order per task).
 * These match the issue specification where given; others are heuristic.
 */
const DEFAULT_TASK_PROFILES: Record<ModelTaskProfile, TaskProfileConfig> = {
  review: {
    ladder: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  classify: {
    ladder: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
  },
  planning: {
    ladder: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'],
  },
  coding: {
    ladder: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'gpt-5.3-codex',
      'claude-haiku-4-5-20251001',
    ],
  },
  routing: {
    ladder: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
  },
};

// ────────────────────────────────────────────────────────────────
// Module-level deduplication state
// ────────────────────────────────────────────────────────────────

const _unknownLadderModelWarnings = new Set<string>();

// ────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────

/**
 * In-memory cache of loaded registries, keyed by absolute repo directory path.
 * Lifetime: process-level singleton (no file watching or TTL).
 */
const registryCache = new Map<string, ModelRegistry>();

/**
 * Resolve a repo directory path to an absolute path for cache key consistency.
 */
function resolveRepoDir(repoDir?: string): string {
  return resolve(repoDir || process.cwd());
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Load the model registry, merging defaults with config overrides.
 * Cached per repoDir; call clearModelRegistryCache() to force reload.
 *
 * @param repoDir - Repository directory (default: current working directory)
 * @returns Loaded and merged ModelRegistry
 *
 * @example
 * ```typescript
 * import { loadModelRegistry } from './model-registry.ts';
 *
 * const registry = loadModelRegistry();
 * const ladder = registry.getRankedLadder('review');
 * ```
 */
export function loadModelRegistry(repoDir?: string): ModelRegistry {
  const absRepoDir = resolveRepoDir(repoDir);

  // Check cache first
  const cached = registryCache.get(absRepoDir);
  if (cached !== undefined) {
    return cached;
  }

  // Start with deep clone of seed data
  const models = new Map<string, ModelCapability>();
  for (const seed of SEED_MODELS) {
    models.set(seed.modelId, JSON.parse(JSON.stringify(seed)));
  }

  // Merge config overrides
  const configOverrides = getModelRegistryConfig(absRepoDir);

  // Shallow merge model overrides
  if (configOverrides.models) {
    for (const [modelId, override] of Object.entries(configOverrides.models)) {
      const existing = models.get(modelId);
      if (existing) {
        // Shallow merge: override specific fields while preserving others
        const merged = {
          ...existing,
          ...override,
          modelId: existing.modelId, // Always preserve the modelId
          taskScores: {
            ...existing.taskScores,
            ...override.taskScores,
          },
        };
        models.set(modelId, merged as ModelCapability);
      } else {
        // New model from config - add modelId if missing
        const newModel = {
          ...override,
          modelId,
        } as ModelCapability;
        models.set(modelId, newModel);
      }
    }
  }

  // Task profile ladder overrides (full replace, not merge)
  const taskProfiles: Record<ModelTaskProfile, TaskProfileConfig> = {};
  for (const profile of ['routing', 'planning', 'coding', 'review', 'classify'] as const) {
    const defaultConfig = DEFAULT_TASK_PROFILES[profile];
    const override = configOverrides.taskProfiles?.[profile];
    taskProfiles[profile] = override || { ...defaultConfig };
  }

  const registry: ModelRegistry = { models, taskProfiles };
  registryCache.set(absRepoDir, registry);
  return registry;
}

/**
 * Clear the registry cache for a specific repo or all repos.
 *
 * Useful for:
 * - Testing (force reload between tests)
 * - Manual config changes during long-running processes
 *
 * @param repoDir - Repository directory (omit to clear all cached registries)
 *
 * @example
 * ```typescript
 * import { clearModelRegistryCache } from './model-registry.ts';
 *
 * // Clear specific repo
 * clearModelRegistryCache('/path/to/repo');
 *
 * // Clear all
 * clearModelRegistryCache();
 * ```
 */
export function clearModelRegistryCache(repoDir?: string): void {
  if (repoDir !== undefined) {
    const absRepoDir = resolveRepoDir(repoDir);
    registryCache.delete(absRepoDir);
  } else {
    registryCache.clear();
  }
}

/**
 * Lookup a single model's capability by ID.
 * Returns undefined if the model is unknown.
 *
 * @param registry - The loaded ModelRegistry
 * @param modelId - Model identifier
 * @returns ModelCapability or undefined
 *
 * @example
 * ```typescript
 * const cap = getCapability(registry, 'claude-opus-4-7');
 * console.log(cap?.strengths); // ['long-horizon reasoning', ...]
 * ```
 */
export function getCapability(
  registry: ModelRegistry,
  modelId: string,
): ModelCapability | undefined {
  return registry.models.get(modelId);
}

/**
 * List all models in the registry (non-deprecated by default).
 *
 * @param registry - The loaded ModelRegistry
 * @param opts - Options: includeDeprecated (default false)
 * @returns Array of ModelCapability objects, sorted by modelId
 *
 * @example
 * ```typescript
 * const all = listModels(registry);
 * const withDeprecated = listModels(registry, { includeDeprecated: true });
 * ```
 */
export function listModels(
  registry: ModelRegistry,
  opts?: { includeDeprecated?: boolean },
): ModelCapability[] {
  const includeDeprecated = opts?.includeDeprecated ?? false;
  return Array.from(registry.models.values())
    .filter((cap) => includeDeprecated || !cap.deprecated)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Filter models by class tier.
 *
 * @param registry - The loaded ModelRegistry
 * @param klass - Class to filter by: 'frontier' | 'strong_generalist' | 'fast_economy'
 * @returns Array of ModelCapability objects, sorted by modelId
 *
 * @example
 * ```typescript
 * const frontier = getModelsByClass(registry, 'frontier');
 * console.log(frontier.map(m => m.modelId)); // ['claude-opus-4-6', 'claude-opus-4-7']
 * ```
 */
export function getModelsByClass(
  registry: ModelRegistry,
  klass: ModelClass,
): ModelCapability[] {
  return Array.from(registry.models.values())
    .filter((cap) => cap.class === klass)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Options for getRankedLadder.
 */
export interface LadderOptions {
  /** Model IDs to exclude from the returned ladder. */
  excluded?: string[];
  /** If provided, the ladder is intersected with this whitelist (preserving rank order). */
  available?: string[];
  /** Include deprecated models (default false). */
  includeDeprecated?: boolean;
}

/**
 * Returns a deterministic ranked list of model IDs for the given task profile.
 *
 * Ranking algorithm:
 * 1. By taskScores[profile] descending (missing score treated as -Infinity).
 * 2. Tiebreaker: rank in taskProfiles[profile].ladder (lower index = higher rank).
 * 3. Tiebreaker: lexicographic modelId.
 *
 * After sorting, excluded/deprecated/non-available models are filtered out.
 *
 * @param registry - The loaded ModelRegistry
 * @param profile - Task profile: 'routing' | 'planning' | 'coding' | 'review' | 'classify'
 * @param options - Exclusion, intersection, and deprecation filters
 * @returns Deterministic ordered array of model IDs
 *
 * @example
 * ```typescript
 * const registry = loadModelRegistry();
 *
 * // Default review ladder (opus > sonnet > haiku)
 * const review = getRankedLadder(registry, 'review');
 *
 * // Exclude opus (falls back to sonnet > haiku)
 * const reviewNoOpus = getRankedLadder(registry, 'review', {
 *   excluded: ['claude-opus-4-7'],
 * });
 *
 * // Only consider available models
 * const reviewAvail = getRankedLadder(registry, 'review', {
 *   available: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
 * });
 * ```
 */
export function getRankedLadder(
  registry: ModelRegistry,
  profile: ModelTaskProfile,
  options?: LadderOptions,
): string[] {
  const excluded = new Set(options?.excluded ?? []);
  // Empty available list is treated as "no restriction" (per plan edge cases)
  const available = options?.available && options.available.length > 0 ? new Set(options.available) : undefined;
  const includeDeprecated = options?.includeDeprecated ?? false;

  const profileConfig = registry.taskProfiles[profile];
  const defaultLadder = profileConfig.ladder ?? [];
  const ladderRank = new Map(defaultLadder.map((id, idx) => [id, idx]));

  // Collect all models in the registry
  const candidates = Array.from(registry.models.entries())
    .filter(([modelId, cap]) => {
      // Filter: not excluded
      if (excluded.has(modelId)) return false;
      // Filter: not deprecated (unless explicitly included)
      if (cap.deprecated && !includeDeprecated) return false;
      // Filter: in available set (if provided)
      if (available && !available.has(modelId)) return false;
      // Filter: has a score for this profile (missing score means -Infinity, excluded)
      if (!(profile in cap.taskScores)) return false;
      return true;
    })
    .map(([modelId, cap]) => ({ modelId, cap }));

  // Sort with total-order comparator
  candidates.sort((a, b) => {
    // At this point, all candidates have a score for the profile (filtered above)
    const scoreA = a.cap.taskScores[profile]!;
    const scoreB = b.cap.taskScores[profile]!;

    // Primary: score descending
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    // Secondary: ladder rank (lower index = higher rank)
    const rankA = ladderRank.get(a.modelId) ?? Infinity;
    const rankB = ladderRank.get(b.modelId) ?? Infinity;
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    // Tertiary: lexicographic modelId
    return a.modelId.localeCompare(b.modelId);
  });

  // Warn once per process about unknown models in ladder config
  for (const modelId of defaultLadder) {
    const warnKey = `${profile}:${modelId}`;
    if (!registry.models.has(modelId) && !_unknownLadderModelWarnings.has(warnKey)) {
      console.warn(
        `Model "${modelId}" specified in default ladder for profile "${profile}" ` +
        `is unknown (not in seed or config models).`
      );
      _unknownLadderModelWarnings.add(warnKey);
    }
  }

  return candidates.map((c) => c.modelId);
}

// ────────────────────────────────────────────────────────────────
// CLI Mode (for bash integration)
// ────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI mode: print registry info
  const registry = loadModelRegistry();
  const profile = process.argv[2] as ModelTaskProfile | undefined;

  if (!profile) {
    console.log('Usage: npx tsx shared/lib/model-registry.ts <profile>');
    console.log('Profiles: routing, planning, coding, review, classify');
    process.exit(1);
  }

  const ladder = getRankedLadder(registry, profile);
  console.log(`Ranked ladder for "${profile}":`);
  ladder.forEach((modelId, idx) => {
    const cap = getCapability(registry, modelId);
    const score = cap?.taskScores[profile] ?? 0;
    console.log(`  ${idx + 1}. ${modelId} (score: ${score.toFixed(2)})`);
  });
}
