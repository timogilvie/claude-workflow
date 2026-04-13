/**
 * Adapter from Hokusai output schema to the existing WorkflowRouteDecision.
 */

import type { HokusaiCodeDepth, HokusaiOutput, HokusaiPlanDepth, HokusaiReviewMode } from './hokusai-schema.ts';
import type { CodeDepth, PlanDepth, ReviewMode, WorkflowRouteDecision } from './workflow-router.ts';

const HOKUSAI_PLACEHOLDER_MODEL = 'hokusai-routed';

// Converts token count to a rough USD estimate when model-specific pricing is unknown.
const DEFAULT_COST_PER_MTOK_USD = 2.5;

function assertNever(value: never): never {
  throw new Error(`Unhandled Hokusai value: ${String(value)}`);
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function mapPlanDepth(depth: HokusaiPlanDepth): PlanDepth {
  switch (depth) {
    case 'low':
      return 'light';
    case 'medium':
      return 'medium';
    case 'high':
      return 'deep';
    default:
      return assertNever(depth);
  }
}

function mapCodeDepth(depth: HokusaiCodeDepth): CodeDepth {
  switch (depth) {
    case 'low':
      return 'light';
    case 'medium':
      return 'medium';
    case 'high':
      return 'deep';
    default:
      return assertNever(depth);
  }
}

/**
 * Review mode taxonomy mapping:
 * light -> static, standard -> llm, deep -> static+llm
 */
function mapReviewMode(mode: HokusaiReviewMode): ReviewMode {
  switch (mode) {
    case 'light':
      return 'static';
    case 'standard':
      return 'llm';
    case 'deep':
      return 'static+llm';
    default:
      return assertNever(mode);
  }
}

function toUsdCost(estimatedTokens: number): number {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
    return 0;
  }
  return Number(((estimatedTokens / 1_000_000) * DEFAULT_COST_PER_MTOK_USD).toFixed(2));
}

function stageCostShare(reviewMode: ReviewMode): { plan: number; code: number; review: number } {
  if (reviewMode === 'static') {
    return { plan: 0.18, code: 0.77, review: 0.05 };
  }
  if (reviewMode === 'llm') {
    return { plan: 0.16, code: 0.72, review: 0.12 };
  }
  if (reviewMode === 'static+llm') {
    return { plan: 0.14, code: 0.68, review: 0.18 };
  }
  return { plan: 0.2, code: 0.8, review: 0 };
}

export function fromHokusaiOutput(output: HokusaiOutput): WorkflowRouteDecision {
  const planDepth = mapPlanDepth(output.route.plan_depth);
  const codeDepth = mapCodeDepth(output.route.code_depth);
  const reviewRecommended = mapReviewMode(output.route.review_mode);

  const expectedSuccess = clampProbability(output.predictions.success_probability);
  const confidence = clampProbability(output.predictions.confidence);
  const totalCost = toUsdCost(output.predictions.estimated_tokens);
  const weights = stageCostShare(reviewRecommended);

  return {
    planner: HOKUSAI_PLACEHOLDER_MODEL,
    coder: HOKUSAI_PLACEHOLDER_MODEL,
    reviewer: HOKUSAI_PLACEHOLDER_MODEL,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess,
    confidence,
    expectedCostPlan: Number((totalCost * weights.plan).toFixed(2)),
    expectedCostCode: Number((totalCost * weights.code).toFixed(2)),
    expectedCostReview: Number((totalCost * weights.review).toFixed(2)),
    reasoning: [
      'Routed by Hokusai model output adapter.',
      `Mapped review_mode=${output.route.review_mode} to ${reviewRecommended}.`,
      `Converted estimated_tokens=${output.predictions.estimated_tokens} to stage cost estimates.`,
    ],
    signals: {
      taskType: 'unknown',
      promptLength: 'medium',
      complexityScore: 0,
      fileTypes: [],
      riskScore: 0,
    },
  };
}
