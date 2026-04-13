/**
 * Hokusai model output schema (section 5) used for workflow routing.
 */

export type HokusaiPlanDepth = 'low' | 'medium' | 'high';
export type HokusaiCodeDepth = 'low' | 'medium' | 'high';
export type HokusaiReviewMode = 'light' | 'standard' | 'deep';

export interface HokusaiRoute {
  plan_depth: HokusaiPlanDepth;
  code_depth: HokusaiCodeDepth;
  review_mode: HokusaiReviewMode;
}

export interface HokusaiPredictions {
  success_probability: number;
  confidence: number;
  estimated_tokens: number;
}

export interface HokusaiOutput {
  route: HokusaiRoute;
  predictions: HokusaiPredictions;
}
