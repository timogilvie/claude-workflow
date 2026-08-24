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
import type { EvalRecord, ComplexityBand as TaskComplexityBand, TaskType as EvalTaskType } from './eval-schema.ts';
import { isEvalSuccess } from './eval-success-policy.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { recommendModelLLM } from './llm-router.ts';
import { loadWavemillConfig } from './config.ts';
import { aggregateEvals } from './eval-aggregator.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { errorMessage } from './error-utils.ts';
import { resolveEvalsDir, resolveGlobalAggregatedEvalsPath } from './evals-paths.ts';
import { resolveModelAgent, type AgentResolution, type AgentResolutionPhase } from './model-agent-resolution.ts';
import { formatEvidenceExclusionSummary, isProvisionalModelId, partitionEvidence } from './model-evidence-policy.ts';
import {
  configuredDeepSeekModelIds,
  DEFAULT_MODEL_REGISTRY,
  isDeepSeekLikeModelId,
  ModelValidationError,
  type AgentType,
} from './model-registry.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';
import { analyzeTaskContext, type IssueData, type TaskContextAnalysisInput } from './task-context-analyzer.ts';

// ────────────────────────────────────────────────────────────────
// Task Type Classification
// ────────────────────────────────────────────────────────────────

// Re-export TaskType from eval-schema to unify
export type TaskType = EvalTaskType;

// ────────────────────────────────────────────────────────────────
// Prompt Characteristics
// ────────────────────────────────────────────────────────────────

export interface PromptCharacteristics {
  length: 'short' | 'medium' | 'long';
  charCount: number;
  complexityScore: number;
  taskType: TaskType;
  complexityBand: TaskComplexityBand; // Add complexity band
  // Add more fields from TaskContext as needed for routing decisions
  // For now, keeping it minimal to avoid breaking changes to existing router logic
}

const COMPLEXITY_BAND_SCORES: Record<TaskComplexityBand, number> = {
  xs: 1,
  s: 2,
  m: 3,
  l: 4,
  xl: 5,
};

function firstMeaningfulPromptLine(prompt: string): string | undefined {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) =>
      line.length > 0 &&
      !line.startsWith('##') &&
      !line.startsWith('```') &&
      !line.startsWith('---')
    );
}

function extractIssueFromPrompt(prompt: string): IssueData {
  const headingMatch = prompt.match(/^#\s*(.*?)(?:\s*-\s*Quick Reference)?\s*$/m);
  const labeledTitleMatch = prompt.match(/^(?:title|task|issue):\s*(.+)$/im);
  const title = (headingMatch?.[1] ?? labeledTitleMatch?.[1] ?? firstMeaningfulPromptLine(prompt))?.trim();

  const objectiveSectionMatch = prompt.match(/^##\s+Objective\s*\n+([\s\S]*?)(?=\n##\s+|\s*$)/im);
  const description = objectiveSectionMatch?.[1]?.trim() || prompt;

  return {
    title,
    description,
  };
}

/**
 * Extract characteristics from a prompt for routing decisions.
 * Now uses the task-context-analyzer for unified classification.
 */
export function analyzePrompt(prompt: string, options?: { filesTouched?: number; locTouched?: number }): PromptCharacteristics {
  const charCount = prompt.length;
  const length = charCount < 200 ? 'short' : charCount < 1000 ? 'medium' : 'long';
  const issueData = extractIssueFromPrompt(prompt);

  const analysisInput: TaskContextAnalysisInput = {
    issue: issueData,
    prDiff: '', // Router doesn't have PR diff context
    filesTouched: options?.filesTouched || 0,
    locTouched: options?.locTouched || 0,
  };

  const taskContext = analyzeTaskContext(analysisInput);

  const complexityScore = COMPLEXITY_BAND_SCORES[taskContext.complexity];

  return {
    length,
    charCount,
    complexityScore,
    taskType: taskContext.taskType,
    complexityBand: taskContext.complexity,
  };
}

export function classifyTaskType(prompt: string): TaskType {
  return analyzePrompt(prompt).taskType;
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
  const eligibleRecords = partitionEvidence(records, 'router_history').eligible;
  const byModel = new Map<string, EvalRecord[]>();
  for (const r of eligibleRecords) {
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
        modelRecords.filter((r) => isEvalSuccess(r)).length / modelRecords.length,
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
  agentMap?: Record<string, AgentType>;
  /** Fallback agent when no agentMap match (default: 'claude') */
  defaultAgent?: AgentType;
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
  defaultModel: 'gpt-5.6-terra',
  models: [] as string[],
  agentMap: {} as Record<string, AgentType>,
  defaultAgent: 'codex',
  mode: 'auto' as const,
  repoDir: '',
  repoName: '',
  llmModel: '',
  llmProvider: 'openai' as const,
  kNeighbors: 10,
  backfilledEvalsPath: '.wavemill/evals/aggregated-evals.backfilled.jsonl',
  stageBlendWeight: 0.3,
} satisfies Required<RouterOptions>;

function registryWithAgentOverride(
  modelId: string,
  agentMap: Record<string, AgentType>,
  repoDir?: string,
) {
  const registry = DEFAULT_MODEL_REGISTRY;
  const mappedAgent = agentMap[modelId];
  const registryEntry = registry.models[modelId];
  if (!mappedAgent || !registryEntry || registryEntry.agent === 'native-openai' || registryEntry.agent === 'native-openrouter') {
    return registry;
  }

  return {
    ...registry,
    models: {
      ...registry.models,
      [modelId]: {
        ...registryEntry,
        agent: mappedAgent,
      },
    },
  };
}

function modelResolutionError(
  modelId: string,
  diagnostic: string,
  registry = DEFAULT_MODEL_REGISTRY,
): ModelValidationError {
  if (isDeepSeekLikeModelId(modelId)) {
    const configured = configuredDeepSeekModelIds(registry);
    const configuredList = configured.length > 0
      ? `\n\nConfigured DeepSeek models:\n${configured.map((candidate) => `  • ${candidate}`).join('\n')}`
      : '';
    return new ModelValidationError(
      modelId,
      `Error: Unknown DeepSeek model "${modelId}"${configuredList}`,
    );
  }

  return new ModelValidationError(modelId, diagnostic);
}

export function tryResolveAgent(
  modelId: string,
  agentMap: Record<string, AgentType>,
  _defaultAgent: AgentType,
  repoDir?: string,
  phase: AgentResolutionPhase = 'coding',
): AgentResolution {
  const registry = registryWithAgentOverride(modelId, agentMap, repoDir);
  return resolveModelAgent({
    model: modelId,
    phase,
    repoDir,
    registry,
  });
}

/**
 * Resolve which agent CLI should run a given model.
 *
 * Resolution is registry-authoritative for known models. Explicit agentMap
 * entries are still honored by direct callers, but repository config no longer
 * feeds model membership or routing pools.
 */
export function resolveAgent(
  modelId: string,
  agentMap: Record<string, AgentType>,
  defaultAgent: AgentType,
  repoDir?: string,
  phase: AgentResolutionPhase = 'coding',
): AgentType {
  const result = tryResolveAgent(modelId, agentMap, defaultAgent, repoDir, phase);
  if (result.ok) {
    return result.agent;
  }
  throw modelResolutionError(modelId, result.diagnostic, registryWithAgentOverride(modelId, agentMap, repoDir));
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

  // Resolve the per-repo evals dir against `repoDir`, not the ambient cwd.
  // `readEvalRecords()` with no dir resolves relative to whatever repo the
  // process happens to be running in, so routing for repo A would read repo
  // B's eval history whenever the two differ (worktrees, cross-repo mill runs,
  // tests using a fixture repo).
  const perRepo = readEvalRecords({
    dir: opts.evalsDir || resolveEvalsDir(undefined, repoDir).dir,
  });
  console.error(`Router: Loaded ${perRepo.length} records from per-repo file`);

  // Try loading aggregated cross-repo data:
  // 1. Per-repo aggregated path (worktree-aware, optionally config-overridden)
  // 2. Global wavemill installation aggregated path
  let perRepoAggregatedPath = resolveFromMainRepo('.wavemill/evals/aggregated-evals.jsonl', repoDir);
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.aggregation?.outputPath) {
    perRepoAggregatedPath = resolveFromMainRepo(config.eval.aggregation.outputPath, repoDir);
  }
  const globalAggregatedPath = resolveGlobalAggregatedEvalsPath();
  const candidatePaths = [...new Set([perRepoAggregatedPath, globalAggregatedPath])];

  const seen = new Set(perRepo.map((r) => r.id));
  const merged = [...perRepo];
  let foundAggregatedSource = false;

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      console.error(`Router: Aggregated file not found at ${candidatePath}`);
      continue;
    }

    foundAggregatedSource = true;
    try {
      let aggregatedCount = 0;
      for (const record of readJsonlFile<EvalRecord>(candidatePath)) {
        if (!seen.has(record.id)) {
          seen.add(record.id);
          merged.push(record);
          aggregatedCount++;
        }
      }
      console.error(
        `Router: Loaded ${aggregatedCount} additional records from aggregated file ` +
        `${candidatePath} (${merged.length} total after merge)`
      );
    } catch (error) {
      console.error(`Router: Failed to read aggregated file ${candidatePath}: ${errorMessage(error)}`);
    }
  }

  return foundAggregatedSource ? merged : perRepo;
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

  // Safeguard: If complexity is very low for a large prompt, escalate
  if (characteristics.complexityScore <= 1 && characteristics.charCount > 200) {
    console.error(
      `WARN: Suspiciously low complexity score (${characteristics.complexityScore}) for a large prompt ` +
        `(${characteristics.charCount} chars). Overriding complexity to 's' (score 2) to prevent under-routing.`
    );
    characteristics.complexityScore = 2;
    characteristics.complexityBand = 's';
  }

  // Load eval records (per-repo + aggregated cross-repo data)
  const loadedRecords = loadMergedEvalRecords(opts);
  const evidencePartition = partitionEvidence(loadedRecords, 'router_history');
  const records = evidencePartition.eligible;

  // Count distinct models
  const distinctModels = new Set(records.map((r) => r.modelId));
  const exclusionSummary = formatEvidenceExclusionSummary(evidencePartition.reasonCounts);

  // Log data sufficiency check details
  console.error(
    `Router data check: ${records.length} records (need ${opts.minRecords}), ` +
    `${distinctModels.size} model(s) (need ${opts.minModels})` +
    (evidencePartition.excluded.length > 0
      ? `; excluded ${evidencePartition.excluded.length} held record(s): ${exclusionSummary}`
      : '')
  );

  // Check data sufficiency
  if (records.length < opts.minRecords || distinctModels.size < opts.minModels) {
    return {
      recommendedModel: opts.defaultModel,
      recommendedAgent: resolveAgent(opts.defaultModel, opts.agentMap, opts.defaultAgent, opts.repoDir, 'coding'),
      confidence: 'low',
      reasoning:
        `Insufficient eval data for routing (${records.length} records, ` +
        `${distinctModels.size} model(s)). Need at least ${opts.minRecords} records ` +
        `across ${opts.minModels}+ models. Using default model.` +
        (evidencePartition.excluded.length > 0
          ? ` Excluded held evidence: ${exclusionSummary}.`
          : ''),
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
    const allowedModels = new Set(opts.models.filter((modelId) => !isProvisionalModelId(modelId)));
    modelStats = modelStats.filter((s) => allowedModels.has(s.modelId));
  }

  if (modelStats.length === 0) {
    return {
      recommendedModel: opts.defaultModel,
      recommendedAgent: resolveAgent(opts.defaultModel, opts.agentMap, opts.defaultAgent, opts.repoDir, 'coding'),
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
    recommendedAgent: resolveAgent(best.modelId, opts.agentMap, opts.defaultAgent, opts.repoDir, 'coding'),
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
  filesTouched?: number,
  locTouched?: number,
): ModelRecommendation {
  const opts = { ...DEFAULT_ROUTER_OPTIONS, ...options };
  const characteristics = analyzePrompt(prompt, { filesTouched, locTouched });
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
