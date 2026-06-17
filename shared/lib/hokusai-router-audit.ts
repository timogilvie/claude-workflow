/**
 * Hokusai router audit.
 *
 * Replays a stratified eval sample through the live Model 30 router and
 * reports recommendation spread plus basic correctness checks.
 *
 * @module hokusai-router-audit
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getHokusaiRouterConfig, getRouterConfig } from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import { errorMessage } from './error-utils.ts';
import { toHokusaiModel30Request, type HokusaiModel30Response, type HokusaiModel30Request, type HokusaiRecommendedStrategy } from './hokusai-schema.ts';
import { classifyHokusaiFailure, DEFAULT_HOKUSAI_MODEL30_ENDPOINT, DEFAULT_HOKUSAI_TIMEOUT_MS, isHokusaiModel30Response, type HokusaiFailureClassification } from './hokusai-router.ts';
import { getConfiguredModelsForDescriptorStage, getEffectiveRegistry, isModelEnabled } from './model-registry.ts';
import { isDisabledModel } from './disabled-models.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { findKNearest, loadStageAwareEvalRecords, type ScoredNeighbor } from './stage-aware-router.ts';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import { recordStageModel, type ChallengeStage } from './challenge-scheduler.ts';
import { DIVERSITY_STAGES, resolveCoverageConfig, type StageShareEntry } from './router-diversity.ts';

export type AuditStageRole = 'planner' | 'coder' | 'reviewer';

const STAGE_ROLES: readonly AuditStageRole[] = ['planner', 'coder', 'reviewer'];

/**
 * V2 scenario taxonomy for composite benchmark coverage.
 */
export type AuditScenario =
  | 'production_pool'
  | 'challenger_present'
  | 'dominant_model_removed'
  | 'low_budget'
  | 'sparse_cell';

export const V2_SCENARIOS: readonly AuditScenario[] = [
  'production_pool',
  'challenger_present',
  'dominant_model_removed',
  'low_budget',
  'sparse_cell',
] as const;

const ROLE_TO_STAGE: Record<AuditStageRole, ChallengeStage> = {
  planner: 'plan',
  coder: 'implementation',
  reviewer: 'review',
};

const ROLE_TO_STRATEGY_KEY: Record<AuditStageRole, keyof Pick<HokusaiRecommendedStrategy, 'planner_model' | 'coder_model' | 'reviewer_model'>> = {
  planner: 'planner_model',
  coder: 'coder_model',
  reviewer: 'reviewer_model',
};

export interface HokusaiAuditOptions {
  repoDir?: string;
  sample?: number;
  concurrency?: number;
  dryRun?: boolean;
  redact?: boolean;
  json?: boolean;
  output?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxShare?: number;
  token?: string;
  kNeighbors?: number;
  fetchFn?: typeof fetch;
  now?: Date;
  benchmarkVersion?: 'v1' | 'v2';
}

export interface AuditRequestRecord {
  evalId: string;
  issueId?: string;
  request: HokusaiModel30Request;
  descriptor: TaskDescriptor;
  originalRecord: EvalRecord;
  candidatePools: Record<AuditStageRole, string[]>;
  scenario?: AuditScenario;
}

export interface AuditFailure {
  evalId: string;
  classification: HokusaiFailureClassification;
  detail: string;
}

export interface AuditRecommendation {
  evalId: string;
  issueId?: string;
  strategy: HokusaiRecommendedStrategy;
  response?: HokusaiModel30Response;
  request?: HokusaiModel30Request;
  candidatePools: Record<AuditStageRole, string[]>;
  originalRecord: EvalRecord;
  actualScore: number;
  actualStageModels: Partial<Record<ChallengeStage, string>>;
}

export interface ValidityViolation {
  evalId: string;
  role: AuditStageRole;
  model: string;
  reasons: string[];
}

export interface CalibrationBucket {
  bucket: string;
  count: number;
  meanEstimatedSuccess: number;
  meanActualScore: number;
}

export interface RegretSummary {
  count: number;
  meanRegret: number;
  dominated: boolean;
}

export interface DeterminismProbeResult {
  attempted: number;
  stablePairs: number;
  allStable: boolean;
}

export interface SensitivityProbeResult {
  attempted: number;
  distinctRecommendationCount: number;
  allIdentical: boolean;
}

export interface HokusaiAuditReport {
  generatedAt: string;
  endpoint: string;
  dryRun: boolean;
  redacted: boolean;
  corpusRecords: number;
  sampledRecords: number;
  successfulResponses: number;
  failures: AuditFailure[];
  stageShares: Record<AuditStageRole, StageShareEntry[]>;
  effectiveModelCounts: Record<AuditStageRole, number>;
  dominanceWarnings: { role: AuditStageRole; model: string; share: number; threshold: number }[];
  validityViolations: ValidityViolation[];
  validityViolationRate: number;
  determinism: DeterminismProbeResult;
  sensitivity: SensitivityProbeResult;
  calibration: CalibrationBucket[];
  regret: Record<AuditStageRole, RegretSummary>;
  groupBreakdowns: Record<string, AuditGroupBreakdown[]>;
  scenarioShares?: ScenarioSharesBreakdown[];
  candidateEvidence?: CandidateEvidenceCoverage;
  v2Conformance?: V2ConformanceCheck;
  hardFailures: string[];
  artifactPath?: string;
}

export interface AuditGroupBreakdown {
  group: string;
  count: number;
  stageShares: Record<AuditStageRole, StageShareEntry[]>;
  effectiveModelCounts: Record<AuditStageRole, number>;
}

export interface ScenarioSharesBreakdown {
  scenario: AuditScenario;
  count: number;
  stageShares: Record<AuditStageRole, StageShareEntry[]>;
  effectiveModelCounts: Record<AuditStageRole, number>;
  candidatePools: Record<AuditStageRole, string[]>;
}

export interface CandidateEvidenceEntry {
  model: string;
  role: AuditStageRole;
  totalRecords: number;
  byTaskType: Record<string, number>;
  byDomain: Record<string, number>;
  byComplexity: Record<string, number>;
  isZeroEvidence: boolean;
}

export interface CandidateEvidenceCoverage {
  threshold: number;
  entries: CandidateEvidenceEntry[];
  warnings: string[];
}

export interface V2ConformanceCheck {
  benchmarkSpecId: string;
  expectedSchemaVersion: string;
  primaryMetric: string;
  scenarioCoverage: {
    total: number;
    missingScenarios: AuditScenario[];
  };
  rowSchemaChecks: {
    passed: number;
    failed: number;
    failures: string[];
  };
  guardrailChecks: {
    passed: boolean;
    violations: string[];
  };
  errors: string[];
  warnings: string[];
  ok: boolean;
}

function clampConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(8, Math.floor(value as number)));
}

function parseTimestampBucket(record: EvalRecord): string {
  const parsed = new Date(record.timestamp || 0);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

function stratificationKey(record: EvalRecord): string {
  const taskType = record.taskDescriptor?.signals?.heuristic?.task_type
    || record.taskContext?.taskType
    || 'unknown';
  const repo = record.repoContext?.repoId || 'unknown';
  return [taskType, parseTimestampBucket(record), repo].join('|');
}

export function stratifiedSampleRecords(
  records: EvalRecord[],
  sampleSize: number,
): EvalRecord[] {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0 || sampleSize >= records.length) {
    return [...records];
  }

  const buckets = new Map<string, EvalRecord[]>();
  for (const record of records) {
    const key = stratificationKey(record);
    const bucket = buckets.get(key) ?? [];
    bucket.push(record);
    buckets.set(key, bucket);
  }

  const sortedBuckets = [...buckets.values()]
    .map((bucket) => bucket.sort((left, right) => (right.timestamp || '').localeCompare(left.timestamp || '')))
    .sort((left, right) => stratificationKey(left[0]).localeCompare(stratificationKey(right[0])));

  const sampled: EvalRecord[] = [];
  let cursor = 0;
  while (sampled.length < sampleSize && sortedBuckets.some((bucket) => bucket.length > 0)) {
    const bucket = sortedBuckets[cursor % sortedBuckets.length];
    const next = bucket.shift();
    if (next) {
      sampled.push(next);
    }
    cursor += 1;
  }

  return sampled;
}

function buildReplayDescriptor(record: EvalRecord): TaskDescriptor {
  return buildTaskDescriptor({
    originalPrompt: record.originalPrompt,
    taskContext: record.taskContext,
    repoContext: record.repoContext,
  });
}

function redactModel30Request(request: HokusaiModel30Request): HokusaiModel30Request {
  return {
    ...request,
    inputs: {
      ...request.inputs,
      task: {
        ...request.inputs.task,
        description: '',
      },
    },
  };
}

function candidatePools(repoDir?: string): Record<AuditStageRole, string[]> {
  return {
    planner: getConfiguredModelsForDescriptorStage(repoDir, 'planner'),
    coder: getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
    reviewer: getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'),
  };
}

/**
 * Apply scenario-specific transformations to candidate pools and budget.
 */
function applyScenarioContext(
  scenario: AuditScenario,
  basePools: Record<AuditStageRole, string[]>,
  baseMaxCostUsd: number,
  corpusRecords: EvalRecord[],
  descriptor: TaskDescriptor,
): { pools: Record<AuditStageRole, string[]>; maxCostUsd: number } {
  switch (scenario) {
    case 'production_pool':
      return { pools: basePools, maxCostUsd: baseMaxCostUsd };

    case 'challenger_present': {
      // Inject zero-evidence challenger models drawn from the model registry but
      // absent from the production pool. This exposes candidates with no
      // historical evidence to the router so robustness against unknown
      // challengers can be measured.
      const registry = getEffectiveRegistry();
      const allRegistryModels = Object.keys(registry.models).filter((modelId) => {
        const capabilities = registry.models[modelId];
        return !isDisabledModel(modelId) && (capabilities === undefined || isModelEnabled(capabilities));
      });
      const augmentedPools: Record<AuditStageRole, string[]> = {} as Record<AuditStageRole, string[]>;
      for (const role of STAGE_ROLES) {
        const existing = basePools[role];
        const challengers = allRegistryModels.filter((modelId) => !existing.includes(modelId));
        augmentedPools[role] = [...existing, ...challengers];
      }
      // If no challengers were available across any role, fall back to production
      // pools so the scenario still produces requests.
      const anyChallenger = STAGE_ROLES.some((role) => augmentedPools[role].length > basePools[role].length);
      return { pools: anyChallenger ? augmentedPools : basePools, maxCostUsd: baseMaxCostUsd };
    }

    case 'dominant_model_removed': {
      // Remove dominant model from each role's pool
      const modifiedPools: Record<AuditStageRole, string[]> = {} as Record<AuditStageRole, string[]>;
      for (const role of STAGE_ROLES) {
        const rolePools = basePools[role];
        if (rolePools.length <= 1) {
          modifiedPools[role] = rolePools;
          continue;
        }
        // Find dominant model by counting usage in corpus for this role
        const counts = new Map<string, number>();
        for (const record of corpusRecords) {
          const model = recordStageModel(record, ROLE_TO_STAGE[role]);
          if (model && rolePools.includes(model)) {
            counts.set(model, (counts.get(model) ?? 0) + 1);
          }
        }
        const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        modifiedPools[role] = dominant ? rolePools.filter((m) => m !== dominant) : rolePools;
        // Fallback: if removing dominant leaves no candidates, keep the pool
        if (modifiedPools[role].length === 0) {
          modifiedPools[role] = rolePools;
        }
      }
      return { pools: modifiedPools, maxCostUsd: baseMaxCostUsd };
    }

    case 'low_budget': {
      // Reduce max cost to 50% of baseline
      return { pools: basePools, maxCostUsd: baseMaxCostUsd * 0.5 };
    }

    case 'sparse_cell': {
      // Sparse-cell isolation is achieved by record filtering in
      // buildAuditRequestsWithScenarios (isSparseCell), so pools/budget remain
      // the production baseline.
      return { pools: basePools, maxCostUsd: baseMaxCostUsd };
    }

    default:
      return { pools: basePools, maxCostUsd: baseMaxCostUsd };
  }
}

/**
 * Determine if a record represents a sparse cell based on corpus evidence.
 */
function isSparseCell(
  descriptor: TaskDescriptor,
  corpusRecords: EvalRecord[],
  threshold = 15,
): boolean {
  const taskType = descriptor.signals.heuristic.task_type || 'unknown';
  const domain = descriptor.signals.learned.domain || 'unknown';
  const complexity = descriptor.signals.learned.complexity;
  const complexityBucket = typeof complexity === 'number'
    ? complexity <= 2 ? 'low' : complexity >= 4 ? 'high' : 'medium'
    : 'unknown';

  const matches = corpusRecords.filter((record) => {
    const recordDescriptor = buildReplayDescriptor(record);
    const recordTaskType = recordDescriptor.signals.heuristic.task_type || 'unknown';
    const recordDomain = recordDescriptor.signals.learned.domain || 'unknown';
    const recordComplexity = recordDescriptor.signals.learned.complexity;
    const recordComplexityBucket = typeof recordComplexity === 'number'
      ? recordComplexity <= 2 ? 'low' : recordComplexity >= 4 ? 'high' : 'medium'
      : 'unknown';

    return recordTaskType === taskType
      && recordDomain === domain
      && recordComplexityBucket === complexityBucket;
  });

  return matches.length < threshold;
}

export function buildAuditRequests(records: EvalRecord[], options: { repoDir?: string; redact?: boolean } = {}): AuditRequestRecord[] {
  const pools = candidatePools(options.repoDir);
  return records.filter((record) => record.originalPrompt?.trim()).map((record) => {
    const descriptor = buildReplayDescriptor(record);
    const request = toHokusaiModel30Request(descriptor, descriptor.repoContext, {
      description: record.originalPrompt,
      externalTaskId: record.id,
      plannerModels: pools.planner,
      coderModels: pools.coder,
      reviewerModels: pools.reviewer,
      modelsAvailable: [...new Set([...pools.planner, ...pools.coder, ...pools.reviewer])],
      workflowStages: ['plan', 'code', 'review'],
    });
    return {
      evalId: record.id,
      issueId: record.issueId,
      request: options.redact === false ? request : redactModel30Request(request),
      descriptor,
      originalRecord: record,
      candidatePools: pools,
    };
  });
}

/**
 * Build audit requests with v2 scenario variants.
 */
export function buildAuditRequestsWithScenarios(
  records: EvalRecord[],
  corpus: EvalRecord[],
  options: { repoDir?: string; redact?: boolean } = {},
): Map<AuditScenario, AuditRequestRecord[]> {
  const basePools = candidatePools(options.repoDir);
  const baseMaxCostUsd = 5.0; // Default budget
  const scenarioRequests = new Map<AuditScenario, AuditRequestRecord[]>();

  for (const scenario of V2_SCENARIOS) {
    const requests: AuditRequestRecord[] = [];
    for (const record of records.filter((r) => r.originalPrompt?.trim())) {
      const descriptor = buildReplayDescriptor(record);

      // Apply scenario-specific transformations
      const { pools, maxCostUsd } = applyScenarioContext(
        scenario,
        basePools,
        baseMaxCostUsd,
        corpus,
        descriptor,
      );

      // Skip sparse_cell scenario for records that don't meet sparse criteria
      if (scenario === 'sparse_cell' && !isSparseCell(descriptor, corpus)) {
        continue;
      }

      const request = toHokusaiModel30Request(descriptor, descriptor.repoContext, {
        description: record.originalPrompt,
        externalTaskId: `${record.id}-${scenario}`,
        plannerModels: pools.planner,
        coderModels: pools.coder,
        reviewerModels: pools.reviewer,
        modelsAvailable: [...new Set([...pools.planner, ...pools.coder, ...pools.reviewer])],
        workflowStages: ['plan', 'code', 'review'],
        maxCostUsd,
      });

      requests.push({
        evalId: `${record.id}-${scenario}`,
        issueId: record.issueId,
        request: options.redact === false ? request : redactModel30Request(request),
        descriptor,
        originalRecord: record,
        candidatePools: pools,
        scenario,
      });
    }
    if (requests.length > 0) {
      scenarioRequests.set(scenario, requests);
    }
  }

  return scenarioRequests;
}

function requestConstructionFailures(records: EvalRecord[]): AuditFailure[] {
  return records
    .filter((record) => !record.originalPrompt?.trim())
    .map((record) => ({
      evalId: record.id,
      classification: 'invalid_payload' as const,
      detail: 'empty originalPrompt; cannot construct Hokusai Model 30 task.description',
    }));
}

export function effectiveModelCount(entries: StageShareEntry[]): number {
  const entropy = entries.reduce((sum, entry) => {
    if (entry.share <= 0) return sum;
    return sum - entry.share * Math.log(entry.share);
  }, 0);
  return Math.exp(entropy);
}

export function buildStageShares(recommendations: AuditRecommendation[]): Record<AuditStageRole, StageShareEntry[]> {
  const result = {} as Record<AuditStageRole, StageShareEntry[]>;
  for (const role of STAGE_ROLES) {
    const counts = new Map<string, number>();
    for (const recommendation of recommendations) {
      const model = recommendation.strategy[ROLE_TO_STRATEGY_KEY[role]];
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    result[role] = [...counts.entries()]
      .map(([model, count]) => ({
        model,
        count,
        share: total > 0 ? count / total : 0,
      }))
      .sort((left, right) => right.count - left.count || left.model.localeCompare(right.model));
  }
  return result;
}

export function classifyValidityViolations(
  recommendations: AuditRecommendation[],
  repoDir?: string,
): ValidityViolation[] {
  const registry = getEffectiveRegistry(repoDir);
  const violations: ValidityViolation[] = [];
  for (const recommendation of recommendations) {
    for (const role of STAGE_ROLES) {
      const model = recommendation.strategy[ROLE_TO_STRATEGY_KEY[role]];
      const reasons: string[] = [];
      if (!recommendation.candidatePools[role].includes(model)) {
        reasons.push('not_in_candidate_pool');
      }
      if (!registry.models[model]) {
        reasons.push('unknown_model');
      }
      if (isDisabledModel(model)) {
        reasons.push('disabled_model');
      }
      if (reasons.length > 0) {
        violations.push({ evalId: recommendation.evalId, role, model, reasons });
      }
    }
  }
  return violations;
}

function actualStageModels(record: EvalRecord): Partial<Record<ChallengeStage, string>> {
  return Object.fromEntries(
    DIVERSITY_STAGES
      .map((stage) => [stage, recordStageModel(record, stage)] as const)
      .filter((entry): entry is readonly [ChallengeStage, string] => Boolean(entry[1])),
  );
}

function sameStrategy(left: HokusaiRecommendedStrategy, right: HokusaiRecommendedStrategy): boolean {
  return left.planner_model === right.planner_model
    && left.coder_model === right.coder_model
    && left.reviewer_model === right.reviewer_model
    && left.plan_depth === right.plan_depth
    && left.code_depth === right.code_depth
    && left.review_mode === right.review_mode;
}

function strategySignature(strategy: HokusaiRecommendedStrategy): string {
  return [
    strategy.planner_model,
    strategy.coder_model,
    strategy.reviewer_model,
    strategy.plan_depth || '',
    strategy.code_depth || '',
    strategy.review_mode || '',
  ].join('|');
}

export function summarizeDeterminism(responses: HokusaiRecommendedStrategy[][]): DeterminismProbeResult {
  let stablePairs = 0;
  for (const pair of responses) {
    if (pair.length >= 2 && sameStrategy(pair[0], pair[1])) {
      stablePairs += 1;
    }
  }
  return {
    attempted: responses.length,
    stablePairs,
    allStable: responses.length > 0 && stablePairs === responses.length,
  };
}

export function summarizeSensitivity(strategies: HokusaiRecommendedStrategy[]): SensitivityProbeResult {
  const distinctRecommendationCount = new Set(strategies.map(strategySignature)).size;
  return {
    attempted: strategies.length,
    distinctRecommendationCount,
    allIdentical: strategies.length > 1 && distinctRecommendationCount === 1,
  };
}

export function buildCalibration(recommendations: AuditRecommendation[]): CalibrationBucket[] {
  const matches = recommendations
    .filter((recommendation) => {
      const models = recommendation.actualStageModels;
      return models.plan === recommendation.strategy.planner_model
        && models.implementation === recommendation.strategy.coder_model
        && models.review === recommendation.strategy.reviewer_model
        && typeof recommendation.strategy.estimated_success_under_budget === 'number';
    })
    .sort((left, right) => (left.strategy.estimated_success_under_budget ?? 0) - (right.strategy.estimated_success_under_budget ?? 0));

  if (matches.length === 0) return [];

  const buckets: CalibrationBucket[] = [];
  for (let bucketIndex = 0; bucketIndex < 5; bucketIndex += 1) {
    const start = Math.floor((bucketIndex * matches.length) / 5);
    const end = Math.floor(((bucketIndex + 1) * matches.length) / 5);
    const bucket = matches.slice(start, end);
    if (bucket.length === 0) continue;
    buckets.push({
      bucket: `q${bucketIndex + 1}`,
      count: bucket.length,
      meanEstimatedSuccess: mean(bucket.map((entry) => entry.strategy.estimated_success_under_budget ?? 0)),
      meanActualScore: mean(bucket.map((entry) => entry.actualScore)),
    });
  }
  return buckets;
}

function recommendationGroupValue(recommendation: AuditRecommendation, groupBy: string): string {
  const descriptor = buildReplayDescriptor(recommendation.originalRecord);

  // Descriptor-based grouping (original behavior)
  if (groupBy === 'descriptor.taskType') {
    return descriptor.signals.heuristic.task_type || 'unknown';
  }
  if (groupBy === 'descriptor.complexity') {
    const complexity = descriptor.signals.learned.complexity;
    if (typeof complexity !== 'number') return 'unknown';
    if (complexity <= 2) return 'low';
    if (complexity >= 4) return 'high';
    return 'medium';
  }
  if (groupBy === 'descriptor.domain') {
    return descriptor.signals.learned.domain || 'unknown';
  }

  // Request-based grouping (v2)
  if (groupBy === 'request.taskType' && recommendation.request) {
    return recommendation.request.inputs.task.task_type || 'unknown';
  }
  if (groupBy === 'request.complexity' && recommendation.request) {
    return recommendation.request.inputs.context?.estimated_complexity || 'unknown';
  }
  if (groupBy === 'request.domain' && recommendation.request) {
    return recommendation.request.inputs.context?.domain || 'unknown';
  }

  return 'unknown';
}

export function buildGroupBreakdowns(recommendations: AuditRecommendation[]): Record<string, AuditGroupBreakdown[]> {
  // Explicit descriptor- and request-sourced groups so consumers can tell which
  // upstream field a breakdown was computed from.
  const descriptorGroups = ['descriptor.taskType', 'descriptor.complexity', 'descriptor.domain'];
  const requestGroups = ['request.taskType', 'request.complexity', 'request.domain'];
  const allGroups = [...descriptorGroups, ...requestGroups];

  return Object.fromEntries(allGroups.map((groupBy) => {
    const byValue = new Map<string, AuditRecommendation[]>();
    for (const recommendation of recommendations) {
      const value = recommendationGroupValue(recommendation, groupBy);
      const group = byValue.get(value) ?? [];
      group.push(recommendation);
      byValue.set(value, group);
    }
    const breakdowns = [...byValue.entries()]
      .map(([group, entries]) => {
        const stageShares = buildStageShares(entries);
        return {
          group,
          count: entries.length,
          stageShares,
          effectiveModelCounts: {
            planner: effectiveModelCount(stageShares.planner),
            coder: effectiveModelCount(stageShares.coder),
            reviewer: effectiveModelCount(stageShares.reviewer),
          },
        };
      })
      .sort((left, right) => right.count - left.count || left.group.localeCompare(right.group));
    return [groupBy, breakdowns];
  })) as Record<string, AuditGroupBreakdown[]>;
}

/**
 * Build scenario-specific breakdown of stage shares.
 */
export function buildScenarioShares(
  scenarioRequests: Map<AuditScenario, AuditRequestRecord[]>,
  scenarioRecommendations: Map<AuditScenario, AuditRecommendation[]>,
): ScenarioSharesBreakdown[] {
  return V2_SCENARIOS.map((scenario) => {
    const recommendations = scenarioRecommendations.get(scenario) ?? [];
    const requests = scenarioRequests.get(scenario) ?? [];
    const stageShares = buildStageShares(recommendations);
    // Extract candidate pools from first request (all requests in scenario share same pools)
    const firstRequest = requests[0];
    const candidatePools: Record<AuditStageRole, string[]> = firstRequest?.candidatePools ?? {
      planner: [],
      coder: [],
      reviewer: [],
    };
    return {
      scenario,
      count: recommendations.length,
      stageShares,
      effectiveModelCounts: {
        planner: effectiveModelCount(stageShares.planner),
        coder: effectiveModelCount(stageShares.coder),
        reviewer: effectiveModelCount(stageShares.reviewer),
      },
      candidatePools,
    };
  }).filter((breakdown) => breakdown.count > 0);
}

/**
 * Compute candidate-pool evidence coverage from corpus records.
 */
export function buildCandidateEvidence(
  corpus: EvalRecord[],
  candidatePools: Record<AuditStageRole, string[]>,
  threshold: number,
): CandidateEvidenceCoverage {
  const entries: CandidateEvidenceEntry[] = [];
  const warnings: string[] = [];

  for (const role of STAGE_ROLES) {
    const stage = ROLE_TO_STAGE[role];
    const candidates = candidatePools[role];

    for (const model of candidates) {
      const matchingRecords = corpus.filter((record) => recordStageModel(record, stage) === model);
      const totalRecords = matchingRecords.length;

      // Break down by task type, domain, and complexity
      const byTaskType: Record<string, number> = {};
      const byDomain: Record<string, number> = {};
      const byComplexity: Record<string, number> = {};

      for (const record of matchingRecords) {
        const descriptor = buildReplayDescriptor(record);
        const taskType = descriptor.signals.heuristic.task_type || 'unknown';
        const domain = descriptor.signals.learned.domain || 'unknown';
        const complexity = descriptor.signals.learned.complexity;
        const complexityBucket = typeof complexity === 'number'
          ? complexity <= 2 ? 'low' : complexity >= 4 ? 'high' : 'medium'
          : 'unknown';

        byTaskType[taskType] = (byTaskType[taskType] ?? 0) + 1;
        byDomain[domain] = (byDomain[domain] ?? 0) + 1;
        byComplexity[complexityBucket] = (byComplexity[complexityBucket] ?? 0) + 1;
      }

      const isZeroEvidence = totalRecords === 0;
      entries.push({
        model,
        role,
        totalRecords,
        byTaskType,
        byDomain,
        byComplexity,
        isZeroEvidence,
      });

      if (totalRecords < threshold) {
        warnings.push(
          `${role}/${model}: ${totalRecords} records < ${threshold} threshold`,
        );
      }
    }
  }

  return {
    threshold,
    entries: entries.sort((a, b) => {
      if (a.role !== b.role) return a.role.localeCompare(b.role);
      return b.totalRecords - a.totalRecords;
    }),
    warnings,
  };
}

/**
 * Per-row metadata used to validate v2 schema conformance. Callers extract this
 * from exported benchmark rows (e.g. TechnicalTaskRouterContributionRow* shapes
 * or any row-shaped object emitted alongside the audit).
 */
export interface V2RowCheckInput {
  rowId?: string;
  schema_version?: string;
  scorer_ref?: string;
  primary_metric?: string;
}

/**
 * Build v2 conformance check for benchmark audit.
 */
export function buildV2ConformanceCheck(
  scenarioShares: ScenarioSharesBreakdown[] | undefined,
  validityViolationRate: number,
  rows?: V2RowCheckInput[],
): V2ConformanceCheck {
  const benchmarkSpecId = 'technical_task_router/v2';
  const expectedSchemaVersion = 'technical_task_router_row/v2';
  const primaryMetric = 'technical_task_router.benchmark_score/v2';
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check scenario coverage
  const presentScenarios = new Set(scenarioShares?.map((s) => s.scenario) ?? []);
  const missingScenarios = V2_SCENARIOS.filter((scenario) => !presentScenarios.has(scenario));

  if (missingScenarios.length > 0) {
    errors.push(`Missing required scenarios: ${missingScenarios.join(', ')}`);
  }

  // Robustness coverage: at least one challenger-style scenario must be present.
  // sparse_cell is already covered by the missingScenarios block above; we avoid
  // emitting a second error for the same condition.
  if (!presentScenarios.has('challenger_present') && !presentScenarios.has('dominant_model_removed')) {
    warnings.push('Missing both challenger_present and dominant_model_removed scenarios');
  }

  // Row schema checks. When rows are provided, each is validated against the v2
  // contract (schema_version, scorer_ref, primary_metric). When no rows are
  // provided the audit cannot make a positive claim about row conformance and
  // we surface that explicitly as a warning rather than a silent pass.
  const rowSchemaChecks = (() => {
    if (!rows || rows.length === 0) {
      warnings.push('No rows supplied to v2 conformance check; row schema validation skipped');
      return {
        passed: 0,
        failed: 0,
        failures: [] as string[],
      };
    }
    const failures: string[] = [];
    let passed = 0;
    let failed = 0;
    for (const row of rows) {
      const id = row.rowId ?? '<unknown>';
      const rowFailures: string[] = [];
      if (row.schema_version !== expectedSchemaVersion) {
        rowFailures.push(`schema_version=${row.schema_version ?? 'missing'} (expected ${expectedSchemaVersion})`);
      }
      if (row.scorer_ref !== undefined && row.scorer_ref !== primaryMetric) {
        rowFailures.push(`scorer_ref=${row.scorer_ref} (expected ${primaryMetric})`);
      }
      if (row.primary_metric !== undefined && row.primary_metric !== primaryMetric) {
        rowFailures.push(`primary_metric=${row.primary_metric} (expected ${primaryMetric})`);
      }
      if (rowFailures.length === 0) {
        passed += 1;
      } else {
        failed += 1;
        failures.push(`${id}: ${rowFailures.join('; ')}`);
      }
    }
    return { passed, failed, failures };
  })();
  if (rowSchemaChecks.failed > 0) {
    errors.push(`Row schema: ${rowSchemaChecks.failed} of ${rowSchemaChecks.passed + rowSchemaChecks.failed} rows fail v2 conformance`);
  }

  // Guardrail checks - validity violation rate threshold
  const guardrailThreshold = 0.02; // 2% invalid selection rate
  const guardrailChecks = {
    passed: validityViolationRate <= guardrailThreshold,
    violations: validityViolationRate > guardrailThreshold
      ? [`Validity violation rate ${(validityViolationRate * 100).toFixed(1)}% > ${(guardrailThreshold * 100).toFixed(1)}% threshold`]
      : [],
  };

  if (!guardrailChecks.passed) {
    errors.push(...guardrailChecks.violations);
  }

  return {
    benchmarkSpecId,
    expectedSchemaVersion,
    primaryMetric,
    scenarioCoverage: {
      total: presentScenarios.size,
      missingScenarios,
    },
    rowSchemaChecks,
    guardrailChecks,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stageScore(record: EvalRecord, stage: ChallengeStage): number {
  const metadataStageScores = record.metadata?.stageScores as Record<string, { score?: number }> | undefined;
  const metadataScore = metadataStageScores?.[stage]?.score;
  const outcomeScore = record.stageOutcomes?.[stage]?.score;
  const primary = typeof metadataScore === 'number'
    ? metadataScore
    : typeof outcomeScore === 'number'
      ? outcomeScore
      : undefined;
  if (typeof primary === 'number' && typeof record.score === 'number') {
    return Math.max(0, Math.min(1, primary * 0.7 + record.score * 0.3));
  }
  if (typeof primary === 'number') {
    return Math.max(0, Math.min(1, primary));
  }
  return Math.max(0, Math.min(1, typeof record.score === 'number' ? record.score : 0));
}

function neighborScoreForModel(neighbors: ScoredNeighbor[], model: string, stage: ChallengeStage): number | undefined {
  const scores = neighbors
    .filter((neighbor) => recordStageModel(neighbor.record, stage) === model)
    .map((neighbor) => stageScore(neighbor.record, stage));
  return scores.length > 0 ? mean(scores) : undefined;
}

export function computeRegret(
  recommendations: AuditRecommendation[],
  corpusRecords: EvalRecord[],
  kNeighbors = 20,
): Record<AuditStageRole, RegretSummary> {
  const values: Record<AuditStageRole, number[]> = {
    planner: [],
    coder: [],
    reviewer: [],
  };

  for (const recommendation of recommendations) {
    const query = buildReplayDescriptor(recommendation.originalRecord);
    const neighbors = findKNearest(query, corpusRecords.filter((record) => record.id !== recommendation.evalId), kNeighbors);
    for (const role of STAGE_ROLES) {
      const stage = ROLE_TO_STAGE[role];
      const recommendedModel = recommendation.strategy[ROLE_TO_STRATEGY_KEY[role]];
      const recommendedScore = neighborScoreForModel(neighbors, recommendedModel, stage);
      if (recommendedScore === undefined) continue;

      const candidateScores = recommendation.candidatePools[role]
        .map((model) => neighborScoreForModel(neighbors, model, stage))
        .filter((score): score is number => typeof score === 'number');
      if (candidateScores.length === 0) continue;
      values[role].push(Math.max(0, Math.max(...candidateScores) - recommendedScore));
    }
  }

  return Object.fromEntries(
    STAGE_ROLES.map((role) => {
      const roleValues = values[role];
      const meanRegret = mean(roleValues);
      return [role, {
        count: roleValues.length,
        meanRegret,
        dominated: roleValues.length > 0 && meanRegret > 0.15,
      }];
    }),
  ) as Record<AuditStageRole, RegretSummary>;
}

async function callHokusai(
  request: HokusaiModel30Request,
  options: { endpoint: string; token: string; timeoutMs: number; fetchFn: typeof fetch },
): Promise<{ response?: HokusaiModel30Response; failure?: Omit<AuditFailure, 'evalId'> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchFn(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        failure: {
          classification: classifyHokusaiFailure(null, response),
          detail: `HTTP ${response.status}`,
        },
      };
    }
    const payload = await response.json();
    if (!isHokusaiModel30Response(payload)) {
      return {
        failure: {
          classification: 'invalid_response',
          detail: 'missing predictions.recommended_strategy',
        },
      };
    }
    return { response: payload };
  } catch (error) {
    return {
      failure: {
        classification: classifyHokusaiFailure(error),
        detail: errorMessage(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const current = next;
      next += 1;
      results[current] = await mapper(values[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function syntheticProbeRequests(base: AuditRequestRecord[]): AuditRequestRecord[] {
  const first = base[0];
  if (!first) return [];
  const pools = first.candidatePools;
  const prompts = [
    'Update documentation for an existing CLI flag and add examples.',
    'Fix production infrastructure deployment failure involving networking, secrets, and rollback risk.',
    'Make a trivial copy-only UI label change.',
    'Implement a high-complexity data migration touching API, storage, tests, and observability.',
  ];
  return prompts.map((prompt, index) => {
    const descriptor = buildTaskDescriptor({ originalPrompt: prompt });
    return {
      evalId: `sensitivity-${index + 1}`,
      request: toHokusaiModel30Request(descriptor, descriptor.repoContext, {
        description: prompt,
        externalTaskId: `sensitivity-${index + 1}`,
        plannerModels: pools.planner,
        coderModels: pools.coder,
        reviewerModels: pools.reviewer,
        modelsAvailable: [...new Set([...pools.planner, ...pools.coder, ...pools.reviewer])],
        workflowStages: ['plan', 'code', 'review'],
      }),
      descriptor,
      originalRecord: first.originalRecord,
      candidatePools: pools,
    };
  });
}

function resolveToken(repoDir: string | undefined, override?: string): string | undefined {
  if (override?.trim()) return override.trim();
  const config = getHokusaiRouterConfig(repoDir);
  const envVarName = config.apiKeyEnv || 'HOKUSAI_API_TOKEN';
  return resolveEnvValue([envVarName, 'HOKUSAI_API_KEY'], repoDir) || config.apiKey?.trim();
}

function hardFailures(report: Omit<HokusaiAuditReport, 'hardFailures'>, threshold: number): string[] {
  const failures: string[] = [];
  for (const warning of report.dominanceWarnings) {
    failures.push(`${warning.role} dominance ${warning.model} ${(warning.share * 100).toFixed(1)}% > ${(warning.threshold * 100).toFixed(1)}%`);
  }
  for (const [role, count] of Object.entries(report.effectiveModelCounts)) {
    if (count < 2) {
      failures.push(`${role} effective model count ${count.toFixed(2)} < 2`);
    }
  }
  if (report.validityViolationRate > 0.01) {
    failures.push(`validity violation rate ${(report.validityViolationRate * 100).toFixed(1)}% > 1.0%`);
  }
  if (report.determinism.allStable && report.sensitivity.allIdentical) {
    failures.push('constant-output detector fired');
  }
  // Candidate-pool evidence hard-fails when any current (non-challenger) candidate
  // has zero evidence in the corpus. Below-threshold-but-nonzero entries remain
  // warnings (report.candidateEvidence.warnings).
  if (report.candidateEvidence) {
    const zeroEvidence = report.candidateEvidence.entries.filter((entry) => entry.isZeroEvidence);
    if (zeroEvidence.length > 0) {
      const summary = zeroEvidence
        .slice(0, 5)
        .map((entry) => `${entry.role}/${entry.model}`)
        .join(', ');
      const suffix = zeroEvidence.length > 5 ? ` (+${zeroEvidence.length - 5} more)` : '';
      failures.push(`candidate-pool zero-evidence: ${summary}${suffix}`);
    }
  }
  return failures;
}

export async function runHokusaiRouterAudit(options: HokusaiAuditOptions = {}): Promise<HokusaiAuditReport> {
  const repoDir = resolve(options.repoDir || process.cwd());
  const config = getHokusaiRouterConfig(repoDir);
  const endpoint = options.endpoint || config.endpoint || DEFAULT_HOKUSAI_MODEL30_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? config.timeout ?? DEFAULT_HOKUSAI_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const coverage = resolveCoverageConfig({ ...getRouterConfig(repoDir).coverage, maxStageShare: options.maxShare });
  const corpus = loadStageAwareEvalRecords({ repoDir });
  const sampled = stratifiedSampleRecords(corpus, options.sample ?? 100);
  const requests = buildAuditRequests(sampled, { repoDir, redact: options.redact !== false });
  const constructionFailures = requestConstructionFailures(sampled);
  const generatedAt = (options.now ?? new Date()).toISOString();

  if (options.dryRun) {
    const emptyShares = { planner: [], coder: [], reviewer: [] };
    const reportWithoutFailures: Omit<HokusaiAuditReport, 'hardFailures'> = {
      generatedAt,
      endpoint,
      dryRun: true,
      redacted: options.redact !== false,
      corpusRecords: corpus.length,
      sampledRecords: sampled.length,
      successfulResponses: 0,
      failures: constructionFailures,
      stageShares: emptyShares,
      effectiveModelCounts: { planner: 0, coder: 0, reviewer: 0 },
      dominanceWarnings: [],
      validityViolations: [],
      validityViolationRate: 0,
      determinism: { attempted: 0, stablePairs: 0, allStable: false },
      sensitivity: { attempted: 0, distinctRecommendationCount: 0, allIdentical: false },
      calibration: [],
      regret: {
        planner: { count: 0, meanRegret: 0, dominated: false },
        coder: { count: 0, meanRegret: 0, dominated: false },
        reviewer: { count: 0, meanRegret: 0, dominated: false },
      },
      groupBreakdowns: {
        'descriptor.taskType': [],
        'descriptor.complexity': [],
        'descriptor.domain': [],
        'request.taskType': [],
        'request.complexity': [],
        'request.domain': [],
      },
    };
    return { ...reportWithoutFailures, hardFailures: [], artifactPath: persistAuditReport(reportWithoutFailures, options.output, repoDir) };
  }

  const token = resolveToken(repoDir, options.token);
  if (!token) {
    throw new Error('Missing Hokusai API token. Set HOKUSAI_API_TOKEN or pass --token-env.');
  }

  const rawResults = await mapConcurrent(
    requests,
    clampConcurrency(options.concurrency),
    async (entry) => {
      const result = await callHokusai(entry.request, { endpoint, token, timeoutMs, fetchFn });
      return { entry, result };
    },
  );

  const recommendations: AuditRecommendation[] = [];
  const failures: AuditFailure[] = [...constructionFailures];
  for (const { entry, result } of rawResults) {
    if (result.response) {
      recommendations.push({
        evalId: entry.evalId,
        issueId: entry.issueId,
        strategy: result.response.predictions.recommended_strategy,
        response: result.response,
        request: entry.request,
        candidatePools: entry.candidatePools,
        originalRecord: entry.originalRecord,
        actualScore: entry.originalRecord.score,
        actualStageModels: actualStageModels(entry.originalRecord),
      });
    } else if (result.failure) {
      failures.push({ evalId: entry.evalId, ...result.failure });
    }
  }

  const determinismPairs = await mapConcurrent(requests.slice(0, 5), 2, async (entry) => {
    const [left, right] = await Promise.all([
      callHokusai(entry.request, { endpoint, token, timeoutMs, fetchFn }),
      callHokusai(entry.request, { endpoint, token, timeoutMs, fetchFn }),
    ]);
    return [left.response?.predictions.recommended_strategy, right.response?.predictions.recommended_strategy]
      .filter((strategy): strategy is HokusaiRecommendedStrategy => Boolean(strategy));
  });

  const sensitivityStrategies = await mapConcurrent(syntheticProbeRequests(requests), 2, async (entry) => {
    const result = await callHokusai(options.redact === false ? entry.request : redactModel30Request(entry.request), { endpoint, token, timeoutMs, fetchFn });
    return result.response?.predictions.recommended_strategy;
  });

  const stageShares = buildStageShares(recommendations);
  const validityViolations = classifyValidityViolations(recommendations, repoDir);

  // Build scenario shares, candidate evidence, and conformance for v2 if requested
  let scenarioShares: ScenarioSharesBreakdown[] | undefined;
  let candidateEvidence: CandidateEvidenceCoverage | undefined;
  let v2Conformance: V2ConformanceCheck | undefined;
  if (options.benchmarkVersion === 'v2') {
    // Generate request variants across all v2 scenarios. production_pool is
    // reused from the recommendations already computed above to avoid duplicate
    // API calls; the other scenarios run live through the router.
    const scenarioRequestMap = buildAuditRequestsWithScenarios(sampled, corpus, {
      repoDir,
      redact: options.redact !== false,
    });
    scenarioRequestMap.set('production_pool', requests);
    const scenarioRecommendationMap = new Map<AuditScenario, AuditRecommendation[]>();
    scenarioRecommendationMap.set('production_pool', recommendations);

    for (const scenario of V2_SCENARIOS) {
      if (scenario === 'production_pool') continue;
      const scenarioReqs = scenarioRequestMap.get(scenario);
      if (!scenarioReqs || scenarioReqs.length === 0) continue;
      const scenarioResults = await mapConcurrent(
        scenarioReqs,
        clampConcurrency(options.concurrency),
        async (entry) => {
          const result = await callHokusai(entry.request, { endpoint, token, timeoutMs, fetchFn });
          return { entry, result };
        },
      );
      const scenarioRecs: AuditRecommendation[] = [];
      for (const { entry, result } of scenarioResults) {
        if (result.response) {
          scenarioRecs.push({
            evalId: entry.evalId,
            issueId: entry.issueId,
            strategy: result.response.predictions.recommended_strategy,
            response: result.response,
            request: entry.request,
            candidatePools: entry.candidatePools,
            originalRecord: entry.originalRecord,
            actualScore: entry.originalRecord.score,
            actualStageModels: actualStageModels(entry.originalRecord),
          });
        } else if (result.failure) {
          failures.push({ evalId: entry.evalId, ...result.failure });
        }
      }
      scenarioRecommendationMap.set(scenario, scenarioRecs);
    }

    scenarioShares = buildScenarioShares(scenarioRequestMap, scenarioRecommendationMap);

    // Compute candidate evidence coverage
    const pools = candidatePools(repoDir);
    candidateEvidence = buildCandidateEvidence(corpus, pools, coverage.minRecordsPerModelStage);

    // Build v2 conformance check
    const validityRate = recommendations.length > 0
      ? validityViolations.length / (recommendations.length * 3)
      : 0;
    v2Conformance = buildV2ConformanceCheck(scenarioShares, validityRate);
  }

  const reportWithoutFailures: Omit<HokusaiAuditReport, 'hardFailures'> = {
    generatedAt,
    endpoint,
    dryRun: false,
    redacted: options.redact !== false,
    corpusRecords: corpus.length,
    sampledRecords: sampled.length,
    successfulResponses: recommendations.length,
    failures,
    stageShares,
    effectiveModelCounts: {
      planner: effectiveModelCount(stageShares.planner),
      coder: effectiveModelCount(stageShares.coder),
      reviewer: effectiveModelCount(stageShares.reviewer),
    },
    dominanceWarnings: STAGE_ROLES.flatMap((role) => stageShares[role]
      .filter((entry) => entry.share > coverage.maxStageShare)
      .map((entry) => ({ role, model: entry.model, share: entry.share, threshold: coverage.maxStageShare }))),
    validityViolations,
    validityViolationRate: recommendations.length > 0
      ? validityViolations.length / (recommendations.length * 3)
      : 0,
    determinism: summarizeDeterminism(determinismPairs),
    sensitivity: summarizeSensitivity(sensitivityStrategies.filter((strategy): strategy is HokusaiRecommendedStrategy => Boolean(strategy))),
    calibration: buildCalibration(recommendations),
    regret: computeRegret(recommendations, corpus, options.kNeighbors ?? 20),
    groupBreakdowns: buildGroupBreakdowns(recommendations),
    scenarioShares,
    candidateEvidence,
    v2Conformance,
  };
  const completeReport = {
    ...reportWithoutFailures,
    hardFailures: hardFailures(reportWithoutFailures, coverage.maxStageShare),
  };
  return {
    ...completeReport,
    artifactPath: persistAuditReport(completeReport, options.output, repoDir),
  };
}

function persistAuditReport(report: Omit<HokusaiAuditReport, 'artifactPath'>, outputPath: string | undefined, repoDir: string): string {
  const path = outputPath || resolve(repoDir, `.wavemill/evals/hokusai-audit-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatHokusaiAuditReport(report: HokusaiAuditReport): string {
  const lines: string[] = [];
  lines.push(`Hokusai router audit — ${report.successfulResponses}/${report.sampledRecords} responses from ${report.corpusRecords} corpus records`);
  lines.push(`Endpoint: ${report.endpoint}`);
  lines.push(`Redacted: ${report.redacted ? 'yes' : 'no'}${report.dryRun ? ' (dry run)' : ''}`);
  lines.push('');

  for (const role of STAGE_ROLES) {
    lines.push(`Recommendation share — ${role} (effective model count ${formatNumber(report.effectiveModelCounts[role])})`);
    const entries = report.stageShares[role];
    if (entries.length === 0) {
      lines.push('  (no recommendations)');
    } else {
      const width = Math.max(5, ...entries.map((entry) => entry.model.length));
      for (const entry of entries) {
        lines.push(`  ${entry.model.padEnd(width)}  ${String(entry.count).padStart(4)}  ${formatPercent(entry.share).padStart(6)}`);
      }
    }
    lines.push('');
  }

  // V2 scenario shares
  if (report.scenarioShares && report.scenarioShares.length > 0) {
    lines.push('V2 Scenario Shares');
    for (const scenario of report.scenarioShares) {
      lines.push(`  ${scenario.scenario} (n=${scenario.count})`);
      for (const role of STAGE_ROLES) {
        const entries = scenario.stageShares[role];
        if (entries.length > 0) {
          const top = entries[0];
          lines.push(`    ${role.padEnd(8)}: ${top.model} ${formatPercent(top.share)} (eff=${formatNumber(scenario.effectiveModelCounts[role])})`);
        }
      }
    }
    lines.push('');
  }

  // V2 candidate evidence coverage
  if (report.candidateEvidence) {
    lines.push(`Candidate Evidence Coverage (threshold: ${report.candidateEvidence.threshold})`);
    const zeroEvidenceEntries = report.candidateEvidence.entries.filter((e) => e.isZeroEvidence);
    if (zeroEvidenceEntries.length > 0) {
      lines.push('  Zero-evidence candidates:');
      for (const entry of zeroEvidenceEntries) {
        lines.push(`    ${entry.role}/${entry.model}: 0 records`);
      }
    }
    const belowThreshold = report.candidateEvidence.entries.filter((e) => !e.isZeroEvidence && e.totalRecords < report.candidateEvidence.threshold);
    if (belowThreshold.length > 0) {
      lines.push('  Below-threshold candidates:');
      for (const entry of belowThreshold.slice(0, 10)) {
        const topTask = Object.entries(entry.byTaskType).sort((a, b) => b[1] - a[1])[0];
        const topDomain = Object.entries(entry.byDomain).sort((a, b) => b[1] - a[1])[0];
        lines.push(`    ${entry.role}/${entry.model}: ${entry.totalRecords} records (task:${topTask?.[0] || 'none'} domain:${topDomain?.[0] || 'none'})`);
      }
      if (belowThreshold.length > 10) {
        lines.push(`    ... ${belowThreshold.length - 10} more`);
      }
    }
    if (report.candidateEvidence.warnings.length > 0) {
      lines.push(`  Warnings: ${report.candidateEvidence.warnings.length}`);
    }
    lines.push('');
  }

  // V2 conformance check
  if (report.v2Conformance) {
    lines.push(`V2 Conformance Check (${report.v2Conformance.ok ? 'PASS' : 'FAIL'})`);
    lines.push(`  Benchmark spec: ${report.v2Conformance.benchmarkSpecId}`);
    lines.push(`  Primary metric: ${report.v2Conformance.primaryMetric}`);
    lines.push(`  Scenario coverage: ${report.v2Conformance.scenarioCoverage.total}/${V2_SCENARIOS.length}`);
    if (report.v2Conformance.scenarioCoverage.missingScenarios.length > 0) {
      lines.push(`    Missing: ${report.v2Conformance.scenarioCoverage.missingScenarios.join(', ')}`);
    }
    lines.push(`  Row schema: ${report.v2Conformance.rowSchemaChecks.passed} passed, ${report.v2Conformance.rowSchemaChecks.failed} failed`);
    lines.push(`  Guardrail checks: ${report.v2Conformance.guardrailChecks.passed ? 'PASS' : 'FAIL'}`);
    if (report.v2Conformance.errors.length > 0) {
      lines.push('  Errors:');
      for (const error of report.v2Conformance.errors) {
        lines.push(`    - ${error}`);
      }
    }
    if (report.v2Conformance.warnings.length > 0) {
      lines.push('  Warnings:');
      for (const warning of report.v2Conformance.warnings) {
        lines.push(`    - ${warning}`);
      }
    }
    lines.push('');
  }

  lines.push(`Validity violations: ${report.validityViolations.length} (${formatPercent(report.validityViolationRate)})`);
  for (const violation of report.validityViolations.slice(0, 20)) {
    lines.push(`  ${violation.evalId} ${violation.role} ${violation.model}: ${violation.reasons.join(', ')}`);
  }
  if (report.validityViolations.length > 20) {
    lines.push(`  ... ${report.validityViolations.length - 20} more`);
  }
  lines.push('');

  lines.push(`Determinism: ${report.determinism.stablePairs}/${report.determinism.attempted} identical duplicate pairs`);
  lines.push(`Sensitivity: ${report.sensitivity.distinctRecommendationCount}/${report.sensitivity.attempted} distinct contrast recommendations`);
  lines.push('');

  lines.push('Calibration');
  if (report.calibration.length === 0) {
    lines.push('  (no exact historical route matches)');
  } else {
    for (const bucket of report.calibration) {
      lines.push(`  ${bucket.bucket} n=${bucket.count} estimated=${formatNumber(bucket.meanEstimatedSuccess)} actual=${formatNumber(bucket.meanActualScore)}`);
    }
  }
  lines.push('');

  lines.push('Hindsight regret');
  for (const role of STAGE_ROLES) {
    const entry = report.regret[role];
    lines.push(`  ${role.padEnd(8)} n=${String(entry.count).padStart(3)} mean=${formatNumber(entry.meanRegret)}${entry.dominated ? ' dominated' : ''}`);
  }

  const descriptorTaskType = report.groupBreakdowns['descriptor.taskType'] || [];
  if (descriptorTaskType.length > 0) {
    lines.push('');
    lines.push('Task type routing (descriptor)');
    for (const group of descriptorTaskType) {
      const topCoder = group.stageShares.coder[0];
      const topPlanner = group.stageShares.planner[0];
      const topReviewer = group.stageShares.reviewer[0];
      lines.push(`  ${group.group.padEnd(8)} n=${String(group.count).padStart(3)} planner=${topPlanner?.model || '-'} ${topPlanner ? formatPercent(topPlanner.share) : ''} coder=${topCoder?.model || '-'} ${topCoder ? formatPercent(topCoder.share) : ''} reviewer=${topReviewer?.model || '-'} ${topReviewer ? formatPercent(topReviewer.share) : ''}`);
    }
  }

  if (report.failures.length > 0) {
    lines.push('');
    lines.push(`API failures: ${report.failures.length}`);
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(`  ${failure.evalId}: ${failure.classification} (${failure.detail})`);
    }
  }

  if (report.hardFailures.length > 0) {
    lines.push('');
    lines.push('Hard failures');
    for (const failure of report.hardFailures) {
      lines.push(`  ${failure}`);
    }
  }

  if (report.artifactPath) {
    lines.push('');
    lines.push(`Artifact: ${report.artifactPath}`);
  }

  return lines.join('\n');
}
