/**
 * Stage-aware workflow router.
 *
 * Uses nearest-neighbor lookup over historical eval records to recommend
 * per-stage models without making any LLM calls in the routing path.
 *
 * @module stage-aware-router
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalRecord, TaskDescriptor, StageOutcomes } from './eval-schema.ts';
import { buildTaskDescriptor, type TaskDescriptorInput } from './task-descriptor-builder.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { computeModelCost, loadPricingTable } from './workflow-cost.ts';
import type { WorkflowRouteDecision, PlanDepth, CodeDepth, ReviewMode } from './workflow-router.ts';
import { getAvailableModelsForStage, getRouterConfig } from './config.ts';
import { filterDeepSeekModels } from './deepseek-provider.ts';
import { getConfiguredModelsForDescriptor } from './model-registry.ts';

export interface StageAwareConstraints {
  modelsAvailable?: string[];
  plannerModelsAvailable?: string[];
  coderModelsAvailable?: string[];
  reviewerModelsAvailable?: string[];
  maxCostUsd?: number;
}

export interface StageAwareOptions extends StageAwareConstraints {
  repoDir?: string;
  kNeighbors?: number;
  minRecords?: number;
  minModels?: number;
  backfilledEvalsPath?: string;
  aggregatedEvalsPath?: string;
  additionalEvalsPaths?: string[];
  stageBlendWeight?: number;
  queryInput?: Partial<TaskDescriptorInput>;
}

export interface StageAwareDecision extends WorkflowRouteDecision {
  routingMode: 'stage-aware' | 'stage-aware-partial' | 'heuristic-fallback' | 'hokusai' | 'policy';
  neighborCount: number;
  neighborSimilarityRange: [number, number];
  expectedCost: number;
  shadowDecision?: StageAwareDecision | null;
}

export interface StageAwareRouterContext {
  repoDir: string;
  routerConfig: ReturnType<typeof getRouterConfig>;
  records: EvalRecord[];
}

export interface ScoredNeighbor {
  record: EvalRecord;
  descriptor: TaskDescriptor;
  similarity: number;
}

interface ModelStageStats {
  modelId: string;
  score: number;
  cost: number;
  support: number;
}

interface RoleRanking {
  role: 'planner' | 'coder' | 'reviewer';
  stageKey: 'plan' | 'implementation' | 'review';
  candidates: ModelStageStats[];
}

interface CombinationDecision {
  planner: ModelStageStats;
  coder: ModelStageStats;
  reviewer: ModelStageStats;
  expectedCost: number;
  expectedSuccess: number;
}

interface HistoricalEvalSource {
  path: string;
  kind: 'local' | 'backfilled' | 'aggregated';
  priority: number;
}

const TASK_TYPE_DIMENSIONS = ['bugfix', 'feature', 'refactor', 'chore', 'docs', 'test', 'infra'] as const;
const LANGUAGE_DIMENSIONS = ['ts', 'js', 'py', 'go', 'rs', 'sh', 'sql', 'other'] as const;
const DOMAIN_DIMENSIONS = ['frontend', 'backend', 'data-pipeline', 'infrastructure', 'devtools', 'full-stack'] as const;
const DEFAULT_BACKFILLED_EVALS_PATH = '.wavemill/evals/aggregated-evals.backfilled.jsonl';
const DEFAULT_AGGREGATED_EVALS_PATH = '.wavemill/evals/aggregated-evals.jsonl';
const DEFAULT_K_NEIGHBORS = 20;
const DEFAULT_MIN_RECORDS = 20;
const DEFAULT_MIN_MODELS = 2;
const DEFAULT_STAGE_BLEND_WEIGHT = 0.3;
const DEFAULT_RUBRIC_AWARE_MIN_COVERAGE = 0.3;
const DEFAULT_RUBRIC_AWARE_WEIGHT = 0.3;
const stageAwareRouterDebugState = {
  evalLoadCount: 0,
};

export function resetStageAwareRouterDebugState(): void {
  stageAwareRouterDebugState.evalLoadCount = 0;
}

export function getStageAwareRouterDebugState(): { evalLoadCount: number } {
  return { ...stageAwareRouterDebugState };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLogValue(value: number): number {
  return clamp(Math.log1p(Math.max(0, value)) / 10, 0, 1);
}

function normalizeLanguage(language: string): string {
  const lower = language.toLowerCase();
  if (lower === 'typescript' || lower === 'tsx' || lower === 'ts') return 'ts';
  if (lower === 'javascript' || lower === 'jsx' || lower === 'js') return 'js';
  if (lower === 'python' || lower === 'py') return 'py';
  if (lower === 'golang' || lower === 'go') return 'go';
  if (lower === 'rust' || lower === 'rs') return 'rs';
  if (lower === 'shell' || lower === 'bash' || lower === 'zsh' || lower === 'sh') return 'sh';
  if (lower === 'postgresql' || lower === 'mysql' || lower === 'sqlite' || lower === 'sql') return 'sql';
  return 'other';
}

function normalizeDomain(domain: string | undefined): string {
  return DOMAIN_DIMENSIONS.includes((domain || '') as typeof DOMAIN_DIMENSIONS[number])
    ? (domain as typeof DOMAIN_DIMENSIONS[number])
    : 'backend';
}

export function vectorizeDescriptor(descriptor: TaskDescriptor): number[] {
  const heuristic = descriptor.signals.heuristic;
  const learned = descriptor.signals.learned;
  const taskType = heuristic.task_type;
  const languages = new Set(heuristic.languages.map(normalizeLanguage));
  const domain = normalizeDomain(learned.domain);

  return [
    ...TASK_TYPE_DIMENSIONS.map((candidate) => Number(taskType === candidate)),
    ...LANGUAGE_DIMENSIONS.map((candidate) => Number(languages.has(candidate))),
    ...DOMAIN_DIMENSIONS.map((candidate) => Number(domain === candidate)),
    clamp((learned.complexity || 3) / 5, 0, 1),
    normalizeLogValue(heuristic.files_touched),
    normalizeLogValue(heuristic.repo_size_loc),
    normalizeLogValue(heuristic.description_tokens),
    Number(Boolean(heuristic.is_greenfield)),
    Number(Boolean(heuristic.has_migration)),
    Number(Boolean(heuristic.has_ui)),
    Number(Boolean(heuristic.has_tests)),
    Number(Boolean(heuristic.cross_service)),
    clamp((learned.risk_flags?.length || 0) / 6, 0, 1),
  ];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), 0, 1);
}

const descriptorCache = new Map<string, TaskDescriptor>();

function isTaskDescriptor(value: unknown): value is TaskDescriptor {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as TaskDescriptor).schema_version === '1.0' &&
    (value as TaskDescriptor).signals?.heuristic &&
    (value as TaskDescriptor).signals?.learned
  );
}

export function descriptorFromEvalRecord(record: EvalRecord): TaskDescriptor {
  const cached = descriptorCache.get(record.id);
  if (cached) {
    return cached;
  }

  const descriptor = isTaskDescriptor(record.taskDescriptor)
    ? record.taskDescriptor
    : buildTaskDescriptor({
        originalPrompt: record.originalPrompt,
        taskContext: record.taskContext,
        repoContext: record.repoContext,
        difficultySignals: record.difficultySignals,
        routingDecision: record.routingDecision,
        stageOutcomes: record.stageOutcomes,
        workflowCost: record.workflowCost,
        workflowTokenUsage: record.workflowTokenUsage,
        score: record.score,
        timeSeconds: record.timeSeconds,
        interventionCount: record.interventionCount,
        interventions: record.interventions,
        rubricEval: record.rubricEval,
      });

  descriptorCache.set(record.id, descriptor);
  return descriptor;
}

export function findKNearest(
  queryDescriptor: TaskDescriptor,
  records: EvalRecord[],
  k: number,
): ScoredNeighbor[] {
  if (records.length === 0 || k <= 0) {
    return [];
  }

  const queryVector = vectorizeDescriptor(queryDescriptor);

  return records
    .map((record) => {
      const descriptor = descriptorFromEvalRecord(record);
      return {
        record,
        descriptor,
        similarity: cosineSimilarity(queryVector, vectorizeDescriptor(descriptor)),
      } satisfies ScoredNeighbor;
    })
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.min(k, records.length));
}

function getHistoricalSources(repoDir: string, options: StageAwareOptions): HistoricalEvalSource[] {
  const sources: HistoricalEvalSource[] = [
    {
      path: resolve(repoDir, '.wavemill/evals/evals.jsonl'),
      kind: 'local',
      priority: 3,
    },
    {
      path: resolveFromMainRepo(options.backfilledEvalsPath || DEFAULT_BACKFILLED_EVALS_PATH, repoDir),
      kind: 'backfilled',
      priority: 2,
    },
    {
      path: resolveFromMainRepo(options.aggregatedEvalsPath || DEFAULT_AGGREGATED_EVALS_PATH, repoDir),
      kind: 'aggregated',
      priority: 1,
    },
  ];

  if (options.additionalEvalsPaths) {
    for (const additionalPath of options.additionalEvalsPaths) {
      sources.push({
        path: additionalPath,
        kind: 'aggregated',
        priority: 1,
      });
    }
  }

  return sources;
}

function historicalRecordKey(record: EvalRecord): string {
  if (typeof record.id === 'string' && record.id.length > 0) {
    return `id:${record.id}`;
  }

  return [
    record.issueId || 'no-issue',
    record.prUrl || 'no-pr',
    record.timestamp || 'no-timestamp',
    record.modelId || 'no-model',
    record.originalPrompt || 'no-prompt',
  ].join('|');
}

function countRecordSignals(record: EvalRecord): number {
  return Number(isTaskDescriptor(record.taskDescriptor))
    + Number(Boolean(record.stageOutcomes))
    + Number(Boolean(record.metadata?.stageScores))
    + Number(Boolean(record.workflowTokenUsage))
    + Number(typeof record.workflowCost === 'number')
    + Number(typeof record.score === 'number');
}

function shouldReplaceHistoricalRecord(
  current: { record: EvalRecord; source: HistoricalEvalSource },
  candidate: { record: EvalRecord; source: HistoricalEvalSource },
): boolean {
  const candidateSignals = countRecordSignals(candidate.record);
  const currentSignals = countRecordSignals(current.record);

  if (candidateSignals !== currentSignals) {
    return candidateSignals > currentSignals;
  }

  if (candidate.source.priority !== current.source.priority) {
    return candidate.source.priority > current.source.priority;
  }

  return candidate.record.timestamp > current.record.timestamp;
}

/**
 * Load and merge eval records from multiple sources (local, backfilled, aggregated).
 *
 * This function implements the core feedback loop: it merges records from all sources,
 * preferring richer/newer records when duplicates exist. Local records (highest priority)
 * win over aggregated data, ensuring newly completed work influences routing immediately.
 *
 * Deduplication uses historical record keys (repo+task+workflow), and replacement logic
 * prefers records with more signals, then higher-priority sources, then newer timestamps.
 */
export function loadStageAwareEvalRecords(options: StageAwareOptions = {}): EvalRecord[] {
  stageAwareRouterDebugState.evalLoadCount += 1;
  const repoDir = options.repoDir || process.cwd();
  const recordsByKey = new Map<string, { record: EvalRecord; source: HistoricalEvalSource }>();

  // Iterate through ALL sources and merge records (not first-wins)
  for (const source of getHistoricalSources(repoDir, options)) {
    if (!existsSync(source.path)) {
      continue;
    }

    const records = readJsonlFile<EvalRecord>(source.path);
    for (const record of records) {
      const key = historicalRecordKey(record);
      const existing = recordsByKey.get(key);

      // Use priority-based replacement to prefer richer/newer records
      if (!existing || shouldReplaceHistoricalRecord(existing, { record, source })) {
        recordsByKey.set(key, { record, source });
      }
    }
  }

  return [...recordsByKey.values()].map(({ record }) => record);
}

export function loadStageAwareRouterContext(options: StageAwareOptions = {}): StageAwareRouterContext {
  const repoDir = options.repoDir || process.cwd();

  return {
    repoDir,
    routerConfig: getRouterConfig(repoDir),
    records: loadStageAwareEvalRecords({
      ...options,
      repoDir,
    }),
  };
}

function stageScoreFromRecord(
  record: EvalRecord,
  stageKey: 'plan' | 'implementation' | 'review',
  stageBlendWeight: number,
): number {
  const metadataStageScores = record.metadata?.stageScores as Record<string, { score?: number }> | undefined;
  const metadataScore = metadataStageScores?.[stageKey]?.score;
  const outcomeScore = (record.stageOutcomes?.[stageKey] as StageOutcomes[keyof StageOutcomes] | undefined)?.score;
  const primary = typeof metadataScore === 'number'
    ? metadataScore
    : typeof outcomeScore === 'number'
      ? outcomeScore
      : undefined;

  if (typeof primary === 'number' && typeof record.score === 'number') {
    return clamp(primary * (1 - stageBlendWeight) + record.score * stageBlendWeight, 0, 1);
  }
  if (typeof primary === 'number') {
    return clamp(primary, 0, 1);
  }
  return clamp(typeof record.score === 'number' ? record.score : 0, 0, 1);
}

export function extractRubricScore(descriptor: TaskDescriptor): number | null {
  const rubric = descriptor.rubric;
  if (
    !rubric?.has_rubric ||
    rubric.criterion_count <= 0 ||
    typeof rubric.mean_score !== 'number' ||
    !Number.isFinite(rubric.mean_score)
  ) {
    return null;
  }

  return clamp(rubric.mean_score, 0, 1);
}

export function computeRubricCoverage(neighbors: ScoredNeighbor[]): number {
  if (neighbors.length === 0) {
    return 0;
  }

  const rubricCount = neighbors.filter((neighbor) => extractRubricScore(neighbor.descriptor) !== null).length;
  return rubricCount / neighbors.length;
}

function stageScoreFromRecordRubricAware(
  record: EvalRecord,
  stageKey: 'plan' | 'implementation' | 'review',
  stageBlendWeight: number,
  rubricWeight: number,
): number {
  const scalarScore = stageScoreFromRecord(record, stageKey, stageBlendWeight);
  const rubricScore = extractRubricScore(descriptorFromEvalRecord(record));

  if (rubricScore === null || rubricWeight <= 0) {
    return scalarScore;
  }

  return clamp(scalarScore * (1 - rubricWeight) + rubricScore * rubricWeight, 0, 1);
}

/**
 * Resolve the model that actually handled the given stage on this record.
 *
 * Returns `null` when the record has no real per-stage attribution. We do NOT
 * fall back to `record.modelId` here: that field is the solution/coder model,
 * and using it as the planner model pollutes plan-quality rankings by pinning
 * every legacy record's plan score to whoever coded. Callers that need
 * per-stage rankings should skip records that return null.
 */
function stageModelFromRecord(
  record: EvalRecord,
  role: 'planner' | 'coder' | 'reviewer',
): string | null {
  const descriptor = isTaskDescriptor(record.taskDescriptor) ? record.taskDescriptor : undefined;
  const stageModel = descriptor?.stages?.[role]?.model;
  if (typeof stageModel === 'string' && stageModel.length > 0) {
    return stageModel;
  }
  return null;
}

function stageCostFromRecord(
  record: EvalRecord,
  role: 'planner' | 'coder' | 'reviewer',
  modelId: string,
): number {
  const descriptor = isTaskDescriptor(record.taskDescriptor) ? record.taskDescriptor : undefined;
  const stageCost = descriptor?.stages?.[role]?.cost_usd;
  if (typeof stageCost === 'number') {
    return Math.max(0, stageCost);
  }

  const tokenUsage = record.workflowTokenUsage?.[modelId];
  if (tokenUsage) {
    return Math.max(0, tokenUsage.costUsd);
  }

  if (typeof record.workflowCost === 'number') {
    return Math.max(0, record.workflowCost);
  }

  return 0;
}

function resolveModelsForRole(
  constraints: StageAwareConstraints,
  role: 'planner' | 'coder' | 'reviewer',
): Set<string> | null {
  // Preserve historical behavior for runtime/API allowlist overrides:
  // a flat `modelsAvailable` constraint applies to every stage and wins
  // over repo-configured per-stage defaults.
  if (constraints.modelsAvailable && constraints.modelsAvailable.length > 0) {
    return new Set(constraints.modelsAvailable);
  }

  const stageModels = role === 'planner'
    ? constraints.plannerModelsAvailable
    : role === 'coder'
      ? constraints.coderModelsAvailable
      : constraints.reviewerModelsAvailable;

  if (stageModels && stageModels.length > 0) {
    return new Set(stageModels);
  }

  return null;
}

function aggregateRoleRanking(
  neighbors: ScoredNeighbor[],
  role: 'planner' | 'coder' | 'reviewer',
  stageKey: 'plan' | 'implementation' | 'review',
  constraints: StageAwareConstraints,
  stageBlendWeight: number,
  rubricWeight: number,
): RoleRanking {
  const allowedModels = resolveModelsForRole(constraints, role);

  const byModel = new Map<string, { scoreWeight: number; weightedScore: number; costWeight: number; weightedCost: number; support: number }>();

  for (const neighbor of neighbors) {
    const modelId = stageModelFromRecord(neighbor.record, role);
    if (modelId === null) {
      // Record has no real per-stage attribution. Skipping here prevents
      // legacy records from mis-attributing plan/code/review scores to their
      // solution/coder model.
      continue;
    }
    if (allowedModels && !allowedModels.has(modelId)) {
      continue;
    }

    const bucket = byModel.get(modelId) || {
      scoreWeight: 0,
      weightedScore: 0,
      costWeight: 0,
      weightedCost: 0,
      support: 0,
    };
    const similarityWeight = Math.max(neighbor.similarity, 0.001);
    const stageScore = rubricWeight > 0
      ? stageScoreFromRecordRubricAware(neighbor.record, stageKey, stageBlendWeight, rubricWeight)
      : stageScoreFromRecord(neighbor.record, stageKey, stageBlendWeight);
    const stageCost = stageCostFromRecord(neighbor.record, role, modelId);

    bucket.scoreWeight += similarityWeight;
    bucket.weightedScore += similarityWeight * stageScore;
    bucket.costWeight += similarityWeight;
    bucket.weightedCost += similarityWeight * stageCost;
    bucket.support += 1;
    byModel.set(modelId, bucket);
  }

  const candidates = [...byModel.entries()]
    .map(([modelId, aggregate]) => ({
      modelId,
      score: aggregate.scoreWeight > 0 ? aggregate.weightedScore / aggregate.scoreWeight : 0,
      cost: aggregate.costWeight > 0 ? aggregate.weightedCost / aggregate.costWeight : 0,
      support: aggregate.support,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.cost !== right.cost) return left.cost - right.cost;
      return right.support - left.support;
    });

  return { role, stageKey, candidates };
}

function pickBestCombination(rankings: RoleRanking[], maxCostUsd?: number): CombinationDecision | null {
  if (rankings.some((ranking) => ranking.candidates.length === 0)) {
    return null;
  }

  let best: CombinationDecision | null = null;
  for (const planner of rankings[0].candidates) {
    for (const coder of rankings[1].candidates) {
      for (const reviewer of rankings[2].candidates) {
        const expectedCost = planner.cost + coder.cost + reviewer.cost;
        if (typeof maxCostUsd === 'number' && expectedCost > maxCostUsd) {
          continue;
        }

        const expectedSuccess = clamp((planner.score + coder.score + reviewer.score) / 3, 0, 1);
        if (
          !best ||
          expectedSuccess > best.expectedSuccess ||
          (expectedSuccess === best.expectedSuccess && expectedCost < best.expectedCost)
        ) {
          best = { planner, coder, reviewer, expectedCost, expectedSuccess };
        }
      }
    }
  }

  return best;
}

function choosePlanDepthFromSuccess(expectedSuccess: number): PlanDepth {
  return expectedSuccess >= 0.85 ? 'deep' : 'light';
}

function chooseCodeDepthFromSuccess(expectedSuccess: number): CodeDepth {
  if (expectedSuccess >= 0.88) return 'deep';
  if (expectedSuccess >= 0.72) return 'medium';
  return 'light';
}

function chooseReviewModeFromSuccess(expectedSuccess: number): ReviewMode {
  if (expectedSuccess >= 0.85) return 'static+llm';
  if (expectedSuccess >= 0.65) return 'llm';
  return 'static';
}

export function rankModelsPerStage(
  neighbors: ScoredNeighbor[],
  constraints: StageAwareConstraints = {},
  stageBlendWeight = DEFAULT_STAGE_BLEND_WEIGHT,
  rubricWeight = 0,
): {
  rankings: RoleRanking[];
  selection: CombinationDecision | null;
} {
  const boundedRubricWeight = clamp(rubricWeight, 0, 1);
  const rankings = [
    aggregateRoleRanking(neighbors, 'planner', 'plan', constraints, stageBlendWeight, boundedRubricWeight),
    aggregateRoleRanking(neighbors, 'coder', 'implementation', constraints, stageBlendWeight, boundedRubricWeight),
    aggregateRoleRanking(neighbors, 'reviewer', 'review', constraints, stageBlendWeight, boundedRubricWeight),
  ];

  return {
    rankings,
    selection: pickBestCombination(rankings, constraints.maxCostUsd),
  };
}

function estimateFallbackStageCost(
  modelId: string,
  stage: 'plan' | 'code' | 'review',
  repoDir?: string,
): number {
  const pricing = loadPricingTable(repoDir)[modelId];
  if (!pricing) {
    return 0;
  }

  const profiles = {
    plan: { inputTokens: 35_000, cacheCreationTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 5_000 },
    code: { inputTokens: 850_000, cacheCreationTokens: 260_000, cacheReadTokens: 700_000, outputTokens: 35_000 },
    review: { inputTokens: 95_000, cacheCreationTokens: 25_000, cacheReadTokens: 80_000, outputTokens: 8_000 },
  } as const;

  return computeModelCost(profiles[stage], pricing);
}

function buildStageAwareDecision(
  selection: CombinationDecision,
  neighbors: ScoredNeighbor[],
  kNeighbors: number,
  repoDir?: string,
): StageAwareDecision {
  const similarities = neighbors.map((neighbor) => neighbor.similarity);
  const similarityRange: [number, number] = similarities.length > 0
    ? [Math.min(...similarities), Math.max(...similarities)]
    : [0, 0];
  const meanSimilarity = similarities.length > 0
    ? similarities.reduce((sum, similarity) => sum + similarity, 0) / similarities.length
    : 0.5;
  const neighborFactor = kNeighbors > 0
    ? clamp(neighbors.length / kNeighbors, 0, 1)
    : 0.5;
  const confidence = clamp(neighborFactor * 0.4 + meanSimilarity * 0.6, 0.1, 0.95);

  const expectedCostPlan = selection.planner.cost || estimateFallbackStageCost(selection.planner.modelId, 'plan', repoDir);
  const expectedCostCode = selection.coder.cost || estimateFallbackStageCost(selection.coder.modelId, 'code', repoDir);
  const expectedCostReview = selection.reviewer.cost || estimateFallbackStageCost(selection.reviewer.modelId, 'review', repoDir);

  return {
    planner: selection.planner.modelId,
    coder: selection.coder.modelId,
    reviewer: selection.reviewer.modelId,
    planDepth: choosePlanDepthFromSuccess(selection.planner.score),
    codeDepth: chooseCodeDepthFromSuccess(selection.coder.score),
    reviewRecommended: chooseReviewModeFromSuccess(selection.reviewer.score),
    expectedSuccess: Number(selection.expectedSuccess.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    expectedCostPlan: Number(expectedCostPlan.toFixed(2)),
    expectedCostCode: Number(expectedCostCode.toFixed(2)),
    expectedCostReview: Number(expectedCostReview.toFixed(2)),
    expectedCost: Number((expectedCostPlan + expectedCostCode + expectedCostReview).toFixed(2)),
    reasoning: [
      `Stage-aware routing used ${neighbors.length} similar historical tasks.`,
      `Similarity range ${similarityRange[0].toFixed(2)}-${similarityRange[1].toFixed(2)} across nearest neighbors.`,
      `Planner=${selection.planner.modelId}, coder=${selection.coder.modelId}, reviewer=${selection.reviewer.modelId} maximize weighted per-stage scores.`,
      `Expected success ${(selection.expectedSuccess * 100).toFixed(0)}% with estimated workflow cost $${(expectedCostPlan + expectedCostCode + expectedCostReview).toFixed(2)}.`,
    ],
    signals: {
      taskType: 'unknown',
      promptLength: 'medium',
      complexityScore: 0,
      fileTypes: [],
      riskScore: 0,
    },
    routingMode: 'stage-aware',
    neighborCount: neighbors.length,
    neighborSimilarityRange: [
      Number(similarityRange[0].toFixed(2)),
      Number(similarityRange[1].toFixed(2)),
    ],
  };
}

function prependRubricReasoning(decision: StageAwareDecision, message: string): StageAwareDecision {
  decision.reasoning = [message, ...decision.reasoning];
  return decision;
}

export function routeStageAware(
  prompt: string,
  options: StageAwareOptions = {},
): StageAwareDecision | null {
  const context = loadStageAwareRouterContext(options);
  return routeStageAwareWithContext(prompt, context, options);
}

export function routeStageAwareWithContext(
  prompt: string,
  context: StageAwareRouterContext,
  options: StageAwareOptions = {},
): StageAwareDecision | null {
  const { repoDir, routerConfig, records } = context;
  const plannerModels = filterDeepSeekModels(
    getAvailableModelsForStage(routerConfig, 'planner') || [],
    repoDir,
    'planner',
  ).models;
  const coderModels = filterDeepSeekModels(
    getAvailableModelsForStage(routerConfig, 'coder') || [],
    repoDir,
    'coder',
  ).models;
  const reviewerModels = filterDeepSeekModels(
    getAvailableModelsForStage(routerConfig, 'reviewer') || [],
    repoDir,
    'reviewer',
  ).models;
  const filteredModelsAvailable = filterDeepSeekModels(
    options.modelsAvailable || [],
    repoDir,
  ).models;
  const filteredPlannerOptions = filterDeepSeekModels(
    options.plannerModelsAvailable || [],
    repoDir,
    'planner',
  ).models;
  const filteredCoderOptions = filterDeepSeekModels(
    options.coderModelsAvailable || [],
    repoDir,
    'coder',
  ).models;
  const filteredReviewerOptions = filterDeepSeekModels(
    options.reviewerModelsAvailable || [],
    repoDir,
    'reviewer',
  ).models;
  const kNeighbors = options.kNeighbors || routerConfig.kNeighbors || DEFAULT_K_NEIGHBORS;
  const minRecords = options.minRecords || routerConfig.minRecords || DEFAULT_MIN_RECORDS;
  const minModels = options.minModels || routerConfig.minModels || DEFAULT_MIN_MODELS;
  const stageBlendWeight = clamp(
    options.stageBlendWeight ?? routerConfig.stageBlendWeight ?? DEFAULT_STAGE_BLEND_WEIGHT,
    0,
    1,
  );
  const rubricAwareMode = routerConfig.rubricAware?.mode || 'off';
  const rubricAwareMinCoverage = clamp(
    routerConfig.rubricAware?.minCoverage ?? DEFAULT_RUBRIC_AWARE_MIN_COVERAGE,
    0,
    1,
  );
  const rubricAwareWeight = clamp(
    routerConfig.rubricAware?.weight ?? DEFAULT_RUBRIC_AWARE_WEIGHT,
    0,
    1,
  );
  const descriptorModelsAvailable = options.modelsAvailable ?? getConfiguredModelsForDescriptor(repoDir);
  const queryDescriptor = buildTaskDescriptor({
    originalPrompt: prompt,
    modelsAvailable: descriptorModelsAvailable,
    maxCostUsd: options.maxCostUsd,
    ...options.queryInput,
  });

  if (records.length < minRecords) {
    return null;
  }

  const neighbors = findKNearest(queryDescriptor, records, kNeighbors);
  if (neighbors.length === 0) {
    return null;
  }

  const distinctNeighborModels = new Set(neighbors.map((neighbor) => neighbor.record.modelId));
  const hasModelDiversity = distinctNeighborModels.size >= minModels;
  const rubricCoverage = computeRubricCoverage(neighbors);
  const rubricCoverageLabel = rubricCoverage.toFixed(2);
  const rubricWeightLabel = Number(rubricAwareWeight.toFixed(2)).toString();
  const rubricFallbackReason = `rubric-aware fallback: coverage ${rubricCoverageLabel} < minCoverage ${rubricAwareMinCoverage.toFixed(2)}`;
  const rubricActiveReason = `rubric-aware (mode=${rubricAwareMode}, coverage=${rubricCoverageLabel}, weight=${rubricWeightLabel})`;
  const rubricHasSufficientCoverage = rubricCoverage >= rubricAwareMinCoverage;
  const rubricScoringWeight = rubricAwareMode === 'on' && rubricHasSufficientCoverage ? rubricAwareWeight : 0;

  const { selection } = rankModelsPerStage(neighbors, {
    modelsAvailable: filteredModelsAvailable,
    plannerModelsAvailable: filteredPlannerOptions.length > 0 ? filteredPlannerOptions : plannerModels,
    coderModelsAvailable: filteredCoderOptions.length > 0 ? filteredCoderOptions : coderModels,
    reviewerModelsAvailable: filteredReviewerOptions.length > 0 ? filteredReviewerOptions : reviewerModels,
    maxCostUsd: options.maxCostUsd,
  }, stageBlendWeight, rubricScoringWeight);

  if (!selection) {
    const hasModelConstraints =
      filteredModelsAvailable.length > 0 ||
      filteredPlannerOptions.length > 0 ||
      filteredCoderOptions.length > 0 ||
      filteredReviewerOptions.length > 0 ||
      plannerModels.length > 0 ||
      coderModels.length > 0 ||
      reviewerModels.length > 0;
    if (!hasModelConstraints) {
      return null;
    }

    // Preserve stage/depth calibration from similar tasks even when the active
    // model allowlist filters every neighbor out of stage selection.
    const { selection: unconstrainedSelection } = rankModelsPerStage(neighbors, {
      maxCostUsd: options.maxCostUsd,
    }, stageBlendWeight, rubricScoringWeight);
    if (!unconstrainedSelection) {
      return null;
    }

    const partialDecision = buildStageAwareDecision(
      unconstrainedSelection,
      neighbors,
      kNeighbors,
      repoDir,
    );
    if (options.maxCostUsd !== undefined) {
      partialDecision.constraints = { maxCostUsd: options.maxCostUsd };
    }
    partialDecision.routingMode = 'stage-aware-partial';
    partialDecision.confidence = Number((clamp(partialDecision.confidence * 0.8, 0.1, 0.95)).toFixed(2));
    if (rubricAwareMode === 'on' || rubricAwareMode === 'shadow') {
      prependRubricReasoning(
        partialDecision,
        rubricHasSufficientCoverage ? rubricActiveReason : rubricFallbackReason,
      );
      if (rubricAwareMode === 'shadow') {
        if (rubricHasSufficientCoverage) {
          const { selection: shadowUnconstrainedSelection } = rankModelsPerStage(neighbors, {
            maxCostUsd: options.maxCostUsd,
          }, stageBlendWeight, rubricAwareWeight);
          partialDecision.shadowDecision = shadowUnconstrainedSelection
            ? buildStageAwareDecision(shadowUnconstrainedSelection, neighbors, kNeighbors, repoDir)
            : null;
        } else {
          partialDecision.shadowDecision = null;
        }
      }
    }
    return partialDecision;
  }

  const decision = buildStageAwareDecision(selection, neighbors, kNeighbors, repoDir);
  if (options.maxCostUsd !== undefined) {
    decision.constraints = { maxCostUsd: options.maxCostUsd };
  }

  // When neighbors lack model diversity, use neighbor data for stage calibration
  // (depth, review mode, cost estimates) but mark the decision as partial so the
  // caller can overlay heuristic model selection.
  if (!hasModelDiversity) {
    decision.routingMode = 'stage-aware-partial';
    decision.confidence = Number((clamp(decision.confidence * 0.8, 0.1, 0.95)).toFixed(2));
  }

  if (rubricAwareMode === 'on' || rubricAwareMode === 'shadow') {
    prependRubricReasoning(
      decision,
      rubricHasSufficientCoverage ? rubricActiveReason : rubricFallbackReason,
    );
    if (rubricAwareMode === 'shadow') {
      if (rubricHasSufficientCoverage) {
        const { selection: shadowSelection } = rankModelsPerStage(neighbors, {
          modelsAvailable: filteredModelsAvailable,
          plannerModelsAvailable: filteredPlannerOptions.length > 0 ? filteredPlannerOptions : plannerModels,
          coderModelsAvailable: filteredCoderOptions.length > 0 ? filteredCoderOptions : coderModels,
          reviewerModelsAvailable: filteredReviewerOptions.length > 0 ? filteredReviewerOptions : reviewerModels,
          maxCostUsd: options.maxCostUsd,
        }, stageBlendWeight, rubricAwareWeight);
        decision.shadowDecision = shadowSelection
          ? buildStageAwareDecision(shadowSelection, neighbors, kNeighbors, repoDir)
          : null;
      } else {
        decision.shadowDecision = null;
      }
    }
  }

  return decision;
}
