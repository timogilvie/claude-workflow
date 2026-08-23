/** Explainable v1 readiness scorer. It is intentionally advisory-only. */
import type { TaskScorerResult } from '../../../shared/lib/eval-schema.ts';
import type { TaskPacketFeatures } from './task-packet-feature-extractor.ts';

export const TASK_PACKET_SCORER_ID = 'hokusai.scorers.wavemill.task_packet_readiness:v1';

type NumericFeature = keyof Pick<TaskPacketFeatures,
  'total_chars' | 'file_count' | 'new_file_count' | 'validation_is_boilerplate'
  | 'sections_present' | 'layer1_error_count' | 'layer1_warning_count' | 'vague_word_density'
  | 'difficulty' | 'complexity' | 'validation_scenario_count' | 'edge_case_count'>;

/**
 * Conservative heuristic calibration pending the reproducible time-split fit emitted
 * by analyze-packet-signal. Difficulty and complexity are explicit controls so broad
 * tasks are not automatically treated as bad packets.
 */
export const MODEL_V1 = {
  fittedAt: '2026-08-23', trainingRows: 0, holdoutAuc: 0,
  intercept: -2.45,
  weights: {
    total_chars: 0.000025, file_count: 0.06, new_file_count: 0.08,
    validation_is_boilerplate: 1.35, sections_present: -0.27,
    layer1_error_count: 0.35, layer1_warning_count: 0.12,
    vague_word_density: 0.08, difficulty: 0.12, complexity: 0.08,
    validation_scenario_count: -0.06, edge_case_count: -0.04,
  } satisfies Record<NumericFeature, number>,
  thresholds: { run: 0.42 },
  featuresVersion: 'v1-heuristic-pre-observational-fit',
} as const;

const SCOPE_FEATURES = new Set<NumericFeature>(['total_chars', 'file_count', 'new_file_count', 'difficulty', 'complexity']);

function sigmoid(value: number): number { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value)))); }
function round(value: number): number { return Number(value.toFixed(6)); }
function readable(feature: string): string { return feature.replaceAll('_', ' '); }

/** Score a feature vector without performing I/O or affecting workflow dispatch. */
export function scoreTaskPacket(features: TaskPacketFeatures): TaskScorerResult {
  const structured = features.packet_format !== 'legacy'
    && (features.section_lengths.objective > 0 || features.section_lengths.success_criteria > 0);
  if (!structured) {
    return {
      decision: 'return', confidence: 0.2,
      explanation: 'Packet is not a structured task packet with an objective and success criteria.',
      scorer_id: TASK_PACKET_SCORER_ID, probability_intervention: 0.5,
      difficulty: features.difficulty, scored_at: new Date().toISOString(), features_version: MODEL_V1.featuresVersion,
    };
  }

  const contributions = (Object.entries(MODEL_V1.weights) as Array<[NumericFeature, number]>)
    .map(([feature, weight]) => ({ feature, contribution: round(weight * features[feature]) }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const logOdds = MODEL_V1.intercept + contributions.reduce((sum, entry) => sum + entry.contribution, 0);
  const probability = round(sigmoid(logOdds));
  const top = contributions.slice(0, 5);
  const confidence = round(Math.max(0, Math.min(1, Math.abs(probability - .5) * 2)));

  if (probability < MODEL_V1.thresholds.run) {
    return {
      decision: 'run', confidence,
      explanation: `Packet appears ready; ${readable(top[0]?.feature ?? 'packet structure')} is within the v1 readiness range.`,
      scorer_id: TASK_PACKET_SCORER_ID, probability_intervention: probability, feature_contributions: top,
      difficulty: features.difficulty, scored_at: new Date().toISOString(), features_version: MODEL_V1.featuresVersion,
    };
  }

  const scopeContribution = contributions.filter((entry) => SCOPE_FEATURES.has(entry.feature)).reduce((sum, entry) => sum + Math.max(0, entry.contribution), 0);
  const completenessContribution = contributions.filter((entry) => !SCOPE_FEATURES.has(entry.feature)).reduce((sum, entry) => sum + Math.max(0, entry.contribution), 0);
  const decision = scopeContribution > completenessContribution ? 'split' : 'expand';
  const primary = top.filter((entry) => entry.contribution > 0).slice(0, 2).map((entry) => readable(entry.feature)).join(' and ') || 'packet completeness';
  return {
    decision, confidence,
    explanation: decision === 'split'
      ? `Packet scope is likely too broad; ${primary} contributes most to intervention risk.`
      : `Packet needs expansion before dispatch; ${primary} indicates incomplete or generic guidance.`,
    scorer_id: TASK_PACKET_SCORER_ID, probability_intervention: probability, feature_contributions: top,
    difficulty: features.difficulty, scored_at: new Date().toISOString(), features_version: MODEL_V1.featuresVersion,
  };
}
