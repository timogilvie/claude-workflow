export type HokusaiPlanDepth = 'low' | 'medium' | 'high';
export type HokusaiCodeDepth = 'low' | 'medium' | 'high';
export type HokusaiReviewMode = 'light' | 'standard' | 'deep';

export interface HokusaiRoute {
  planner_model: string;
  coder_model: string;
  reviewer_model: string;
  plan_depth: HokusaiPlanDepth;
  code_depth: HokusaiCodeDepth;
  review_mode: HokusaiReviewMode;
}

export interface HokusaiPredictions {
  expected_success_probability: number;
  expected_cost_usd: number;
  confidence: number;
}

export interface HokusaiOutput {
  schema_version: string;
  route: HokusaiRoute;
  predictions: HokusaiPredictions;
}
