/**
 * Eval record builder — attach metadata to eval records.
 *
 * Provides functions to enrich eval records with:
 * - Difficulty analysis results
 * - Task context analysis results
 * - Repo context analysis results
 * - Workflow cost computation results
 * - Agent type
 *
 * All functions mutate the record in place (following existing patterns).
 *
 * @module eval-record-builder
 */

import type {
  EvalChallengeRouteContext,
  EvalRecord,
  EligibilityErrorCode,
  PlanCritique,
  RubricEval,
  TaskContext,
  RepoContext,
  StageOutcomes,
  FallbackEventMetadata,
  TaskDescriptor,
  EvalConstraints,
  ManifestRef,
  RoutingDecision,
  RubricCriterion,
} from './eval-schema.ts';
import type { DifficultyAnalysis } from './difficulty-analyzer.ts';
import type { ChallengeRouteContext } from './challenge-mode.ts';
import type { WorkflowCostOutcome, WorkflowCostResult, WorkflowCostFailure } from './workflow-cost.ts';
import { getManifest, getManifestRef } from './resource-manifest.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';
import { getResource } from './resource-registry.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

// Note: Using TaskContext and RepoContext from eval-schema.ts
// instead of defining duplicate types

/** All metadata to attach to an eval record. */
export interface EvalRecordMetadata {
  /** Agent type that ran the workflow */
  agentType?: string;
  /** Shared challenge pair identifier */
  challengePairId?: string;
  /** Challenge route provenance for evals */
  challengeRouteContext?: ChallengeRouteContext | null;
  /** Difficulty analysis results */
  difficulty?: DifficultyAnalysis | null;
  /** Task context analysis results */
  taskContext?: TaskContext | null;
  /** Repo context analysis results */
  repoContext?: RepoContext | null;
  /** Workflow cost computation results */
  workflowCost?: WorkflowCostOutcome | null;
  /** Task descriptor for router training */
  taskDescriptor?: TaskDescriptor | null;
  /** Cross-model fallback telemetry */
  fallbackEvent?: FallbackEventMetadata | null;
  /** Routing and execution constraints */
  constraints?: EvalConstraints | null;
  /** Structured rubric criteria evaluation (HOK-1406) */
  rubricEval?: RubricEval | null;
}

// ────────────────────────────────────────────────────────────────
// Metadata Attachment Functions
// ────────────────────────────────────────────────────────────────

/**
 * Attach agent type to eval record.
 * Sets agentType field unconditionally (even if undefined, it becomes 'claude').
 */
export function attachAgentType(record: EvalRecord, agentType?: string): void {
  record.agentType = agentType || 'claude';
}

export function attachChallengePairId(record: EvalRecord, challengePairId?: string): void {
  if (challengePairId) {
    record.challengePairId = challengePairId;
  }
}

function toEvalChallengeRouteContext(
  challengeRouteContext: ChallengeRouteContext,
): EvalChallengeRouteContext {
  const bootstrapRoute = challengeRouteContext.bootstrapRoute
    ? {
        coder: challengeRouteContext.bootstrapRoute.coder,
        codeDepth: challengeRouteContext.bootstrapRoute.codeDepth,
        reviewer: challengeRouteContext.bootstrapRoute.reviewer,
        reviewMode: challengeRouteContext.bootstrapRoute.reviewMode,
      }
    : undefined;
  const expandedRoute = challengeRouteContext.expandedRoute
    ? {
        coder: challengeRouteContext.expandedRoute.coder,
        codeDepth: challengeRouteContext.expandedRoute.codeDepth,
        reviewer: challengeRouteContext.expandedRoute.reviewer,
        reviewMode: challengeRouteContext.expandedRoute.reviewMode,
      }
    : undefined;

  return {
    decisionSource: challengeRouteContext.decisionSource,
    ...(bootstrapRoute ? { bootstrapRoute } : {}),
    ...(expandedRoute ? { expandedRoute } : {}),
    ...(challengeRouteContext.refreshRationale
      ? { refreshRationale: challengeRouteContext.refreshRationale }
      : {}),
  };
}

export function attachChallengeRouteContext(
  record: EvalRecord,
  challengeRouteContext?: ChallengeRouteContext | null,
): void {
  if (!challengeRouteContext) {
    return;
  }
  record.challengeRouteContext = toEvalChallengeRouteContext(challengeRouteContext);
}

/**
 * Attach difficulty analysis metadata to eval record.
 * Only mutates record if difficultyData is non-null.
 */
export function attachDifficultyMetadata(
  record: EvalRecord,
  difficultyData: DifficultyAnalysis | null
): void {
  if (difficultyData) {
    record.difficultyBand = difficultyData.difficultyBand;
    record.difficultySignals = difficultyData.difficultySignals;
    record.stratum = difficultyData.stratum;
  }
}

/**
 * Attach task context analysis metadata to eval record.
 * Only mutates record if taskContextData is non-null.
 */
export function attachTaskContextMetadata(
  record: EvalRecord,
  taskContextData: TaskContext | null
): void {
  if (taskContextData) {
    record.taskContext = taskContextData;
  }
}

/**
 * Attach repo context analysis metadata to eval record.
 * Only mutates record if repoContextData is non-null.
 */
export function attachRepoContextMetadata(
  record: EvalRecord,
  repoContextData: RepoContext | null
): void {
  if (repoContextData) {
    record.repoContext = repoContextData;
  }
}

/**
 * Attach workflow cost computation metadata to eval record.
 *
 * Handles both success and failure cases:
 * - Success: sets workflowCost, workflowTokenUsage, workflowCostStatus, pricingSnapshot
 * - Failure: sets workflowCostStatus, workflowCostDiagnostics
 */
export function attachWorkflowCostMetadata(
  record: EvalRecord,
  costOutcome: WorkflowCostOutcome | null
): void {
  if (!costOutcome) {
    return;
  }

  if (costOutcome.status === 'success') {
    const success = costOutcome as WorkflowCostResult;
    record.workflowCost = success.totalCostUsd;
    record.workflowTokenUsage = success.models;
    record.workflowCostStatus = 'success';
    record.pricingSnapshot = success.pricingUsed;
  } else {
    const failure = costOutcome as WorkflowCostFailure;
    record.workflowCostStatus = failure.status;
    record.workflowCostDiagnostics = {
      reason: failure.reason,
      ...failure.diagnostics,
    };
  }
}

const TRAINING_ELIGIBILITY_CODES: readonly EligibilityErrorCode[] = [
  'missing_model_identity',
  'missing_outcome',
  'missing_routing',
  'missing_task_descriptor',
];

const BUDGET_EVAL_ELIGIBILITY_CODES: readonly EligibilityErrorCode[] = [
  'missing_budget_snapshot',
  'missing_cost',
  'missing_routing',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasBudgetSnapshot(record: EvalRecord): boolean {
  return record.constraints !== undefined || typeof record.budgetViolated === 'boolean';
}

/**
 * Compute deterministic eligibility diagnostics for downstream exports.
 */
export function computeEligibility(record: EvalRecord): {
  trainingEligible: boolean;
  budgetEvalEligible: boolean;
  eligibilityErrors: EligibilityErrorCode[];
} {
  const errors = new Set<EligibilityErrorCode>();

  if (!record.routingDecision) {
    errors.add('missing_routing');
  }

  if (!record.taskDescriptor) {
    errors.add('missing_task_descriptor');
  }

  if (!isNonEmptyString(record.modelId)) {
    errors.add('missing_model_identity');
  }

  if (!record.outcomes) {
    errors.add('missing_outcome');
  }

  if (typeof record.workflowCost !== 'number' || !Number.isFinite(record.workflowCost)) {
    errors.add('missing_cost');
  }

  if (!hasBudgetSnapshot(record)) {
    errors.add('missing_budget_snapshot');
  }

  const eligibilityErrors = [...errors].sort();
  const trainingEligible = !TRAINING_ELIGIBILITY_CODES.some((code) => errors.has(code));
  const budgetEvalEligible = !BUDGET_EVAL_ELIGIBILITY_CODES.some((code) => errors.has(code));

  return {
    trainingEligible,
    budgetEvalEligible,
    eligibilityErrors,
  };
}

/**
 * Attach deterministic export eligibility diagnostics to an eval record.
 *
 * Overwrites any existing eligibility fields so repeated calls are idempotent.
 */
export function attachEligibility(record: EvalRecord | null | undefined): void {
  if (!record) {
    return;
  }

  const eligibility = computeEligibility(record);
  record.trainingEligible = eligibility.trainingEligible;
  record.budgetEvalEligible = eligibility.budgetEvalEligible;
  record.eligibilityErrors = eligibility.eligibilityErrors;
}

/**
 * Attach stage outcomes to eval record (HOK-1004).
 *
 * Converts judge's stageScores (from metadata) into StageOutcomes format
 * and builds the RoutingOutcome from routing decision + workflow results.
 *
 * @param record - Eval record to mutate
 * @param stageScores - Judge's per-stage scores from metadata (optional)
 */
export function attachStageOutcomes(
  record: EvalRecord,
  stageScores?: Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] | null }>,
  planCritique?: PlanCritique,
): void {
  if (!stageScores || Object.keys(stageScores).length === 0) {
    return;
  }

  const stageOutcomes: StageOutcomes = {};

  // Convert judge stageScores to StageScore format
  if (stageScores.expansion) {
    stageOutcomes.expansion = {
      score: stageScores.expansion.score,
      rationale: stageScores.expansion.rationale,
      ...(stageScores.expansion.rubricCriteria?.length && {
        rubricCriteria: stageScores.expansion.rubricCriteria,
      }),
    };
  }

  if (stageScores.plan) {
    stageOutcomes.plan = {
      score: stageScores.plan.score,
      rationale: stageScores.plan.rationale,
      ...(stageScores.plan.rubricCriteria?.length && {
        rubricCriteria: stageScores.plan.rubricCriteria,
      }),
      ...(planCritique && { planCritique }),
    };
  }

  if (stageScores.implementation) {
    stageOutcomes.implementation = {
      score: stageScores.implementation.score,
      rationale: stageScores.implementation.rationale,
      ...(stageScores.implementation.rubricCriteria?.length && {
        rubricCriteria: stageScores.implementation.rubricCriteria,
      }),
    };
  }

  if (stageScores.review) {
    stageOutcomes.review = {
      score: stageScores.review.score,
      rationale: stageScores.review.rationale,
      ...(stageScores.review.rubricCriteria?.length && {
        rubricCriteria: stageScores.review.rubricCriteria,
      }),
    };
  }

  // Build RoutingOutcome from routing decision + workflow results
  if (record.routingDecision) {
    const rd = record.routingDecision;
    stageOutcomes.routing = {
      routingUsed: rd.candidates.length >= 2,
      candidateCount: rd.candidates.length,
      chosenModel: typeof rd.chosen === 'number'
        ? rd.candidates[rd.chosen]?.modelId
        : rd.chosen?.modelId,
      scoreAchieved: record.score,
      costUsd: record.workflowCost,
      policyVersion: rd.decisionPolicyVersion,
    };
  }

  // Only attach if we have at least one stage outcome
  if (Object.keys(stageOutcomes).length > 0) {
    record.stageOutcomes = stageOutcomes;
  }
}

/**
 * Attach task descriptor to eval record (HOK-1120).
 *
 * Adds the taskDescriptor field if a valid descriptor is provided.
 * The descriptor consolidates generalizable task features for router training.
 *
 * @param record - Eval record to mutate
 * @param descriptor - Task descriptor from buildTaskDescriptor (optional)
 */
export function attachTaskDescriptor(
  record: EvalRecord,
  descriptor: TaskDescriptor | null,
): void {
  if (descriptor) {
    record.taskDescriptor = descriptor;
  }
}

/**
 * Attach fallback event telemetry to the eval record.
 */
export function attachFallbackEvent(
  record: EvalRecord,
  fallbackEvent: FallbackEventMetadata | null,
): void {
  if (fallbackEvent) {
    record.fallbackEvent = fallbackEvent;
  }
}

/**
 * Attach routing constraints to the eval record.
 */
export function attachConstraints(
  record: EvalRecord,
  constraints: EvalConstraints | null,
): void {
  if (!constraints) {
    return;
  }

  const normalized: EvalConstraints = {};
  if (typeof constraints.maxCostUsd === 'number') {
    normalized.maxCostUsd = constraints.maxCostUsd;
  }

  if (Object.keys(normalized).length > 0) {
    record.constraints = normalized;
  }
}

/**
 * Extract and attach budget violation metadata from routing decision (HOK-1350).
 *
 * Populates budgetViolated and budgetViolationDetails fields when the routing
 * decision contains a budget violation, enabling analysis of cost constraint
 * effectiveness and budget tuning.
 *
 * @param record - Eval record to mutate
 */
export function attachBudgetViolation(record: EvalRecord): void {
  const routingDecision = record.routingDecision as any;
  if (!routingDecision?.budgetViolation) {
    return;
  }

  const v = routingDecision.budgetViolation;
  record.budgetViolated = true;
  record.budgetViolationDetails = {
    requestedCost: v.requestedCost,
    maxCostUsd: v.maxCostUsd,
    operatingMode: v.operatingMode,
    attemptedDowngrade: v.attemptedDowngrade,
    cheapestOption: v.cheapestViableOption ? {
      totalCost: v.cheapestViableOption.totalCost,
      wouldStillExceed: v.cheapestViableOption.totalCost > v.maxCostUsd,
    } : undefined,
  };
}

export function attachManifestRef(
  record: EvalRecord,
  sessionId?: string | null,
  repoDir?: string,
): void {
  if (!sessionId) {
    return;
  }
  const manifestRef = getManifestRef(sessionId, repoDir);
  if (manifestRef) {
    record.manifestRef = manifestRef as ManifestRef;
  }
}

export function attachResourceSelections(record: EvalRecord): void {
  const routingDecision = record.routingDecision as (RoutingDecision & { resourceSelections?: RuntimeResourceSelection[] }) | undefined;
  // Routing decision may carry router-surface entries; manifest carries planner/reviewer prompt entries.
  // Both sources are merged so no surface is silently omitted when both are present.
  const routingSelections: RuntimeResourceSelection[] = routingDecision?.resourceSelections ?? [];

  const sessionId = process.env.WAVEMILL_SESSION;
  const manifestSelections: RuntimeResourceSelection[] = [];

  if (sessionId) {
    const manifest = getManifest(sessionId);
    if (manifest) {
      for (const ref of manifest.resources) {
        const resource = getResource(ref.id, ref.version);
        if (!resource) {
          continue;
        }

        if (resource.type === 'prompt' && resource.uri === 'tools/prompts/planning-phase.md') {
          manifestSelections.push({
            surface: 'planner',
            variant: 'baseline',
            requestedVariant: 'baseline',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'prompt' && resource.uri === 'tools/prompts/review-phase.md') {
          manifestSelections.push({
            surface: 'reviewer',
            variant: 'baseline',
            requestedVariant: 'baseline',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'prompt' && resource.name === 'planner-optimized') {
          manifestSelections.push({
            surface: 'planner',
            variant: 'optimized',
            requestedVariant: 'optimized',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'prompt' && resource.name === 'reviewer-optimized') {
          manifestSelections.push({
            surface: 'reviewer',
            variant: 'optimized',
            requestedVariant: 'optimized',
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        } else if (resource.type === 'optimizer-artifact') {
          // Router artifacts are registered as optimizer-artifact type, not prompt.
          const routerVariant = resource.name.includes('optimized') ? 'optimized' : 'baseline';
          manifestSelections.push({
            surface: 'router',
            variant: routerVariant as 'baseline' | 'optimized' | 'canary',
            requestedVariant: 'baseline' as const,
            resourceRef: ref,
            uri: resource.uri,
            fallbackApplied: false,
          });
        }
      }
    }
  }

  // Routing selections take priority; manifest fills surfaces not already covered.
  const coveredSurfaces = new Set(routingSelections.map((s) => s.surface));
  const merged = [
    ...routingSelections,
    ...manifestSelections.filter((s) => !coveredSurfaces.has(s.surface)),
  ];

  if (merged.length > 0) {
    record.resourceSelections = merged;
  }
}

/**
 * Attach structured rubric criteria evaluation to the eval record (HOK-1406).
 *
 * No-op when rubricEval is undefined, so old records and LLM non-compliance
 * both leave record.rubricEval unset without errors.
 */
export function attachRubricEval(record: EvalRecord, rubricEval?: RubricEval): void {
  if (!rubricEval) return;
  record.rubricEval = rubricEval;
  record.rubric_provenance = 'judge';
}

// ────────────────────────────────────────────────────────────────
// Main Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Enrich an eval record with all available metadata.
 *
 * Mutates the record in place by attaching:
 * - Agent type
 * - Difficulty analysis
 * - Task context analysis
 * - Repo context analysis
 * - Workflow cost computation
 * - Stage outcomes (from judge's stageScores)
 * - Task descriptor (from buildTaskDescriptor)
 *
 * @param record - Base eval record from evaluateTask()
 * @param metadata - All metadata to attach
 */
export function enrichEvalRecord(record: EvalRecord, metadata: EvalRecordMetadata): void {
  attachAgentType(record, metadata.agentType);
  attachChallengePairId(record, metadata.challengePairId);
  attachChallengeRouteContext(record, metadata.challengeRouteContext);
  attachDifficultyMetadata(record, metadata.difficulty || null);
  attachTaskContextMetadata(record, metadata.taskContext || null);
  attachRepoContextMetadata(record, metadata.repoContext || null);
  attachWorkflowCostMetadata(record, metadata.workflowCost || null);
  attachTaskDescriptor(record, metadata.taskDescriptor || null);
  attachFallbackEvent(record, metadata.fallbackEvent || null);
  attachConstraints(record, metadata.constraints || null);
  attachBudgetViolation(record);
  if (metadata.rubricEval) {
    attachRubricEval(record, metadata.rubricEval);
  }
  attachManifestRef(record, process.env.WAVEMILL_SESSION, undefined);
  attachResourceSelections(record);
  attachEligibility(record);

  // Extract stageScores from record metadata (set by evaluateTask)
  const stageScores = record.metadata?.stageScores as
    | Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] }>
    | undefined;
  const planCritique = record.metadata?.planCritique as PlanCritique | undefined;
  attachStageOutcomes(record, stageScores, planCritique);
}
