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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEvalRecords } from './eval-persistence.ts';
import type { EvalRecord } from './eval-schema.ts';

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
}

const DEFAULT_ROUTER_OPTIONS: Required<RouterOptions> = {
  evalsDir: '',
  minRecords: 20,
  minModels: 2,
  defaultModel: 'claude-sonnet-4-5-20250929',
  models: [],
  agentMap: {},
  defaultAgent: 'claude',
};

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
): string {
  if (agentMap[modelId]) return agentMap[modelId];
  if (modelId.startsWith('claude-')) return 'claude';
  if (modelId.startsWith('gpt-') || /^o\d/.test(modelId)) return 'codex';
  return defaultAgent;
}

/**
 * Load router config from `.wavemill-config.json`.
 */
export function loadRouterConfig(repoDir?: string): RouterOptions {
  const configPath = resolve(repoDir || '.', '.wavemill-config.json');
  if (!existsSync(configPath)) return {};

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const r = config.router || {};
    const opts: RouterOptions = {};
    if (r.defaultModel !== undefined) opts.defaultModel = r.defaultModel;
    if (r.minRecords !== undefined) opts.minRecords = r.minRecords;
    if (r.minModels !== undefined) opts.minModels = r.minModels;
    if (r.models !== undefined) opts.models = r.models;
    if (r.agentMap !== undefined) opts.agentMap = r.agentMap;
    if (r.defaultAgent !== undefined) opts.defaultAgent = r.defaultAgent;
    return opts;
  } catch {
    return {};
  }
}

/**
 * Check if the router is enabled in config.
 * Returns true by default (opt-out, not opt-in).
 */
export function isRouterEnabled(repoDir?: string): boolean {
  const configPath = resolve(repoDir || '.', '.wavemill-config.json');
  if (!existsSync(configPath)) return true;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.router?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Recommend the best model for a given prompt based on historical eval data.
 *
 * When insufficient data exists (below minRecords or minModels thresholds),
 * returns the default model with `insufficientData: true`.
 */
export function recommendModel(
  prompt: string,
  options?: RouterOptions,
): ModelRecommendation {
  const opts = { ...DEFAULT_ROUTER_OPTIONS, ...options };
  const characteristics = analyzePrompt(prompt);
  const taskType = characteristics.taskType;

  // Load eval records
  const records = readEvalRecords(
    opts.evalsDir ? { dir: opts.evalsDir } : undefined,
  );

  // Count distinct models
  const distinctModels = new Set(records.map((r) => r.modelId));

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
  };
}
