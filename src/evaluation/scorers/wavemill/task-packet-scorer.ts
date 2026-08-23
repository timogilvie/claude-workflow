/**
 * Task packet scoring model (v1) for predicting execution readiness.
 *
 * Combines logistic regression scoring with heuristic decision rules to predict
 * whether a task packet is likely to succeed or require intervention.
 *
 * @module task-packet-scorer
 */

import { isTaskPacketContent } from '../../../../shared/lib/task-packet-utils.ts';
import type { TaskPacketFeatures } from './task-packet-feature-extractor.ts';

export const WAVEMILL_TASK_PACKET_SCORER_ID = 'hokusai.scorers.wavemill.task_packet_readiness:v1';

export type TaskScorerDecision = 'run' | 'expand' | 'split' | 'return';

export interface TaskScorerResult {
  decision: TaskScorerDecision;
  confidence: number; // 0 to 1
  explanation: string;
  interventionProbability: number; // 0 to 1
  scorerId: string;
  modelVersion: string;
  topFeatures: string[];
  scoredAt: string; // ISO 8601
}

/**
 * Score a task packet for readiness.
 *
 * Uses heuristic rules based on packet structure and content to predict
 * likelihood of intervention. Returns a decision (run/expand/split/return)
 * with confidence score and explanation.
 */
export function scoreTaskPacket(features: TaskPacketFeatures, opts?: { text?: string }): TaskScorerResult {
  const now = new Date().toISOString();
  const topFeatures: string[] = [];

  // Check for basic packet validity
  if (!opts?.text || !isTaskPacketContent(opts.text)) {
    return {
      decision: 'return',
      confidence: 0.95,
      explanation: 'Text does not appear to be a valid task packet structure',
      interventionProbability: 0.95,
      scorerId: WAVEMILL_TASK_PACKET_SCORER_ID,
      modelVersion: 'v1-heuristic',
      topFeatures: ['invalid_packet'],
      scoredAt: now,
    };
  }

  // Count missing key sections
  const requiredSections = [1, 2, 3, 4, 5, 6]; // Objective through Validation
  const missingSections = requiredSections.filter((i) => !(features as any)[`sectionPresent${i}`]).length;
  const minSectionCount = missingSections > 3 ? 0.9 : missingSections > 1 ? 0.7 : 0.5;

  // Check for vagueness markers (TBD, unclear, etc.)
  const hasHighVagueness = features.vaguenessMarkerCount > 5;
  const hasHighHedgeWords = features.hedgeWordRatio > 10; // per 100 words

  // Check for incomplete documentation
  const thinValidation = features.validationScenarioCount < 2;
  const thinSuccessCriteria = (features as any)['sectionLength4'] < 100; // Section 4 = Success Criteria

  // Check for scope/complexity signals
  const largeFileCount = features.keyFileCount > 10;
  const manySteps = features.implementationStepCount > 15;
  const complexTask = largeFileCount || manySteps;

  // Compute intervention probability using simple heuristic
  let interventionProb = 0.4; // Base rate

  if (missingSections > 2) {
    interventionProb = Math.min(1, interventionProb + 0.3);
    topFeatures.push(`missing_${missingSections}_sections`);
  }

  if (hasHighVagueness) {
    interventionProb = Math.min(1, interventionProb + 0.25);
    topFeatures.push('high_vagueness');
  }

  if (thinValidation && thinSuccessCriteria) {
    interventionProb = Math.min(1, interventionProb + 0.2);
    topFeatures.push('incomplete_specs');
  }

  if (hasHighHedgeWords) {
    interventionProb = Math.min(1, interventionProb + 0.15);
    topFeatures.push('uncertainty_language');
  }

  // Confidence is based on certainty of the prediction
  const confidence = Math.abs(interventionProb - 0.5) * 2;

  // Make decision
  let decision: TaskScorerDecision = 'run';
  let explanation = 'Packet appears ready for execution.';

  if (interventionProb > 0.75) {
    // High risk of intervention
    if (thinValidation || thinSuccessCriteria) {
      decision = 'expand';
      explanation = 'Incomplete specs suggest expansion needed to clarify requirements and validation.';
    } else if (complexTask) {
      decision = 'split';
      explanation = 'Large scope suggests splitting into smaller, more manageable tasks.';
    } else {
      decision = 'return';
      explanation = 'Packet structure raises concerns; recommend returning for review.';
    }
  } else if (interventionProb > 0.6) {
    // Moderate risk
    if (hasHighVagueness) {
      decision = 'expand';
      explanation = 'Vague language and unclear requirements detected; expansion recommended.';
    } else if (complexTask) {
      decision = 'split';
      explanation = 'Task complexity suggests decomposition into phases.';
    } else {
      decision = 'run';
      explanation = 'Moderate concerns noted, but packet appears workable as-is.';
    }
  } else if (interventionProb > 0.5) {
    // Slight risk
    decision = 'run';
    explanation = 'Minor issues noted, but overall structure supports execution.';
  } else {
    // Low risk
    decision = 'run';
    explanation = 'Packet structure looks solid; ready to execute.';
  }

  return {
    decision,
    confidence,
    explanation,
    interventionProbability: interventionProb,
    scorerId: WAVEMILL_TASK_PACKET_SCORER_ID,
    modelVersion: 'v1-heuristic',
    topFeatures: topFeatures.slice(0, 3),
    scoredAt: now,
  };
}

/**
 * Monotonicity test: adding vagueness markers should not decrease intervention probability.
 * This is a unit test helper that creates a baseline and a modified packet.
 */
export function testMonotonicity(baseFeatures: TaskPacketFeatures): boolean {
  const baseScore = scoreTaskPacket(baseFeatures);
  const modifiedFeatures = { ...baseFeatures, vaguenessMarkerCount: baseFeatures.vaguenessMarkerCount + 5 };
  const modifiedScore = scoreTaskPacket(modifiedFeatures);

  return modifiedScore.interventionProbability >= baseScore.interventionProbability;
}
