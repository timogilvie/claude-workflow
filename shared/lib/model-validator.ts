/**
 * Model validation module - validates model IDs against known models in config.
 *
 * Provides:
 * - Model existence checking (against pricing and agentMap)
 * - Helpful error messages with suggestions
 * - String similarity matching for typo detection
 * - CLI mode for bash integration
 *
 * @module model-validator
 */

import { loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import {
  configuredDeepSeekModelIds,
  DEFAULT_MODEL_REGISTRY,
  getEffectiveRegistry,
  isDeepSeekLikeModelId,
  isKnownModelId,
  type ModelSelector,
  ModelSelectorParseError,
  ModelValidationError,
  parseModelSelector,
  resolveSelector,
  validateModelId,
} from './model-registry.ts';
import { resolveEffectiveModel } from './model-resolution.ts';
import { resolveAgent, tryResolveAgent } from './model-router.ts';
import { readQuotaSnapshot } from './quota-state.ts';

const MODEL_SELECTOR_ACCEPTED_FORMS = 'family alias (for example "opus"), optional channel form (for example "opus:stable"), "inherit", or a pinned model ID (for example "claude-opus-4-7")';

export type ValidatedModelSelectorKind = 'alias' | 'inherit' | 'pinned';

export interface ValidatedModelSelectorToken {
  token: string;
  selector: ModelSelector;
  kind: ValidatedModelSelectorKind;
}

export type SelectorResolutionRole = 'planner' | 'coder' | 'reviewer';

export interface ResolvedModelSelectorToken extends ValidatedModelSelectorToken {
  resolvedModelId: string;
}

function selectorKind(selector: ModelSelector): ValidatedModelSelectorKind {
  if (selector.kind === 'alias' || selector.kind === 'inherit' || selector.kind === 'pinned') {
    return selector.kind;
  }

  const exhaustive: never = selector;
  throw new Error(`Unhandled selector kind: ${JSON.stringify(exhaustive)}`);
}

function formatSelectorValidationError(input: string, message: string): string {
  const trimmed = input.trim();
  const display = trimmed.length > 0 ? trimmed : input;
  return `Error: Invalid model selector "${display}"\n\n${message}\n\nAccepted forms: ${MODEL_SELECTOR_ACCEPTED_FORMS}.`;
}

function mapRoleToTaskType(role: SelectorResolutionRole): 'planning' | 'coding' | 'review' {
  switch (role) {
    case 'planner':
      return 'planning';
    case 'coder':
      return 'coding';
    case 'reviewer':
      return 'review';
    default: {
      const exhaustive: never = role;
      throw new Error(`Unhandled selector resolution role: ${String(exhaustive)}`);
    }
  }
}

function normalizeSelectorValidationError(input: string, error: unknown): Error {
  if (error instanceof ModelSelectorParseError) {
    return new Error(formatSelectorValidationError(input, error.message));
  }

  const message = errorMessage(error);
  return new Error(formatSelectorValidationError(input, message));
}

// ────────────────────────────────────────────────────────────────
// Known Models Discovery
// ────────────────────────────────────────────────────────────────

export interface KnownModelsResult {
  all: string[];
  byAgent: Map<string, string[]>;
}

/**
 * Get all known models from config and the effective registry.
 * Returns models grouped by agent for helpful error messages.
 */
export function getKnownModels(repoDir?: string): KnownModelsResult {
  let config: ReturnType<typeof loadWavemillConfig>;
  try {
    config = loadWavemillConfig(repoDir);
  } catch {
    config = {};
  }
  const registry = getEffectiveRegistry(repoDir);

  const modelSet = new Set<string>();

  for (const modelId of Object.keys(registry.models)) {
    modelSet.add(modelId);
  }

  // Add models from pricing config
  if (config.eval?.pricing) {
    for (const modelId of Object.keys(config.eval.pricing)) {
      modelSet.add(modelId);
    }
  }

  for (const modelId of Object.keys(DEFAULT_MODEL_REGISTRY.models)) {
    modelSet.add(modelId);
  }

  const all = Array.from(modelSet)
    .filter((modelId) => !isDeepSeekLikeModelId(modelId) || isKnownModelId(registry, modelId))
    .sort();

  // Group by agent for display
  const byAgent = new Map<string, string[]>();
  const defaultAgent = config.router?.defaultAgent || 'claude';

  for (const modelId of all) {
    const resolution = tryResolveAgent(modelId, {}, defaultAgent, repoDir, 'coding');
    const agent = resolution.ok ? resolution.agent : 'unroutable';
    const existing = byAgent.get(agent) || [];
    existing.push(modelId);
    byAgent.set(agent, existing);
  }

  return { all, byAgent };
}

/**
 * Check if a model ID is known (exists in config).
 */
export function isValidModel(modelId: string, repoDir?: string): boolean {
  try {
    validateModelId(modelId);
  } catch {
    return false;
  }

  const { all } = getKnownModels(repoDir);
  return all.includes(modelId);
}

// ────────────────────────────────────────────────────────────────
// String Similarity (Levenshtein Distance)
// ────────────────────────────────────────────────────────────────

/**
 * Calculate Levenshtein distance between two strings.
 * Used for finding close matches when a model name is misspelled.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Find the closest matching model IDs using Levenshtein distance.
 * Returns up to 3 suggestions with distance ≤ 5.
 */
export function suggestModel(invalidModel: string, repoDir?: string): string[] {
  const { all } = getKnownModels(repoDir);

  const distances = all.map((modelId) => ({
    modelId,
    distance: levenshteinDistance(invalidModel.toLowerCase(), modelId.toLowerCase()),
  }));

  return distances
    .filter((d) => d.distance <= 5)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((d) => d.modelId);
}

// ────────────────────────────────────────────────────────────────
// Validation with Helpful Errors
// ────────────────────────────────────────────────────────────────

/**
 * Validate a model ID and throw with a helpful error if invalid.
 *
 * Error message includes:
 * - List of all known models (grouped by agent)
 * - Suggestions for similar model names
 */
export function validateModelOrThrow(modelId: string, repoDir?: string): void {
  validateModelId(modelId);

  if (isValidModel(modelId, repoDir)) {
    return;
  }

  const { all, byAgent } = getKnownModels(repoDir);
  const registry = getEffectiveRegistry(repoDir);

  if (isDeepSeekLikeModelId(modelId)) {
    const configured = configuredDeepSeekModelIds(registry);
    let message = `Error: Unknown DeepSeek model "${modelId}"\n\n`;
    if (configured.length > 0) {
      message += 'Configured DeepSeek models:\n';
      for (const candidate of configured) {
        message += `  • ${candidate}\n`;
      }
    } else {
      message += 'No DeepSeek models are configured in the effective registry.\n';
    }
    throw new ModelValidationError(modelId, message);
  }

  // Build error message
  let message = `Error: Unknown model "${modelId}"\n\n`;

  if (all.length === 0) {
    message += 'No models found in the global effective-model projection or eval pricing table.\n';
    message += 'Add models through the global v2 catalog/effective-model projection.\n';
  } else {
    message += 'Known models:\n';

    // Group by agent for clarity
    const agents = Array.from(byAgent.keys()).sort();
    for (const agent of agents) {
      const models = byAgent.get(agent) || [];
      const agentName = agent.charAt(0).toUpperCase() + agent.slice(1);
      message += `  ${agentName} models:\n`;
      for (const model of models) {
        message += `    • ${model}\n`;
      }
    }
  }

  // Add suggestions if we found close matches
  const suggestions = suggestModel(modelId, repoDir);
  if (suggestions.length > 0) {
    message += '\nDid you mean:\n';
    for (const suggestion of suggestions) {
      message += `  • ${suggestion}\n`;
    }
  }

  throw new ModelValidationError(modelId, message);
}

export function validateModelSelectorTokenOrThrow(
  input: string,
  repoDir?: string,
): ValidatedModelSelectorToken {
  const token = input.trim();
  const parsed = parseModelSelector(token);
  if (!parsed.ok) {
    throw normalizeSelectorValidationError(input, parsed.error);
  }

  if (parsed.selector.kind === 'pinned') {
    try {
      validateModelOrThrow(parsed.selector.modelId, repoDir);
    } catch (error) {
      throw normalizeSelectorValidationError(input, error);
    }
  }

  return {
    token,
    selector: parsed.selector,
    kind: selectorKind(parsed.selector),
  };
}

export function resolveModelSelectorTokenOrThrow(
  input: string,
  role: SelectorResolutionRole,
  repoDir?: string,
): ResolvedModelSelectorToken {
  const validated = validateModelSelectorTokenOrThrow(input, repoDir);
  const resolved = validated.selector.kind === 'inherit'
    ? resolveEffectiveModel({
      userOverride: validated.selector,
      policyContext: {
        taskType: mapRoleToTaskType(role),
        difficulty: 'moderate',
        quotaState: readQuotaSnapshot(repoDir),
        repoDir,
      },
    })
    : resolveSelector(validated.selector);

  return {
    ...validated,
    resolvedModelId: resolved.resolved,
  };
}

interface CliArgs {
  mode: 'model' | 'selector' | 'resolve-selector';
  modelOrToken: string;
  repoDir: string;
  role?: SelectorResolutionRole;
}

function parseCliArgs(argv: string[]): CliArgs {
  if (argv.length <= 2) {
    throw new Error(
      'Usage: npx tsx model-validator.ts <model-id> [repo-dir]\n'
      + '   or: npx tsx model-validator.ts --selector-token <selector> [repo-dir]\n'
      + '   or: npx tsx model-validator.ts --resolve-selector-token <selector> --role <planner|coder|reviewer> [repo-dir]',
    );
  }

  const first = argv[2];
  if (first === '--selector-token') {
    const token = argv[3];
    if (!token) {
      throw new Error('Usage: npx tsx model-validator.ts --selector-token <selector> [repo-dir]');
    }
    return {
      mode: 'selector',
      modelOrToken: token,
      repoDir: argv[4] || process.cwd(),
    };
  }

  if (first === '--resolve-selector-token') {
    const token = argv[3];
    if (!token) {
      throw new Error('Usage: npx tsx model-validator.ts --resolve-selector-token <selector> --role <planner|coder|reviewer> [repo-dir]');
    }

    let role: SelectorResolutionRole | undefined;
    let repoDir = process.cwd();
    for (let index = 4; index < argv.length; index += 1) {
      const current = argv[index];
      if (current === '--role') {
        const rawRole = argv[index + 1];
        if (rawRole !== 'planner' && rawRole !== 'coder' && rawRole !== 'reviewer') {
          throw new Error(`Invalid --role "${rawRole ?? ''}". Expected planner, coder, or reviewer.`);
        }
        role = rawRole;
        index += 1;
        continue;
      }

      repoDir = current;
    }

    if (!role) {
      throw new Error('Usage: npx tsx model-validator.ts --resolve-selector-token <selector> --role <planner|coder|reviewer> [repo-dir]');
    }

    return {
      mode: 'resolve-selector',
      modelOrToken: token,
      role,
      repoDir,
    };
  }

  return {
    mode: 'model',
    modelOrToken: first,
    repoDir: argv[3] || process.cwd(),
  };
}

// ────────────────────────────────────────────────────────────────
// CLI Mode (for bash integration)
// ────────────────────────────────────────────────────────────────

/**
 * CLI mode: validate a model and exit with status code.
 * Usage: npx tsx model-validator.ts <model-id> [repo-dir]
 * Exits 0 if valid, 1 if invalid (with error message on stderr)
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cli = parseCliArgs(process.argv);
    if (cli.mode === 'model') {
      validateModelOrThrow(cli.modelOrToken, cli.repoDir);
    } else if (cli.mode === 'selector') {
      const validated = validateModelSelectorTokenOrThrow(cli.modelOrToken, cli.repoDir);
      process.stdout.write(`${validated.token}\n`);
    } else {
      const resolved = resolveModelSelectorTokenOrThrow(cli.modelOrToken, cli.role!, cli.repoDir);
      process.stdout.write(`${resolved.resolvedModelId}\n`);
    }
    process.exit(0);
  } catch (err) {
    const message = errorMessage(err);
    console.error(message);
    process.exit(1);
  }
}
