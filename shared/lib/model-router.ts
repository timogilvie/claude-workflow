/**
 * Prompt-to-model router — recommends the best LLM for a task based on
 * historical eval data and prompt characteristics.
 *
 * Uses a heuristic approach: classify the task type from the prompt,
 * then compare per-model average scores for that task type across
 * historical eval records.
 *
 * @module model-router
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEvalRecords } from './eval-persistence.ts';
import type { EvalRecord } from './eval-schema.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { recommendModelLLM } from './llm-router.ts';
import { loadWavemillConfig } from './config.ts';
import { aggregateEvals } from './eval-aggregator.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { errorMessage } from './error-utils.ts';
import {
  configuredDeepSeekModelIds,
  DEFAULT_MODEL_REGISTRY,
  getEffectiveRegistry,
  getModel,
  isDeepSeekLikeModelId,
  ModelValidationError,
} from './model-registry.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';

// ────────────────────────────────────────────────────────────────
// Task Type Classification
// ────────────────────────────────────────────────────────────────

export type TaskType =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'test'
  | 'documentation'
  | 'infrastructure'
  | 'unknown';

const TASK_TYPE_PATTERNS: { type: TaskType; patterns: RegExp[] }[] = [
  {
    type: 'bugfix',
    patterns: [
      /\bfix\b/i, /\bbug\b/i, /\bbroken\b/i, /\berror\b/i,
      /\bcrash\b/i, /\bregression\b/i, /\bfailing\b/i,
    ],
  },
  {
    type: 'refactor',
    patterns: [
      /\brefactor\b/i, /\brestructur/i, /\breorganiz/i,
      /\bclean\s*up\b/i, /\bsimplif/i, /\bextract\b/i,
    ],
  },
  {
    type: 'test',
    patterns: [
      /\btest\b/i, /\bspec\b/i, /\bcoverage\b/i,
      /\bassertion\b/i, /\bunit test\b/i, /\be2e\b/i,
    ],
  },
  {
    type: 'documentation',
    patterns: [
      /\bdocument/i, /\breadme\b/i, /\bjsdoc\b/i,
      /\btsdoc\b/i, /\bcomment\b/i, /\bchangelog\b/i,
    ],
  },
  {
    type: 'infrastructure',
    patterns: [
      /\bci\b/i, /\bcd\b/i, /\bdeploy/i, /\bdocker/i,
      /\bpipeline\b/i, /\bmigration\b/i, /\bconfig\b/i,
      /\binfra/i, /\bdevops\b/i,
    ],
  },
  {
    type: 'feature',
    patterns: [
      /\badd\b/i, /\bimplement/i, /\bcreate\b/i, /\bbuild\b/i,
      /\bnew\b/i, /\bintroduc/i, /\bintegrat/i,
    ],
  },
];

/**
 * Classify a prompt into a task type using keyword matching.
 * Returns the first matching type (ordered by specificity).
 */
export function classifyTaskType(prompt: string): TaskType {
  for (const { type, patterns } of TASK_TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(prompt)) {
        return type;
      }
    }
  }
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────
// Prompt Characteristics
// ────────────────────────────────────────────────────────────────

export interface PromptCharacteristics {
  length: 'short' | 'medium' | 'long';
  charCount: number;
  complexityScore: number;
  fileTypes: string[];
  taskType: TaskType;
}

const COMPLEXITY_KEYWORDS = [
  /\bconcurren/i, /\basync\b/i, /\bdistribut/i, /\bsecurity\b/i,
  /\bperformanc/i, /\boptimiz/i, /\bscal/i, /\bcach/i,
  /\bencrypt/i, /\bauthenticat/i, /\bauthoriz/i, /\btransaction/i,
  /\bmulti[- ]?thread/i, /\brace\s+condition/i, /\bdeadlock/i,
  /\breal[- ]?time/i, /\bwebsocket/i, /\bstream/i,
];

const FILE_TYPE_PATTERN = /\.\b(ts|tsx|js|jsx|py|sh|json|yaml|yml|md|css|html|sql|go|rs|rb)\b/gi;

/**
 * Extract characteristics from a prompt for routing decisions.
 */
export function analyzePrompt(prompt: string): PromptCharacteristics {
  const charCount = prompt.length;
  const length = charCount < 200 ? 'short' : charCount < 1000 ? 'medium' : 'long';

  let complexityScore = 0;
  for (const kw of COMPLEXITY_KEYWORDS) {
    if (kw.test(prompt)) complexityScore++;
  }

  const fileTypeMatches = prompt.match(FILE_TYPE_PATTERN) || [];
  const fileTypes = [...new Set(fileTypeMatches.map((m) => m.toLowerCase()))];

  return {
    length,
    charCount,
    complexityScore,
    fileTypes,
    taskType: classifyTaskType(prompt),
  };
}

// ────────────────────────────────────────────────────────────────
// Historical Data Aggregation
// ────────────────────────────────────────────────────────────────

export interface ModelStats {
  modelId: string;
  totalRecords: number;
  taskTypeRecords: number;
  avgScore: number;
  taskTypeAvgScore: number | null;
  successRate: number;
  avgTimeSeconds: number;
  avgInterventionCount: number;
}

/**
 * Aggregate eval records into per-model statistics,
 * optionally filtered by task type.
 */
export function aggregateEvalHistory(
  records: EvalRecord[],
  taskType: TaskType,
): ModelStats[] {
  const byModel = new Map<string, EvalRecord[]>();
  for (const r of records) {
    const list = byModel.get(r.modelId) || [];
    list.push(r);
    byModel.set(r.modelId, list);
  }

  const stats: ModelStats[] = [];
  for (const [modelId, modelRecords] of byModel) {
    const taskTypeRecords = modelRecords.filter(
      (r) => classifyTaskType(r.originalPrompt) === taskType,
    );

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    stats.push({
      modelId,
      totalRecords: modelRecords.length,
      taskTypeRecords: taskTypeRecords.length,
      avgScore: avg(modelRecords.map((r) => r.score)),
      taskTypeAvgScore:
        taskTypeRecords.length > 0
          ? avg(taskTypeRecords.map((r) => r.score))
          : null,
      successRate:
        modelRecords.filter((r) => r.score >= 0.8).length / modelRecords.length,
      avgTimeSeconds: avg(modelRecords.map((r) => r.timeSeconds)),
      avgInterventionCount: avg(modelRecords.map((r) => r.interventionCount)),
    });
  }

  return stats.sort((a, b) => {
    // Sort by task-type avg score (if available), then overall avg score
    const aScore = a.taskTypeAvgScore ?? a.avgScore;
    const bScore = b.taskTypeAvgScore ?? b.avgScore;
    if (bScore !== aScore) return bScore - aScore;
    // Tie-break: fewer interventions, then faster
    if (a.avgInterventionCount !== b.avgInterventionCount)
      return a.avgInterventionCount - b.avgInterventionCount;
    return a.avgTimeSeconds - b.avgTimeSeconds;
  });
}

// ────────────────────────────────────────────────────────────────
// Recommendation Engine
// ────────────────────────────────────────────────────────────────

export interface CandidateScore {
  modelId: string;
  avgScore: number;
  recordCount: number;
  taskTypeRecordCount: number;
  successRate: number;
  avgTimeSeconds: number;
}

export interface ModelRecommendation {
  recommendedModel: string;
  recommendedAgent: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  taskType: TaskType;
  promptCharacteristics: PromptCharacteristics;
  candidates: CandidateScore[];
  insufficientData: boolean;
  /** Risk flags identified by the LLM router (empty/undefined for heuristic mode) */
  riskFlags?: string[];
  /** Expected cost band: "low", "medium", "high", or "unknown" */
  costEstimate?: string;
  /** Which routing mode produced this recommendation */
  routingMode?: 'heuristic' | 'llm';
  /** Runtime-governed resource selections used to produce this recommendation */
  resourceSelections?: RuntimeResourceSelection[];
}

export interface RouterOptions {
  /** Override evals directory */
  evalsDir?: string;
  /** Minimum total eval records before routing is active */
  minRecords?: number;
  /** Minimum distinct models with data before routing is active */
  minModels?: number;
  /** Default model when insufficient data */
  defaultModel?: string;
  /** Candidate model IDs to consider (if set, only these models are scored) */
  models?: string[];
  /** Map of model ID -> agent CLI command (e.g. "claude", "codex") */
  agentMap?: Record<string, string>;
  /** Fallback agent when no agentMap match (default: 'claude') */
  defaultAgent?: string;
  /** Routing mode: 'heuristic' (regex), 'llm' (DSPy artifact), 'stage-aware' (historical KNN), 'hokusai' (ML endpoint), 'auto' (best available) */
  mode?: 'heuristic' | 'llm' | 'auto' | 'stage-aware' | 'hokusai';
  /** Repository directory (for finding artifacts and config) */
  repoDir?: string;
  /** Repository name (for LLM routing context) */
  repoName?: string;
  /** Model to use for the LLM router itself (default: gpt-4o-mini) */
  llmModel?: string;
  /** Provider for the LLM router (default: 'openai') */
  llmProvider?: 'openai' | 'anthropic';
  /** Number of nearest neighbors used by the stage-aware router */
  kNeighbors?: number;
  /** Preferred backfilled aggregated eval dataset path */
  backfilledEvalsPath?: string;
  /** Regularization weight blending stage scores with overall eval score */
  stageBlendWeight?: number;
}

const DEFAULT_ROUTER_OPTIONS = {
  evalsDir: '',
  minRecords: 20,
  minModels: 2,
  defaultModel: 'claude-sonnet-4-6',
  models: [] as string[],
  agentMap: {} as Record<string, string>,
  defaultAgent: 'claude',
  mode: 'auto' as const,
  repoDir: '',
  repoName: '',
  llmModel: '',
  llmProvider: 'openai' as const,
  kNeighbors: 10,
  backfilledEvalsPath: '.wavemill/evals/aggregated-evals.backfilled.jsonl',
  stageBlendWeight: 0.3,
} satisfies Required<RouterOptions>;

/**
 * Resolve which agent CLI should run a given model.
 *
 * Resolution order:
 *   1. Explicit agentMap entry
 *   2. Prefix heuristic (claude- prefix = claude, gpt-/o prefix = codex)
 *   3. defaultAgent fallback
 */
export function resolveAgent(
  modelId: string,
  agentMap: Record<string, string>,
  defaultAgent: string,
  repoDir?: string,
): string {
  if (agentMap[modelId]) return agentMap[modelId];
  const registry = repoDir ? getEffectiveRegistry(repoDir) : DEFAULT_MODEL_REGISTRY;
  const capabilities = getModel(registry, modelId);
  if (capabilities?.agent) return capabilities.agent;
  if (modelId.startsWith('claude-')) return 'claude';
  if (modelId.startsWith('gpt-') || /^o\d/.test(modelId)) return 'codex';
  if (isDeepSeekLikeModelId(modelId)) {
    const configured = configuredDeepSeekModelIds(registry);
    const configuredList = configured.length > 0
      ? `\n\nConfigured DeepSeek models:\n${configured.map((candidate) => `  • ${candidate}`).join('\n')}`
      : '';
    throw new ModelValidationError(
      modelId,
      `Error: Unknown DeepSeek model "${modelId}"${configuredList}`,
    );
  }
  return defaultAgent;
}

/**
 * Load router config from `.wavemill-config.json`.
 */
export function loadRouterConfig(repoDir?: string): RouterOptions {
  const config = loadWavemillConfig(repoDir);
  const r = config.router || {};
  const opts: RouterOptions = {};
  if (r.defaultModel !== undefined) opts.defaultModel = r.defaultModel;
  if (r.minRecords !== undefined) opts.minRecords = r.minRecords;
  if (r.minModels !== undefined) opts.minModels = r.minModels;
  if (r.models !== undefined) opts.models = r.models;
  if (r.agentMap !== undefined) opts.agentMap = r.agentMap;
  if (r.defaultAgent !== undefined) opts.defaultAgent = r.defaultAgent;
  if (r.mode !== undefined) opts.mode = r.mode;
  if (r.llmModel !== undefined) opts.llmModel = r.llmModel;
  if (r.llmProvider !== undefined) opts.llmProvider = r.llmProvider;
  if (r.kNeighbors !== undefined) opts.kNeighbors = r.kNeighbors;
  if (r.backfilledEvalsPath !== undefined) opts.backfilledEvalsPath = r.backfilledEvalsPath;
  if (r.stageBlendWeight !== undefined) opts.stageBlendWeight = r.stageBlendWeight;
  return opts;
}

/**
 * Check if the router is enabled in config.
 * Returns true by default (opt-out, not opt-in).
 */
export function isRouterEnabled(repoDir?: string): boolean {
  const config = loadWavemillConfig(repoDir);
  return config.router?.enabled !== false;
}

// Track whether we've already attempted auto-aggregation (singleton pattern)
const autoAggregationAttempted = new Set<string>();

/**
 * Ensure aggregated eval data exists by auto-aggregating if needed.
 *
 * Checks if the aggregated file exists, and if not, attempts to create it
 * by aggregating data from configured source repos.
 *
 * @param repoDir - Repository directory
 * @returns true if aggregation was performed, false otherwise
 */
function ensureAggregatedData(repoDir: string): boolean {
  // Only attempt aggregation once per repo directory per process
  if (autoAggregationAttempted.has(repoDir)) {
    return false;
  }
  autoAggregationAttempted.add(repoDir);

  try {
    const config = loadWavemillConfig(repoDir);
    const aggregationConfig = config.eval?.aggregation;

    // Check if aggregation is configured
    if (!aggregationConfig?.repos || aggregationConfig.repos.length === 0) {
      return false;
    }

    // Determine aggregated file path
    const aggregatedPath = resolve(
      repoDir,
      aggregationConfig.outputPath || '.wavemill/evals/aggregated-evals.jsonl'
    );

    // If file already exists, no need to aggregate
    if (existsSync(aggregatedPath)) {
      return false;
    }

    // Run aggregation silently
    aggregateEvals({
      repoPaths: aggregationConfig.repos.map((r) => resolve(repoDir, r)),
      outputPath: aggregatedPath,
      deduplicateByHash: true,
      addSourceRepo: true,
    });

    console.error(`Auto-aggregated eval data from ${aggregationConfig.repos.length} repo(s)`);
    return true;
  } catch (error) {
    // Gracefully handle aggregation failures - don't block router
    console.error(`WARN: Auto-aggregation failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Load eval records from per-repo file and optionally merge with the
 * aggregated cross-repo file. Deduplicates by record `id`.
 *
 * Automatically triggers aggregation if the aggregated file is missing
 * but source repos are configured.
 */
function loadMergedEvalRecords(opts: Required<RouterOptions>): EvalRecord[] {
  const repoDir = opts.repoDir || '.';

  // Auto-aggregate if needed
  ensureAggregatedData(repoDir);

  const perRepo = readEvalRecords(
    opts.evalsDir ? { dir: opts.evalsDir } : undefined,
  );
  console.error(`Router: Loaded ${perRepo.length} records from per-repo file`);

  // Try loading aggregated cross-repo data
  // Use worktree-aware resolution for aggregated data path
  let aggregatedPath = resolveFromMainRepo('.wavemill/evals/aggregated-evals.jsonl', repoDir);

  // Check if config overrides the aggregated path
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.aggregation?.outputPath) {
    aggregatedPath = resolveFromMainRepo(config.eval.aggregation.outputPath, repoDir);
  }

  if (!existsSync(aggregatedPath)) {
    console.error(`Router: Aggregated file not found at ${aggregatedPath}`);
    return perRepo;
  }

  try {
    const seen = new Set(perRepo.map((r) => r.id));
    const merged = [...perRepo];
    let aggregatedCount = 0;
    for (const record of readJsonlFile<EvalRecord>(aggregatedPath)) {
      if (!seen.has(record.id)) {
        seen.add(record.id);
        merged.push(record);
        aggregatedCount++;
      }
    }
    console.error(
      `Router: Loaded ${aggregatedCount} additional records from aggregated file ` +
      `(${merged.length} total after merge)`
    );
    return merged;
  } catch (error) {
    console.error(`Router: Failed to read aggregated file: ${errorMessage(error)}`);
    return perRepo;
  }
}

/**
 * Heuristic model recommendation based on regex task classification
 * and historical eval score averages.
 */
function recommendModelHeuristic(
  prompt: string,
  characteristics: PromptCharacteristics,
  opts: Required<RouterOptions>,
): ModelRecommendation {
  const taskType = characteristics.taskType;

  // Load eval records (per-repo + aggregated cross-repo data)
  const records = loadMergedEvalRecords(opts);

  // Count distinct models
  const distinctModels = new Set(records.map((r) => r.modelId));

  // Log data sufficiency check details
  console.error(
    `Router data check: ${records.length} records (need ${opts.minRecords}), ` +
    `${distinctModels.size} model(s) (need ${opts.minModels})`
  );

  // Check data sufficiency
  if (records.length < opts.minRecords || distinctModels.size < opts.minModels) {
    return {
      recommendedModel: opts.defaultModel,
      recommendedAgent: resolveAgent(opts.defaultModel, opts.agentMap, opts.defaultAgent),
      confidence: 'low',
      reasoning:
        `Insufficient eval data for routing (${records.length} records, ` +
        `${distinctModels.size} model(s)). Need at least ${opts.minRecords} records ` +
        `across ${opts.minModels}+ models. Using default model.`,
      taskType,
      promptCharacteristics: characteristics,
      candidates: [],
      insufficientData: true,
      routingMode: 'heuristic',
    };
  }

  // Aggregate history
  let modelStats = aggregateEvalHistory(records, taskType);

  // Filter to candidate models if configured
  if (opts.models && opts.models.length > 0) {
    modelStats = modelStats.filter((s) => opts.models!.includes(s.modelId));
  }

  if (modelStats.length === 0) {
    return {
      recommendedModel: opts.defaultModel,
      recommendedAgent: resolveAgent(opts.defaultModel, opts.agentMap, opts.defaultAgent),
      confidence: 'low',
      reasoning: 'No eval data found for configured candidate models. Using default model.',
      taskType,
      promptCharacteristics: characteristics,
      candidates: [],
      insufficientData: true,
      routingMode: 'heuristic',
    };
  }

  // Build candidate scores
  const candidates: CandidateScore[] = modelStats.map((s) => ({
    modelId: s.modelId,
    avgScore: s.taskTypeAvgScore ?? s.avgScore,
    recordCount: s.totalRecords,
    taskTypeRecordCount: s.taskTypeRecords,
    successRate: s.successRate,
    avgTimeSeconds: s.avgTimeSeconds,
  }));

  const best = modelStats[0];
  const taskTypeCount = best.taskTypeRecords;

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low';
  if (taskTypeCount >= 10) {
    confidence = 'high';
  } else if (taskTypeCount >= 5) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Build reasoning
  const scoreDisplay = (best.taskTypeAvgScore ?? best.avgScore).toFixed(2);
  const dataSource =
    taskTypeCount > 0
      ? `${taskTypeCount} ${taskType} evaluation(s)`
      : `${best.totalRecords} total evaluation(s) (no ${taskType}-specific data)`;

  const reasoning =
    `${best.modelId} has the highest average score (${scoreDisplay}) ` +
    `based on ${dataSource}.` +
    (confidence === 'low'
      ? ' Confidence is low due to limited task-type-specific data.'
      : '');

  return {
    recommendedModel: best.modelId,
    recommendedAgent: resolveAgent(best.modelId, opts.agentMap, opts.defaultAgent),
    confidence,
    reasoning,
    taskType,
    promptCharacteristics: characteristics,
    candidates,
    insufficientData: false,
    routingMode: 'heuristic',
  };
}

/**
 * Recommend the best model for a given prompt.
 *
 * Supports three modes via `options.mode`:
 *   - `'heuristic'`: regex-based classification + historical averages
 *   - `'llm'`: DSPy-optimized Haiku selector (falls back to heuristic on failure)
 *   - `'auto'` (default): try LLM first, fall back silently to heuristic
 */
export function recommendModel(
  prompt: string,
  options?: RouterOptions,
): ModelRecommendation {
  const opts = { ...DEFAULT_ROUTER_OPTIONS, ...options };
  const characteristics = analyzePrompt(prompt);
  const mode = opts.mode || 'auto';

  // Ensure aggregated data exists (runs once per repo dir)
  const repoDir = opts.repoDir || '.';
  ensureAggregatedData(repoDir);

  // Try LLM routing when mode is 'llm' or 'auto'
  if (mode === 'llm' || mode === 'auto') {
    try {
      const llmResult = recommendModelLLM(prompt, characteristics, {
        repoDir: opts.repoDir || undefined,
        repoName: opts.repoName || undefined,
        agentMap: opts.agentMap,
        defaultAgent: opts.defaultAgent,
        models: opts.models?.length ? opts.models : undefined,
        llmModel: opts.llmModel || undefined,
        llmProvider: opts.llmProvider || undefined,
      });
      if (llmResult) return llmResult;
    } catch {
      // LLM routing failed, fall through to heuristic
    }

    if (mode === 'llm') {
      console.error('WARN: LLM router failed, falling back to heuristic');
    }
  }

  // Heuristic fallback
  return recommendModelHeuristic(prompt, characteristics, opts);
}
