/**
 * Task descriptor builder for router training.
 *
 * Derives generalizable task features from eval context without LLM calls.
 * All derivation is deterministic and privacy-safe (no repo names, issue IDs,
 * or code snippets).
 *
 * @module task-descriptor-builder
 */

import type {
  TaskDescriptor,
  HeuristicSignals,
  LearnedSignals,
  DescriptorConstraints,
  StageDescriptor,
  DescriptorOutcome,
  RubricDescriptorFeatures,
  TaskContext,
  RepoContext,
  DifficultySignals,
  RoutingDecision,
  StageOutcomes,
  ComplexityBand,
  InterventionRecord,
  RubricEval,
  RubricProvenance,
} from './eval-schema.ts';
import type { RoutingCompleteData } from './eval-context-gatherer.ts';

// SCHEMA CHANGELOG: 2026.04 — Added rubricFeatures block (HOK-1409)
export const DESCRIPTOR_FEATURE_SET_VERSION = '2026.04';

// ────────────────────────────────────────────────────────────────
// Input Types
// ────────────────────────────────────────────────────────────────

/**
 * Input data for building a task descriptor.
 *
 * Aggregates all context needed to derive heuristic signals, learned signals,
 * constraints, and outcomes. Most fields are optional to support partial
 * descriptor creation (e.g., pre-eval routing input vs post-eval training label).
 */
export interface TaskDescriptorInput {
  // ── Core task data ──
  /** The task prompt given to the agent */
  originalPrompt: string;
  /** PR diff output (git diff) */
  prDiff?: string;

  // ── From existing analyzers ──
  /** Task context from task-context-analyzer */
  taskContext?: TaskContext;
  /** Repository context from repo-context-analyzer */
  repoContext?: RepoContext;
  /** Difficulty signals from difficulty-analyzer */
  difficultySignals?: DifficultySignals;

  // ── From routing ──
  /** Routing decision metadata */
  routingDecision?: RoutingDecision;
  /** Raw .routing-complete data with per-stage model assignments */
  routingComplete?: RoutingCompleteData;

  // ── From eval results (post-eval only) ──
  /** Per-stage quality scores from eval judge */
  stageOutcomes?: StageOutcomes;
  /** Total workflow cost in USD */
  workflowCost?: number;
  /** Per-model token usage breakdown */
  workflowTokenUsage?: Record<
    string,
    {
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  >;
  /** Overall eval score 0-1 */
  score?: number;
  /** Total workflow time in seconds */
  timeSeconds?: number;
  /** Number of human interventions */
  interventionCount?: number;
  /** Structured intervention records */
  interventions?: InterventionRecord[];
  /** Structured rubric criteria evaluation from the eval judge (HOK-1406) */
  rubricEval?: RubricEval;
  /** Provenance of rubric metadata (HOK-1408) */
  rubricProvenance?: RubricProvenance;

  // ── Config ──
  /** Models available for routing consideration */
  modelsAvailable?: string[];
  /** Routing objective (max_success, min_cost, balanced) */
  objective?: 'max_success' | 'min_cost' | 'balanced';
  /** Maximum cost budget in USD */
  maxCostUsd?: number;
  /** Maximum time budget in minutes */
  maxTimeMinutes?: number;
}

// ────────────────────────────────────────────────────────────────
// Heuristic Signal Derivation
// ────────────────────────────────────────────────────────────────

/**
 * Estimate token count from string.
 *
 * Uses rough heuristic: 1 token ≈ 4 characters.
 * Good enough for feature extraction; not for billing.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Detect migration keywords in prompt.
 *
 * Keywords: migration, alembic, prisma migrate, schema change, ALTER TABLE
 */
function hasMigration(prompt: string): boolean {
  const keywords = [
    /\bmigration\b/i,
    /\balembic\b/i,
    /\bprisma\s+migrate\b/i,
    /\bschema\s+change\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bCREATE\s+TABLE\b/i,
    /\bDROP\s+TABLE\b/i,
  ];
  return keywords.some((pattern) => pattern.test(prompt));
}

/**
 * Detect UI keywords in prompt or languages.
 *
 * Keywords: component, page, UI, CSS, frontend, React, Vue, Angular, Svelte
 * File extensions: .tsx, .jsx, .vue, .svelte
 */
function hasUI(prompt: string, languages: string[]): boolean {
  const keywords = [
    /\bcomponent\b/i,
    /\bpage\b/i,
    /\bUI\b/,
    /\bCSS\b/,
    /\bfrontend\b/i,
    /\bReact\b/,
    /\bVue\b/,
    /\bAngular\b/,
    /\bSvelte\b/,
    /\bTailwind\b/i,
  ];
  const hasKeyword = keywords.some((pattern) => pattern.test(prompt));
  const hasUILanguage = languages.some((lang) =>
    /^(tsx|jsx|vue|svelte)$/i.test(lang),
  );
  return hasKeyword || hasUILanguage;
}

/**
 * Detect test keywords in prompt or diff.
 *
 * Keywords: test, spec, coverage, jest, vitest, mocha, pytest
 * File patterns: .test., .spec., __tests__/
 */
function hasTests(prompt: string, diff?: string): boolean {
  const keywords = [
    /\btests?\b/i, // matches "test" or "tests"
    /\bspecs?\b/i, // matches "spec" or "specs"
    /\bcoverage\b/i,
    /\bjest\b/i,
    /\bvitest\b/i,
    /\bmocha\b/i,
    /\bpytest\b/i,
  ];
  const hasKeyword = keywords.some((pattern) => pattern.test(prompt));
  if (hasKeyword) return true;

  if (diff) {
    const testFilePatterns = [/\.test\./i, /\.spec\./i, /__tests__\//i];
    return testFilePatterns.some((pattern) => pattern.test(diff));
  }

  return false;
}

/**
 * Detect cross-service keywords in prompt.
 *
 * Keywords: cross-repo, multi-service, microservice, service-to-service
 */
function isCrossService(prompt: string): boolean {
  const keywords = [
    /\bcross-repo\b/i,
    /\bmulti-service\b/i,
    /\bmicroservice\b/i,
    /\bservice-to-service\b/i,
    /\bcross-service\b/i,
  ];
  return keywords.some((pattern) => pattern.test(prompt));
}

/**
 * Derive heuristic signals from input data.
 *
 * All signals are deterministic and privacy-safe. No LLM calls.
 */
function deriveHeuristicSignals(input: TaskDescriptorInput): HeuristicSignals {
  const {
    originalPrompt,
    prDiff,
    taskContext,
    repoContext,
    difficultySignals,
  } = input;

  // Extract languages from repoContext
  const languages = repoContext?.languages
    ? Object.keys(repoContext.languages).map((lang) => lang.toLowerCase())
    : [];

  // Extract frameworks from repoContext
  const frameworkTags = repoContext?.frameworks
    ? repoContext.frameworks.map((fw) => fw.toLowerCase())
    : [];

  return {
    task_type: taskContext?.taskType || 'feature',
    languages,
    framework_tags: frameworkTags,
    files_touched: difficultySignals?.filesTouched || 0,
    repo_size_loc: repoContext?.repoSize?.loc || 0,
    description_tokens: estimateTokens(originalPrompt),
    is_greenfield: taskContext?.changeKind === 'create_new',
    has_migration: hasMigration(originalPrompt),
    has_ui: hasUI(originalPrompt, languages),
    has_tests: hasTests(originalPrompt, prDiff),
    cross_service: isCrossService(originalPrompt),
  };
}

// ────────────────────────────────────────────────────────────────
// Learned Signal Derivation
// ────────────────────────────────────────────────────────────────

/**
 * Map complexity band to numeric 1-5 scale.
 *
 * xs → 1, s → 2, m → 3, l → 4, xl → 5
 * If numeric, round to 1-5 range.
 */
function mapComplexity(complexity: number | ComplexityBand | undefined): number {
  if (!complexity) return 3; // default to medium

  if (typeof complexity === 'number') {
    // Already numeric (0-1 scale), map to 1-5
    return Math.max(1, Math.min(5, Math.round(complexity * 5)));
  }

  // Map band to numeric
  const bandMap: Record<ComplexityBand, number> = {
    xs: 1,
    s: 2,
    m: 3,
    l: 4,
    xl: 5,
  };
  return bandMap[complexity] || 3;
}

/**
 * Classify domain from frameworks, languages, and task description.
 *
 * Domains: frontend, backend, data-pipeline, infrastructure, devtools, full-stack
 * Uses keyword-based heuristics (initial version; can be upgraded to LLM later).
 */
function classifyDomain(
  prompt: string,
  frameworks: string[],
  languages: string[],
): string {
  const frontendKeywords = [
    /\breact\b/i,
    /\bvue\b/i,
    /\bangular\b/i,
    /\bsvelte\b/i,
    /\btailwind\b/i,
    /\bcomponent\b/i,
    /\bpage\b/i,
    /\bUI\b/,
    /\bCSS\b/,
  ];
  const backendKeywords = [
    /\bexpress\b/i,
    /\bfastapi\b/i,
    /\bdjango\b/i,
    /\bflask\b/i,
    /\bAPI\b/,
    /\bendpoint\b/i,
    /\bserver\b/i,
    /\bdatabase\b/i,
  ];
  const dataKeywords = [
    /\bETL\b/,
    /\bpipeline\b/i,
    /\bstream\b/i,
    /\bkafka\b/i,
    /\btransformation\b/i,
    /\bdata\b/i,
  ];
  const infraKeywords = [
    /\bdocker\b/i,
    /\bk8s\b/i,
    /\bkubernetes\b/i,
    /\bCI\/CD\b/i,
    /\bdeploy\b/i,
    /\bterraform\b/i,
    /\bAWS\b/,
    /\bGCP\b/,
  ];
  const devtoolsKeywords = [
    /\bCLI\b/,
    /\bplugin\b/i,
    /\bextension\b/i,
    /\bdeveloper\s+tools\b/i,
    /\blint\b/i,
    /\bformatter\b/i,
  ];

  const hasFrontend =
    frontendKeywords.some((kw) => kw.test(prompt)) ||
    frameworks.some((fw) =>
      /^(react|vue|angular|svelte|nextjs|nuxt|tailwind)$/i.test(fw),
    );
  const hasBackend =
    backendKeywords.some((kw) => kw.test(prompt)) ||
    frameworks.some((fw) =>
      /^(express|fastapi|django|flask|nestjs|spring)$/i.test(fw),
    );
  const hasData = dataKeywords.some((kw) => kw.test(prompt));
  const hasInfra = infraKeywords.some((kw) => kw.test(prompt));
  const hasDevtools = devtoolsKeywords.some((kw) => kw.test(prompt));

  // Full-stack if both frontend and backend
  if (hasFrontend && hasBackend) return 'full-stack';

  // Otherwise, return the most specific match
  if (hasFrontend) return 'frontend';
  if (hasBackend) return 'backend';
  if (hasData) return 'data-pipeline';
  if (hasInfra) return 'infrastructure';
  if (hasDevtools) return 'devtools';

  // Default to backend if unclear
  return 'backend';
}

/**
 * Extract risk flags from prompt.
 *
 * Ports patterns from prepare_data.py:
 * - modifies-existing-runtime
 * - schema-migration
 * - large-scope-refactor
 * - cross-service
 * - rsc-serialization
 * - test-infrastructure
 */
function extractRiskFlags(
  prompt: string,
  filesTouched: number,
): string[] {
  const flags: string[] = [];

  // modifies-existing-runtime
  if (
    /\bmodify\b/i.test(prompt) &&
    (/\bruntime\b/i.test(prompt) || /\bproduction\b/i.test(prompt))
  ) {
    flags.push('modifies-existing-runtime');
  }

  // schema-migration
  if (hasMigration(prompt)) {
    flags.push('schema-migration');
  }

  // large-scope-refactor (>10 files or "refactor" keyword)
  if (filesTouched > 10 || /\brefactor\b/i.test(prompt)) {
    flags.push('large-scope-refactor');
  }

  // cross-service
  if (isCrossService(prompt)) {
    flags.push('cross-service');
  }

  // rsc-serialization (React Server Components)
  if (/\bRSC\b/.test(prompt) || /\bserver\s+component\b/i.test(prompt)) {
    flags.push('rsc-serialization');
  }

  // test-infrastructure
  if (
    /\btest\b/i.test(prompt) &&
    (/\binfrastructure\b/i.test(prompt) || /\bCI\b/.test(prompt))
  ) {
    flags.push('test-infrastructure');
  }

  return flags;
}

/**
 * Derive learned signals from input data.
 *
 * Uses heuristic classifiers for initial version. Can be upgraded to
 * LLM-based or embedding-based classifiers later.
 */
function deriveLearnedSignals(input: TaskDescriptorInput): LearnedSignals {
  const { originalPrompt, taskContext, repoContext, difficultySignals } = input;

  const complexity = mapComplexity(taskContext?.complexity);
  const frameworks = repoContext?.frameworks || [];
  const languages = repoContext?.languages
    ? Object.keys(repoContext.languages).map((lang) => lang.toLowerCase())
    : [];
  const domain = classifyDomain(originalPrompt, frameworks, languages);
  const riskFlags = extractRiskFlags(
    originalPrompt,
    difficultySignals?.filesTouched || 0,
  );

  return {
    complexity,
    domain,
    risk_flags: riskFlags,
    // embedding_id is omitted (undefined) for now
  };
}

/**
 * Derive rubric descriptor features from eval rubric data.
 *
 * Returns undefined when no valid rubric data is present (legacy path).
 * Maps the fixed RubricCriteria fields to dimension scores.
 */
function deriveRubricFeatures(
  rubricEval?: RubricEval,
  rubricProvenance?: RubricProvenance,
): RubricDescriptorFeatures | undefined {
  if (!rubricEval || rubricProvenance === 'legacy_absent') {
    return undefined;
  }

  const dimensionScores: Record<string, number> = {};
  const dimensionCounts: Record<string, number> = {};

  for (const [key, val] of Object.entries(rubricEval.criteria)) {
    if (val && typeof val.score === 'number' && !Number.isNaN(val.score)) {
      dimensionScores[key] = val.score;
      dimensionCounts[key] = 1;
    }
  }

  if (Object.keys(dimensionScores).length === 0) {
    return undefined;
  }

  const scores = Object.values(dimensionScores);
  const overallMean = scores.reduce((sum, score) => sum + score, 0) / scores.length;

  return {
    present: true,
    dimensionScores,
    dimensionCounts,
    overallMean: Number(overallMean.toFixed(4)),
    rubricSchemaVersion: rubricEval.rubric_version,
    rubricProvenance,
    determinativeBoundary: rubricEval.determinative_boundary,
  };
}

// ────────────────────────────────────────────────────────────────
// Constraints Derivation
// ────────────────────────────────────────────────────────────────

/**
 * Derive constraints from config and defaults.
 */
function deriveConstraints(input: TaskDescriptorInput): DescriptorConstraints {
  return {
    max_cost_usd: input.maxCostUsd,
    max_time_minutes: input.maxTimeMinutes,
    models_available: input.modelsAvailable || [],
    objective: input.objective || 'balanced',
  };
}

// ────────────────────────────────────────────────────────────────
// Per-Stage Derivation
// ────────────────────────────────────────────────────────────────

/**
 * Derive per-stage descriptors from routing and eval data.
 *
 * Combines:
 * - Model assignments from .routing-complete
 * - Quality scores from stageOutcomes
 * - Cost from workflowTokenUsage (per-model breakdown)
 * - Time from stage timing (if available)
 *
 * For cost: if stages share a model, we can't perfectly split costs.
 * Use proportional split or leave as undefined.
 */
function deriveStages(
  input: TaskDescriptorInput,
): Record<string, StageDescriptor> {
  const stages: Record<string, StageDescriptor> = {};
  const routingComplete = input.routingComplete;

  if (!routingComplete) {
    return stages; // No routing data available
  }

  // Map stage names from .routing-complete to descriptor
  const stageMap: Record<
    string,
    { outcomeKey: keyof StageOutcomes; modelKey: keyof RoutingCompleteData }
  > = {
    planner: { outcomeKey: 'plan', modelKey: 'planner' },
    coder: { outcomeKey: 'implementation', modelKey: 'coder' },
    reviewer: { outcomeKey: 'review', modelKey: 'reviewer' },
  };

  for (const [stageName, config] of Object.entries(stageMap)) {
    const modelId = routingComplete[config.modelKey];
    if (!modelId || typeof modelId !== 'string') continue;

    const stageDescriptor: StageDescriptor = { model: modelId };

    // Add quality score if available
    if (input.stageOutcomes?.[config.outcomeKey]) {
      stageDescriptor.score = input.stageOutcomes[config.outcomeKey]?.score;
    }

    // Add cost if available (from workflowTokenUsage)
    if (input.workflowTokenUsage?.[modelId]) {
      stageDescriptor.cost_usd = input.workflowTokenUsage[modelId].costUsd;
    }

    // Time is not currently tracked per-stage, leave undefined
    // Future: add stage timing from workflow-router.ts

    stages[stageName] = stageDescriptor;
  }

  return stages;
}

// ────────────────────────────────────────────────────────────────
// Outcome Derivation
// ────────────────────────────────────────────────────────────────

/**
 * Derive overall outcome from eval results.
 *
 * Only populated post-eval (null for pre-eval routing input).
 */
function deriveOutcome(
  input: TaskDescriptorInput,
): DescriptorOutcome | undefined {
  if (input.score === undefined) {
    return undefined; // Pre-eval, outcome not available
  }

  // Extract intervention types from structured records
  const interventionTypes = input.interventions
    ? Array.from(new Set(input.interventions.map((i) => i.type)))
    : [];

  return {
    overall_score: input.score,
    total_cost_usd: input.workflowCost,
    total_time_minutes: input.timeSeconds ? input.timeSeconds / 60 : undefined,
    interventions: input.interventionCount || 0,
    intervention_types: interventionTypes,
  };
}

// ────────────────────────────────────────────────────────────────
// Main Builder
// ────────────────────────────────────────────────────────────────

/**
 * Build a task descriptor from input data.
 *
 * Derives heuristic signals, learned signals, constraints, per-stage
 * descriptors, and outcome (if post-eval) from the provided context.
 *
 * @param input - Aggregated context from eval pipeline
 * @returns Complete task descriptor ready for router training
 */
export function buildTaskDescriptor(
  input: TaskDescriptorInput,
): TaskDescriptor {
  const rubricFeatures = deriveRubricFeatures(
    input.rubricEval,
    input.rubricProvenance,
  );

  return {
    schema_version: '1.0',
    descriptorFeatureSetVersion: DESCRIPTOR_FEATURE_SET_VERSION,
    signals: {
      heuristic: deriveHeuristicSignals(input),
      learned: deriveLearnedSignals(input),
    },
    constraints: deriveConstraints(input),
    stages: deriveStages(input),
    outcome: deriveOutcome(input),
    ...(rubricFeatures !== undefined ? { rubricFeatures } : {}),
  };
}
