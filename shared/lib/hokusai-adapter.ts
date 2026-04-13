import type { HokusaiOutput, HokusaiPlanDepth, HokusaiCodeDepth, HokusaiReviewMode } from './hokusai-schema.ts';
import {
  CODE_TOKENS,
  PLAN_TOKENS,
  REVIEW_TOKENS,
  estimateStageCost,
  type CodeDepth,
  type PlanDepth,
  type ReviewMode,
  type WorkflowRouteDecision,
} from './workflow-router.ts';

const PLAN_DEPTH_MAP: Record<HokusaiPlanDepth, PlanDepth> = {
  low: 'light',
  medium: 'medium',
  high: 'deep',
};

const CODE_DEPTH_MAP: Record<HokusaiCodeDepth, CodeDepth> = {
  low: 'light',
  medium: 'medium',
  high: 'deep',
};

const REVIEW_MODE_MAP: Record<HokusaiReviewMode, Exclude<ReviewMode, 'none'>> = {
  light: 'static',
  standard: 'llm',
  deep: 'static+llm',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function allocateStageCosts(
  expectedTotalCost: number,
  fallbackCosts: [number, number, number],
): [number, number, number] {
  const fallbackTotal = fallbackCosts.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(expectedTotalCost) || expectedTotalCost < 0) {
    return fallbackCosts;
  }

  if (expectedTotalCost === 0) {
    return [0, 0, 0];
  }

  if (fallbackTotal <= 0) {
    const equalShare = roundMoney(expectedTotalCost / 3);
    return [equalShare, equalShare, roundMoney(expectedTotalCost - equalShare * 2)];
  }

  const allocated = fallbackCosts.map((value) => roundMoney((value / fallbackTotal) * expectedTotalCost)) as [number, number, number];
  return [
    allocated[0],
    allocated[1],
    roundMoney(expectedTotalCost - allocated[0] - allocated[1]),
  ];
}

export function fromHokusaiOutput(
  output: HokusaiOutput,
  options?: { repoDir?: string },
): WorkflowRouteDecision {
  const planDepth = PLAN_DEPTH_MAP[output.route.plan_depth];
  const codeDepth = CODE_DEPTH_MAP[output.route.code_depth];
  const reviewRecommended = REVIEW_MODE_MAP[output.route.review_mode];
  const fallbackCosts: [number, number, number] = [
    estimateStageCost(output.route.planner_model, PLAN_TOKENS[planDepth], options?.repoDir),
    estimateStageCost(output.route.coder_model, CODE_TOKENS[codeDepth], options?.repoDir),
    estimateStageCost(output.route.reviewer_model, REVIEW_TOKENS[reviewRecommended], options?.repoDir),
  ];
  const [expectedCostPlan, expectedCostCode, expectedCostReview] = allocateStageCosts(
    output.predictions.expected_cost_usd,
    fallbackCosts,
  );

  return {
    planner: output.route.planner_model,
    coder: output.route.coder_model,
    reviewer: output.route.reviewer_model,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess: clamp(output.predictions.expected_success_probability, 0, 1),
    expectedCostPlan,
    expectedCostCode,
    expectedCostReview,
    confidence: clamp(output.predictions.confidence, 0, 1),
    reasoning: [
      `Adapted from Hokusai output schema v${output.schema_version}.`,
      `Review mapping: ${output.route.review_mode} -> ${reviewRecommended}.`,
      'Stage costs are apportioned from Hokusai expected_cost_usd using router token heuristics.',
    ],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 0,
      fileTypes: [],
      riskScore: 0,
    },
  };
}
