/**
 * Challenge scheduling policy for exploration-driven routing.
 *
 * Produces advisory recommendations only. It does not launch challenges or
 * mutate any persisted state.
 *
 * @module challenge-scheduler
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { loadConfiguredPricingTable } from './workflow-cost.ts';
import type { StageAwareDecision } from './stage-aware-router.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';
import { loadRouterConfig } from './model-router.ts';

export type ChallengeReason = 'low-confidence' | 'new-model' | 'low-data-stage' | 'disabled';
export type ChallengeStage = 'plan' | 'implementation' | 'review';

export interface ChallengeRecommendation {
  shouldChallenge: boolean;
  reason: ChallengeReason;
  challengerModel?: string;
  defaultModel?: string;
  stage?: ChallengeStage;
  priority: number;
}

export interface ChallengeSchedulerConfig {
  enabled?: boolean;
  confidenceThreshold?: number;
  newModelChallengeCount?: number;
  minEvalRecordsPerStage?: number;
  maxConcurrentChallenges?: number;
}

export interface EvalSummary {
  totalRecords: number;
  recordsByModel: Record<string, number>;
  recordsByStage: Record<string, number>;
}

export interface ChallengeSchedulerInput {
  routingDecision: WorkflowRouteDecision | StageAwareDecision;
  evalSummary: EvalSummary;
  config: ChallengeSchedulerConfig;
  repoDir?: string;
  forceModel?: string;
}

const DEFAULT_CHALLENGE_SCHEDULER_CONFIG: Required<ChallengeSchedulerConfig> = {
  enabled: true,
  confidenceThreshold: 0.7,
  newModelChallengeCount: 5,
  minEvalRecordsPerStage: 10,
  maxConcurrentChallenges: 2,
};

const PRIORITY = {
  'low-confidence': 300,
  'new-model': 200,
  'low-data-stage': 100,
  disabled: 0,
} as const satisfies Record<ChallengeReason, number>;

const STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];
const evalSummaryCache = new Map<string, EvalSummary>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfig(config: ChallengeSchedulerConfig): Required<ChallengeSchedulerConfig> {
  return {
    enabled: config.enabled ?? DEFAULT_CHALLENGE_SCHEDULER_CONFIG.enabled,
    confidenceThreshold: Number.isFinite(config.confidenceThreshold)
      ? clamp(config.confidenceThreshold as number, 0, 1)
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.confidenceThreshold,
    newModelChallengeCount: Number.isInteger(config.newModelChallengeCount) && (config.newModelChallengeCount as number) > 0
      ? config.newModelChallengeCount as number
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.newModelChallengeCount,
    minEvalRecordsPerStage: Number.isInteger(config.minEvalRecordsPerStage) && (config.minEvalRecordsPerStage as number) > 0
      ? config.minEvalRecordsPerStage as number
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.minEvalRecordsPerStage,
    maxConcurrentChallenges: Number.isInteger(config.maxConcurrentChallenges) && (config.maxConcurrentChallenges as number) > 0
      ? config.maxConcurrentChallenges as number
      : DEFAULT_CHALLENGE_SCHEDULER_CONFIG.maxConcurrentChallenges,
  };
}

function getDecisionModel(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  stage?: ChallengeStage,
): string {
  if (stage === 'plan') return routingDecision.planner;
  if (stage === 'review') return routingDecision.reviewer;
  return routingDecision.coder;
}

function getDefaultModel(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  repoDir?: string,
): string {
  const routerConfig = loadRouterConfig(repoDir);
  return routerConfig.defaultModel || routingDecision.coder;
}

function getAvailableModels(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  repoDir?: string,
): string[] {
  const routerConfig = loadRouterConfig(repoDir);
  const pricingModels = Object.keys(loadConfiguredPricingTable(repoDir));
  return [...new Set([
    ...(routerConfig.models || []),
    ...pricingModels,
    routingDecision.planner,
    routingDecision.coder,
    routingDecision.reviewer,
    routerConfig.defaultModel || '',
  ].filter(Boolean))];
}

function chooseLeastTestedModel(
  models: string[],
  recordsByModel: Record<string, number>,
  excludedModels: string[],
): string | undefined {
  const excluded = new Set(excludedModels.filter(Boolean));
  const candidates = [...new Set(models.filter((model) => !excluded.has(model)))];
  return candidates
    .sort((left, right) => {
      const leftCount = recordsByModel[left] ?? 0;
      const rightCount = recordsByModel[right] ?? 0;
      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }
      return left.localeCompare(right);
    })[0];
}

function checkLowConfidence(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  recordsByModel: Record<string, number>,
  threshold: number,
  availableModels: string[],
  repoDir?: string,
): ChallengeRecommendation | null {
  const confidence = Number.isFinite(routingDecision.confidence)
    ? clamp(routingDecision.confidence, 0, 1)
    : 0.5;

  if (confidence >= threshold) {
    return null;
  }

  const primaryModel = routingDecision.coder;
  const defaultModel = getDefaultModel(routingDecision, repoDir);
  const challengerModel = defaultModel !== primaryModel
    ? defaultModel
    : chooseLeastTestedModel(availableModels, recordsByModel, [primaryModel]);

  if (!challengerModel || challengerModel === primaryModel) {
    return null;
  }

  return {
    shouldChallenge: true,
    reason: 'low-confidence',
    defaultModel: primaryModel,
    challengerModel,
    priority: PRIORITY['low-confidence'],
  };
}

function checkNewModel(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  recordsByModel: Record<string, number>,
  maxRecords: number,
  availableModels: string[],
  repoDir?: string,
): ChallengeRecommendation | null {
  const defaultModel = getDefaultModel(routingDecision, repoDir);
  const challengerModel = [...new Set(availableModels)]
    .filter((model) => model !== defaultModel && (recordsByModel[model] ?? 0) < maxRecords)
    .sort((left, right) => {
      const leftCount = recordsByModel[left] ?? 0;
      const rightCount = recordsByModel[right] ?? 0;
      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }
      return left.localeCompare(right);
    })[0];

  if (!challengerModel) {
    return null;
  }

  return {
    shouldChallenge: true,
    reason: 'new-model',
    defaultModel,
    challengerModel,
    priority: PRIORITY['new-model'],
  };
}

function checkLowDataStage(
  routingDecision: WorkflowRouteDecision | StageAwareDecision,
  summary: EvalSummary,
  minEvalRecordsPerStage: number,
  availableModels: string[],
): ChallengeRecommendation | null {
  const lowStage = STAGES
    .map((stage) => ({ stage, count: summary.recordsByStage[stage] ?? 0 }))
    .filter(({ count }) => count < minEvalRecordsPerStage)
    .sort((left, right) => {
      if (left.count !== right.count) {
        return left.count - right.count;
      }
      return STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage);
    })[0];

  if (!lowStage) {
    return null;
  }

  const defaultModel = getDecisionModel(routingDecision, lowStage.stage);
  const challengerModel = chooseLeastTestedModel(availableModels, summary.recordsByModel, [defaultModel]);
  if (!challengerModel) {
    return null;
  }

  return {
    shouldChallenge: true,
    reason: 'low-data-stage',
    defaultModel,
    challengerModel,
    stage: lowStage.stage,
    priority: PRIORITY['low-data-stage'],
  };
}

/**
 * Evaluate whether routing context should trigger an exploration challenge.
 */
export function evaluateChallenge(input: ChallengeSchedulerInput): ChallengeRecommendation {
  if ((input.forceModel || '').trim()) {
    return {
      shouldChallenge: false,
      reason: 'disabled',
      priority: PRIORITY.disabled,
    };
  }

  const config = normalizeConfig(input.config);
  if (!config.enabled) {
    return {
      shouldChallenge: false,
      reason: 'disabled',
      priority: PRIORITY.disabled,
    };
  }

  const availableModels = getAvailableModels(input.routingDecision, input.repoDir);
  const recommendations = [
    checkLowConfidence(
      input.routingDecision,
      input.evalSummary.recordsByModel,
      config.confidenceThreshold,
      availableModels,
      input.repoDir,
    ),
    checkNewModel(
      input.routingDecision,
      input.evalSummary.recordsByModel,
      config.newModelChallengeCount,
      availableModels,
      input.repoDir,
    ),
    checkLowDataStage(
      input.routingDecision,
      input.evalSummary,
      config.minEvalRecordsPerStage,
      availableModels,
    ),
  ].filter((recommendation): recommendation is ChallengeRecommendation => recommendation !== null);

  return recommendations.sort((left, right) => right.priority - left.priority)[0] || {
    shouldChallenge: false,
    reason: 'disabled',
    priority: PRIORITY.disabled,
  };
}

function recordStagePresence(record: EvalRecord, stage: ChallengeStage): boolean {
  const taskDescriptorStages = record.taskDescriptor?.stages;
  if (stage === 'plan' && taskDescriptorStages?.planner?.model) {
    return true;
  }
  if (stage === 'implementation' && taskDescriptorStages?.coder?.model) {
    return true;
  }
  if (stage === 'review' && taskDescriptorStages?.reviewer?.model) {
    return true;
  }
  if (record.stageOutcomes?.[stage]) {
    return true;
  }
  const metadataStageScores = record.metadata?.stageScores as Record<string, unknown> | undefined;
  return Boolean(metadataStageScores?.[stage]);
}

function recordModelIds(record: EvalRecord): string[] {
  const models = [
    record.taskDescriptor?.stages?.planner?.model,
    record.taskDescriptor?.stages?.coder?.model,
    record.taskDescriptor?.stages?.reviewer?.model,
    record.modelId,
  ].filter((model): model is string => Boolean(model));
  return [...new Set(models)];
}

function getEvalFiles(repoDir: string): string[] {
  const evalsDir = resolve(repoDir, '.wavemill', 'evals');
  if (!existsSync(evalsDir)) {
    return [];
  }

  return readdirSync(evalsDir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => resolve(evalsDir, entry))
    .sort();
}

/**
 * Build a lightweight summary of historical eval coverage for challenge policy.
 *
 * Results are cached per repo for the lifetime of the process.
 */
export function buildEvalSummary(repoDir?: string): EvalSummary {
  const cacheKey = resolve(repoDir || process.cwd());
  const cached = evalSummaryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const summary: EvalSummary = {
    totalRecords: 0,
    recordsByModel: {},
    recordsByStage: {
      plan: 0,
      implementation: 0,
      review: 0,
    },
  };

  const seenRecordIds = new Set<string>();
  for (const filePath of getEvalFiles(cacheKey)) {
    for (const record of readJsonlFile<EvalRecord>(filePath)) {
      const recordKey = record.id || `${record.modelId}:${record.timestamp || ''}:${record.originalPrompt || ''}`;
      if (seenRecordIds.has(recordKey)) {
        continue;
      }
      seenRecordIds.add(recordKey);
      summary.totalRecords += 1;

      for (const modelId of recordModelIds(record)) {
        summary.recordsByModel[modelId] = (summary.recordsByModel[modelId] ?? 0) + 1;
      }

      for (const stage of STAGES) {
        if (recordStagePresence(record, stage)) {
          summary.recordsByStage[stage] = (summary.recordsByStage[stage] ?? 0) + 1;
        }
      }
    }
  }

  evalSummaryCache.set(cacheKey, summary);
  return summary;
}

/**
 * Clear the cached eval summaries.
 *
 * Intended for tests and long-lived processes that need fresh filesystem data.
 */
export function clearChallengeSchedulerCache(repoDir?: string): void {
  if (repoDir) {
    evalSummaryCache.delete(resolve(repoDir));
    return;
  }
  evalSummaryCache.clear();
}
