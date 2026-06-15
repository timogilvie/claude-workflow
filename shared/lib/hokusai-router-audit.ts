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
import { loadLaunchPriorityList, type ModelFamily, type ModelStatus } from './openrouter-catalog.ts';
import { resolveEnvValue } from './env-file.ts';
import { errorMessage } from './error-utils.ts';
import { toHokusaiModel30Request, type HokusaiModel30Response, type HokusaiModel30Request, type HokusaiRecommendedStrategy } from './hokusai-schema.ts';
import { classifyHokusaiFailure, DEFAULT_HOKUSAI_MODEL30_ENDPOINT, DEFAULT_HOKUSAI_TIMEOUT_MS, isHokusaiModel30Response, type HokusaiFailureClassification } from './hokusai-router.ts';
import { getConfiguredModelsForDescriptorStage, getEffectiveRegistry } from './model-registry.ts';
import { isDisabledModel } from './disabled-models.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { findKNearest, loadStageAwareEvalRecords, type ScoredNeighbor } from './stage-aware-router.ts';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';

export type AuditStageRole = 'planner' | 'coder' | 'reviewer';

const STAGE_ROLES: readonly AuditStageRole[] = ['planner', 'coder', 'reviewer'];
const DIVERSITY_STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];
const DEFAULT_MAX_STAGE_SHARE = 0.7;

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
}

export interface AuditRequestRecord {
  evalId: string;
  issueId?: string;
  request: HokusaiModel30Request;
  descriptor: TaskDescriptor;
  originalRecord: EvalRecord;
  candidatePools: Record<AuditStageRole, string[]>;
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
  request: HokusaiModel30Request;
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
  launchPriorityCoverage: LaunchPriorityCoverageEntry[];
  hardFailures: string[];
  artifactPath?: string;
}

export interface AuditGroupBreakdown {
  group: string;
  count: number;
  stageShares: Record<AuditStageRole, StageShareEntry[]>;
  effectiveModelCounts: Record<AuditStageRole, number>;
}

export interface StageShareEntry {
  model: string;
  count: number;
  share: number;
}

export interface LaunchPriorityCoverageEntry {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  status: ModelStatus;
  priorityTier: number;
  evidenceCount: number;
  isZeroEvidence: boolean;
}

interface CoverageConfig {
  maxStageShare?: number;
}

function resolveCoverageConfig(raw?: CoverageConfig): { maxStageShare: number } {
  return {
    maxStageShare: typeof raw?.maxStageShare === 'number'
      && Number.isFinite(raw.maxStageShare)
      && raw.maxStageShare > 0
      && raw.maxStageShare <= 1
      ? raw.maxStageShare
      : DEFAULT_MAX_STAGE_SHARE,
  };
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

function recordStageModel(record: EvalRecord, stage: ChallengeStage): string | undefined {
  if (stage === 'plan') {
    return record.taskDescriptor?.stages?.planner?.model;
  }
  if (stage === 'review') {
    return record.taskDescriptor?.stages?.reviewer?.model;
  }
  return record.taskDescriptor?.stages?.coder?.model || record.modelId || undefined;
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

function descriptorGroupValue(recommendation: AuditRecommendation, groupBy: string): string {
  const descriptor = buildReplayDescriptor(recommendation.originalRecord);
  const key = groupBy.replace('_descriptor', '');
  if (key === 'taskType') {
    return descriptor.signals.heuristic.task_type || 'unknown';
  }
  if (key === 'complexity') {
    const complexity = descriptor.signals.learned.complexity;
    if (typeof complexity !== 'number') return 'unknown';
    if (complexity <= 2) return 'low';
    if (complexity >= 4) return 'high';
    return 'medium';
  }
  if (key === 'domain') {
    return descriptor.signals.learned.domain || 'unknown';
  }
  return 'unknown';
}

function requestGroupValue(recommendation: AuditRecommendation, groupBy: string): string {
  if (groupBy === 'taskType') {
    return recommendation.request.inputs.task.task_type;
  }
  if (groupBy === 'complexity') {
    return recommendation.request.inputs.context?.estimated_complexity ?? 'unknown';
  }
  if (groupBy === 'domain') {
    return recommendation.request.inputs.context?.domain ?? 'unknown';
  }
  return 'unknown';
}

export function buildGroupBreakdowns(recommendations: AuditRecommendation[]): Record<string, AuditGroupBreakdown[]> {
  const groups = [
    ['taskType', requestGroupValue],
    ['complexity', requestGroupValue],
    ['domain', requestGroupValue],
    ['taskType_descriptor', descriptorGroupValue],
    ['complexity_descriptor', descriptorGroupValue],
    ['domain_descriptor', descriptorGroupValue],
  ] as const;
  return Object.fromEntries(groups.map(([groupBy, groupValue]) => {
    const byValue = new Map<string, AuditRecommendation[]>();
    for (const recommendation of recommendations) {
      const value = groupValue(recommendation, groupBy);
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

export function buildLaunchPriorityCoverage(
  recommendations: AuditRecommendation[],
  launchPriorityList = loadLaunchPriorityList(),
): LaunchPriorityCoverageEntry[] {
  const evidenceCounts = new Map<string, number>();

  for (const recommendation of recommendations) {
    for (const model of [
      recommendation.strategy.planner_model,
      recommendation.strategy.coder_model,
      recommendation.strategy.reviewer_model,
    ]) {
      evidenceCounts.set(model, (evidenceCounts.get(model) ?? 0) + 1);
    }
  }

  return launchPriorityList
    .filter((model) => model.status === 'active' || model.status === 'watchlist')
    .map((model) => {
      const evidenceCount = evidenceCounts.get(model.wavemillAlias) ?? 0;
      return {
        wavemillAlias: model.wavemillAlias,
        openrouterId: model.openrouterId,
        family: model.family,
        status: model.status,
        priorityTier: model.priorityTier,
        evidenceCount,
        isZeroEvidence: evidenceCount === 0,
      };
    })
    .sort((left, right) =>
      left.priorityTier - right.priorityTier
      || Number(right.isZeroEvidence) - Number(left.isZeroEvidence)
      || left.wavemillAlias.localeCompare(right.wavemillAlias));
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
        taskType: [],
        complexity: [],
        domain: [],
        taskType_descriptor: [],
        complexity_descriptor: [],
        domain_descriptor: [],
      },
      launchPriorityCoverage: buildLaunchPriorityCoverage([]),
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
    const shouldRedact = options.redact !== false && !entry.evalId.startsWith('sensitivity-');
    const result = await callHokusai(shouldRedact ? redactModel30Request(entry.request) : entry.request, { endpoint, token, timeoutMs, fetchFn });
    return result.response?.predictions.recommended_strategy;
  });

  const stageShares = buildStageShares(recommendations);
  const validityViolations = classifyValidityViolations(recommendations, repoDir);
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
    launchPriorityCoverage: buildLaunchPriorityCoverage(recommendations),
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

  const groupSections: Array<[string, string]> = [
    ['taskType', 'Task type routing (request-normalized)'],
    ['complexity', 'Complexity routing (request-normalized)'],
    ['domain', 'Domain routing (request-normalized)'],
    ['taskType_descriptor', 'Task type routing (descriptor-derived)'],
    ['complexity_descriptor', 'Complexity routing (descriptor-derived)'],
    ['domain_descriptor', 'Domain routing (descriptor-derived)'],
  ];

  const hasGroupBreakdowns = groupSections.some(([key]) => (report.groupBreakdowns[key] ?? []).length > 0);
  if (hasGroupBreakdowns) {
    lines.push('');
    for (const [key, label] of groupSections) {
      const entries = report.groupBreakdowns[key] ?? [];
      if (entries.length === 0) continue;
      lines.push(label);
      for (const group of entries) {
        const topCoder = group.stageShares.coder[0];
        const topPlanner = group.stageShares.planner[0];
        const topReviewer = group.stageShares.reviewer[0];
        lines.push(`  ${group.group.padEnd(8)} n=${String(group.count).padStart(3)} planner=${topPlanner?.model || '-'} ${topPlanner ? formatPercent(topPlanner.share) : ''} coder=${topCoder?.model || '-'} ${topCoder ? formatPercent(topCoder.share) : ''} reviewer=${topReviewer?.model || '-'} ${topReviewer ? formatPercent(topReviewer.share) : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('Launch-priority coverage');
  if (report.launchPriorityCoverage.length === 0) {
    lines.push('  (no launch-priority models configured)');
  } else {
    for (const entry of report.launchPriorityCoverage) {
      lines.push(
        `  ${entry.wavemillAlias.padEnd(20)} evidence=${String(entry.evidenceCount).padStart(3)} tier=${entry.priorityTier} ${entry.status} ${entry.family} ${entry.isZeroEvidence ? 'ZERO' : entry.openrouterId}`,
      );
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
