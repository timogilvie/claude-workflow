import type { EvalRecord, StageOutcomes } from './eval-schema.ts';
import type { ChallengeType } from './challenge-comparison.ts';

export interface SelectedEvalScore {
  score: number;
  source: string;
  warning?: string;
}

type StageKey = keyof StageOutcomes;

const CHALLENGE_TYPE_TO_STAGE: Partial<Record<ChallengeType, StageKey>> = {
  'reviewer-only': 'review',
  'planner-only': 'plan',
  'coder-only': 'implementation',
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function metadataStageScore(record: EvalRecord, stage: string): number | undefined {
  const stageScores = (record.metadata?.stageScores as Record<string, { score?: unknown } | undefined> | undefined);
  const entry = stageScores?.[stage];
  const v = entry?.score;
  return isFiniteNumber(v) ? v : undefined;
}

function stageOutcomesScore(record: EvalRecord, stage: StageKey): number | undefined {
  const v = record.stageOutcomes?.[stage]?.score;
  return isFiniteNumber(v) ? v : undefined;
}

/**
 * Select the comparison score for a challenge eval record.
 *
 * For single-stage challenges, picks the stage-specific score when available,
 * falling back to the overall score with a data-quality warning.
 * For multi-variable/full-stack/unknown challenge types, returns overall score.
 */
export function selectChallengeEvalScore(
  record: EvalRecord,
  challengeType: ChallengeType | undefined,
): SelectedEvalScore {
  const overallScore = record.score;
  const stageKey = challengeType ? CHALLENGE_TYPE_TO_STAGE[challengeType] : undefined;

  if (!stageKey) {
    return { score: overallScore, source: 'overall' };
  }

  // metadata.stageScores takes precedence over stageOutcomes (legacy data comes first)
  const fromMetadata = metadataStageScore(record, stageKey);
  if (fromMetadata !== undefined) {
    return { score: fromMetadata, source: `stage.${stageKey}` };
  }

  const fromOutcomes = stageOutcomesScore(record, stageKey);
  if (fromOutcomes !== undefined) {
    return { score: fromOutcomes, source: `stage.${stageKey}` };
  }

  return {
    score: overallScore,
    source: 'overall',
    warning: `stage.${stageKey} score unavailable; fell back to overall score`,
  };
}

/**
 * Build a human-readable label for a score source in a prompt.
 *
 * Examples:
 *   "stage.review" + "Primary" → "Primary review-stage eval score"
 *   "stage.plan" + "Challenger" → "Challenger plan-stage eval score"
 *   "stage.implementation" + "Primary" → "Primary implementation-stage eval score"
 *   "overall" + "Primary" → "Primary eval score (overall)"
 */
export function scoreSourceLabel(source: string, side: 'Primary' | 'Challenger'): string {
  if (source.startsWith('stage.')) {
    const stage = source.slice('stage.'.length);
    return `${side} ${stage}-stage eval score`;
  }
  return `${side} eval score (overall)`;
}

/**
 * Collect all available per-stage scores from an eval record for supplemental
 * context in multi-variable challenge prompts.
 */
export function collectPerStageScores(record: EvalRecord): Record<string, number> {
  const result: Record<string, number> = {};
  const stages: StageKey[] = ['plan', 'implementation', 'review', 'expansion'];
  for (const stage of stages) {
    const fromMetadata = metadataStageScore(record, stage);
    if (fromMetadata !== undefined) {
      result[stage] = fromMetadata;
      continue;
    }
    const fromOutcomes = stageOutcomesScore(record, stage);
    if (fromOutcomes !== undefined) {
      result[stage] = fromOutcomes;
    }
  }
  return result;
}
