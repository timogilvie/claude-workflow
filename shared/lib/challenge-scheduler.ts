/**
 * Challenge scheduling policy for systematic model exploration.
 *
 * Evaluates three triggers for recommending challenges:
 * 1. Low confidence: When routing confidence below threshold
 * 2. New model: When a model has insufficient eval data
 * 3. Low data stage: When a workflow stage has insufficient evals
 *
 * Returns a prioritized recommendation that the orchestrator can act on.
 *
 * @module challenge-scheduler
 */

import type { StageAwareDecision } from './stage-aware-router.ts';

/**
 * Challenge recommendation returned by the scheduler.
 * Used by the orchestrator to decide whether to run as challenge mode.
 */
export interface ChallengeRecommendation {
  /** Whether a challenge should be triggered */
  shouldChallenge: boolean;

  /** Reason for the recommendation (or 'disabled' if scheduler is off) */
  reason?: 'low-confidence' | 'new-model' | 'low-data-stage' | 'disabled';

  /** Default model (from the routing decision) */
  defaultModel?: string;

  /** Challenger model to test against default */
  challengerModel?: string;

  /** Which stage the challenge is for (if stage-specific) */
  stage?: 'planning' | 'coding' | 'review';

  /** Priority score (1-5, higher = more urgent) */
  priority: number;

  /** Additional context for debugging and logging */
  metadata?: {
    confidence?: number;
    evalCount?: number;
    threshold?: number;
  };
}

/**
 * Configuration for challenge scheduling policy.
 * All fields optional with sensible defaults.
 */
export interface ChallengeSchedulerConfig {
  /** Enable challenge scheduling. Default: false (opt-in feature) */
  enabled: boolean;

  /** Minimum confidence to avoid triggering a challenge. Default: 0.7 */
  confidenceThreshold: number;

  /** New models with fewer than this many evals trigger challenges. Default: 5 */
  newModelChallengeCount: number;

  /** Stages with fewer than this many evals trigger challenges. Default: 10 */
  minEvalRecordsPerStage: number;

  /** Maximum concurrent challenge tasks (future use). Default: 2 */
  maxConcurrentChallenges?: number;
}

/**
 * Input to the challenge scheduler evaluation.
 * Contains all data needed to make scheduling decisions.
 */
export interface ChallengeSchedulerInput {
  /** The routing decision from the stage-aware router */
  routingDecision: StageAwareDecision;

  /** Model eval counts (model ID -> number of evals) */
  evalSummary: Record<string, number>;

  /** Stage eval counts (stage -> number of evals) */
  stageEvalCounts: Record<string, number>;

  /** Configuration for the scheduler */
  config: ChallengeSchedulerConfig;
}

/**
 * Main entry point for challenge scheduling.
 *
 * Evaluates all three triggers in priority order and returns the
 * highest-priority recommendation.
 *
 * @param input - Scheduler input with routing decision, eval data, and config
 * @returns Challenge recommendation (always has shouldChallenge and priority)
 */
export function evaluateChallenge(input: ChallengeSchedulerInput): ChallengeRecommendation {
  const { config } = input;

  // If disabled, return early
  if (!config.enabled) {
    return {
      shouldChallenge: false,
      reason: 'disabled',
      priority: 0,
    };
  }

  // Check all three triggers and collect recommendations
  const recommendations: ChallengeRecommendation[] = [];

  // Trigger 1: Low confidence (highest priority potential)
  const lowConfRec = checkLowConfidence(
    input.routingDecision,
    config.confidenceThreshold,
    input.evalSummary,
  );
  if (lowConfRec) recommendations.push(lowConfRec);

  // Trigger 2: New model (medium priority)
  const newModelRec = checkNewModel(config, input.evalSummary, input.routingDecision);
  if (newModelRec) recommendations.push(newModelRec);

  // Trigger 3: Low data stage (lower priority)
  const lowDataRec = checkLowDataStage(
    config,
    input.stageEvalCounts,
    input.routingDecision,
  );
  if (lowDataRec) recommendations.push(lowDataRec);

  // Return highest-priority recommendation, or no-challenge default
  if (recommendations.length === 0) {
    return {
      shouldChallenge: false,
      priority: 0,
    };
  }

  const highest = recommendations.reduce((prev, curr) =>
    curr.priority > prev.priority ? curr : prev
  );
  highest.shouldChallenge = true;
  return highest;
}

/**
 * Check if confidence is below threshold and we have alternatives.
 *
 * @param decision - Routing decision with expectedSuccess confidence
 * @param threshold - Minimum acceptable confidence (e.g., 0.7)
 * @param evalSummary - Model eval counts
 * @returns Recommendation or null if no challenge needed
 */
export function checkLowConfidence(
  decision: StageAwareDecision,
  threshold: number,
  evalSummary: Record<string, number>,
): ChallengeRecommendation | null {
  const confidence = decision.expectedSuccess ?? 0;

  // Only trigger if below threshold
  if (confidence >= threshold) {
    return null;
  }

  // Need at least 2 candidate models for a challenge
  const candidateModels = Object.keys(evalSummary);
  if (candidateModels.length < 2) {
    return null;
  }

  // Select top 2 models (by eval count)
  const sorted = candidateModels.sort((a, b) => (evalSummary[b] ?? 0) - (evalSummary[a] ?? 0));
  const defaultModel = sorted[0];
  const challengerModel = sorted[1];

  // Priority: lower confidence = higher priority (1-5 scale)
  const priority = Math.floor((1 - confidence) * 5);

  return {
    shouldChallenge: false, // Will be set to true by evaluateChallenge
    reason: 'low-confidence',
    defaultModel,
    challengerModel,
    priority: Math.max(1, Math.min(5, priority)), // Clamp to 1-5
    metadata: {
      confidence,
      threshold,
    },
  };
}

/**
 * Check if any model needs more eval data.
 *
 * Finds the first model with fewer than newModelChallengeCount evals
 * and recommends a challenge against the current default.
 *
 * @param config - Challenge scheduler config
 * @param evalSummary - Model eval counts
 * @param decision - Routing decision to get current default model
 * @returns Recommendation or null if all models have sufficient data
 */
export function checkNewModel(
  config: ChallengeSchedulerConfig,
  evalSummary: Record<string, number>,
  decision: StageAwareDecision,
): ChallengeRecommendation | null {
  // Find first model below eval threshold
  const newModel = Object.entries(evalSummary).find(
    ([, count]) => count < config.newModelChallengeCount
  )?.[0];

  if (!newModel) {
    return null;
  }

  // Use coder as default (most expensive, most impactful stage)
  const defaultModel = decision.coder;

  return {
    shouldChallenge: false, // Will be set to true by evaluateChallenge
    reason: 'new-model',
    defaultModel,
    challengerModel: newModel,
    priority: 3,
    metadata: {
      evalCount: evalSummary[newModel],
      threshold: config.newModelChallengeCount,
    },
  };
}

/**
 * Check if any stage needs more eval data.
 *
 * Finds the stage with the fewest evals and recommends a challenge
 * to gather more data for that stage.
 *
 * @param config - Challenge scheduler config
 * @param stageEvalCounts - Count of evals per stage (planning, coding, review)
 * @param decision - Routing decision to select model for target stage
 * @returns Recommendation or null if all stages have sufficient data
 */
export function checkLowDataStage(
  config: ChallengeSchedulerConfig,
  stageEvalCounts: Record<string, number>,
  decision: StageAwareDecision,
): ChallengeRecommendation | null {
  // Find stage with lowest eval count
  const entries = Object.entries(stageEvalCounts);
  if (entries.length === 0) return null;

  const lowestStage = entries.reduce((prev, curr) =>
    (curr[1] ?? 0) < (prev[1] ?? 0) ? curr : prev
  );
  const [stageName, stageCount] = lowestStage;

  // Only trigger if below threshold
  if ((stageCount ?? 0) >= config.minEvalRecordsPerStage) {
    return null;
  }

  // Select model for the low-data stage
  let defaultModel = decision.coder; // default to coder
  const stageKey = stageName.toLowerCase();
  if (stageKey.includes('plan')) {
    defaultModel = decision.planner;
  } else if (stageKey.includes('review')) {
    defaultModel = decision.reviewer;
  }

  // For challenger, pick the second-most-used model for that stage
  // (for now, just use the coder as a reasonable fallback)
  const challengerModel = decision.planner !== defaultModel
    ? decision.planner
    : decision.reviewer;

  return {
    shouldChallenge: false, // Will be set to true by evaluateChallenge
    reason: 'low-data-stage',
    defaultModel,
    challengerModel,
    stage: (stageKey.includes('plan') ? 'planning' : stageKey.includes('review') ? 'review' : 'coding') as 'planning' | 'coding' | 'review',
    priority: 2,
    metadata: {
      evalCount: stageCount,
      threshold: config.minEvalRecordsPerStage,
    },
  };
}
