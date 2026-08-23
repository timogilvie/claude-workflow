import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalRecord } from '../eval-schema.ts';
import type { StoredChallengeComparison, VariedDimensions } from '../challenge-comparison.ts';
import { classifyChallengeType, hasAnyVariedDimension } from '../challenge-comparison.ts';
import { readEvalRecordsFromFile } from '../eval-persistence.ts';
import { recoverStageFromIntent, stageFromChallengeType } from '../challenge-stage-recovery.ts';

export type SwapTestChallengeType =
  | 'planner-only'
  | 'coder-only'
  | 'reviewer-only'
  | 'depth-varied'
  | 'multi-variable'
  | 'full-stack'
  | 'unrecoverable';

export type ChallengeTypeSource =
  | 'variedDimensions'
  | 'challengeType'
  | 'evalChallengeStage'
  | 'challengeIntent'
  | 'none';

export interface ChallengeTypeDerivation {
  type: SwapTestChallengeType;
  source: ChallengeTypeSource;
}

export type ComplexityBucket = 1 | 2 | 3 | 4 | 5 | 'unknown';
export type CollapsedDifficulty = '1-2 easy' | '3 medium' | '4 hard' | '5 very_hard' | 'unknown';

export interface DifficultyDerivation {
  bucket: ComplexityBucket;
  collapsed: CollapsedDifficulty;
  source: 'primary' | 'challenger' | 'none';
  primaryDifficultyBand?: string;
  challengerDifficultyBand?: string;
}

export interface EvalLookup {
  primary?: EvalRecord;
  challenger?: EvalRecord;
  provenance: {
    primary?: string;
    challenger?: string;
  };
}

function variedHasDepthOnly(varied: VariedDimensions): boolean {
  const roleChanged = varied.planner || varied.coder || varied.reviewer;
  const depthChanged = varied.planDepth || varied.codeDepth || varied.reviewMode;
  const variantChanged = varied.routerVariant || varied.plannerPromptVariant || varied.reviewerPromptVariant;
  return !roleChanged && depthChanged && !variantChanged;
}

function isStoredChallengeType(value: unknown): value is Exclude<SwapTestChallengeType, 'depth-varied' | 'unrecoverable'> {
  return (
    value === 'planner-only'
    || value === 'coder-only'
    || value === 'reviewer-only'
    || value === 'multi-variable'
    || value === 'full-stack'
  );
}

function typeFromStage(stage: unknown): SwapTestChallengeType | undefined {
  if (stage === 'plan') return 'planner-only';
  if (stage === 'implementation') return 'coder-only';
  if (stage === 'review') return 'reviewer-only';
  return undefined;
}

export function deriveChallengeType(
  record: Pick<StoredChallengeComparison, 'variedDimensions' | 'challengeType'>,
  evals: EvalLookup = { provenance: {} },
): ChallengeTypeDerivation {
  const varied = record.variedDimensions;
  if (varied && hasAnyVariedDimension(varied)) {
    if (variedHasDepthOnly(varied)) {
      return { type: 'depth-varied', source: 'variedDimensions' };
    }
    return { type: classifyChallengeType(varied), source: 'variedDimensions' };
  }

  if (isStoredChallengeType(record.challengeType)) {
    return { type: record.challengeType, source: 'challengeType' };
  }

  const stageFromEvalField = typeFromStage(evals.primary?.challengeStage) ?? typeFromStage(evals.challenger?.challengeStage);
  if (stageFromEvalField) {
    return { type: stageFromEvalField, source: 'evalChallengeStage' };
  }

  const stageFromIntent =
    recoverStageFromIntent(evals.primary ?? {})
    ?? recoverStageFromIntent(evals.challenger ?? {})
    ?? stageFromChallengeType(record.challengeType);
  const type = typeFromStage(stageFromIntent);
  if (type) {
    return { type, source: 'challengeIntent' };
  }

  return { type: 'unrecoverable', source: 'none' };
}

function complexityFromEval(record?: EvalRecord): 1 | 2 | 3 | 4 | 5 | undefined {
  const value = record?.taskDescriptor?.signals?.learned?.complexity;
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : undefined;
}

function collapsedDifficulty(bucket: ComplexityBucket): CollapsedDifficulty {
  if (bucket === 1 || bucket === 2) return '1-2 easy';
  if (bucket === 3) return '3 medium';
  if (bucket === 4) return '4 hard';
  if (bucket === 5) return '5 very_hard';
  return 'unknown';
}

export function deriveDifficultyBucket(primary?: EvalRecord, challenger?: EvalRecord): DifficultyDerivation {
  const primaryComplexity = complexityFromEval(primary);
  const challengerComplexity = complexityFromEval(challenger);
  const bucket = primaryComplexity ?? challengerComplexity ?? 'unknown';
  return {
    bucket,
    collapsed: collapsedDifficulty(bucket),
    source: primaryComplexity !== undefined ? 'primary' : challengerComplexity !== undefined ? 'challenger' : 'none',
    primaryDifficultyBand: primary?.difficultyBand,
    challengerDifficultyBand: challenger?.difficultyBand,
  };
}

function evalKey(pairOrIssue: string | undefined, prUrl: string | undefined): string | undefined {
  if (!pairOrIssue || !prUrl) return undefined;
  return `${pairOrIssue}\u0000${prUrl}`;
}

export function readEvalRowsForPairs(evalsDir: string): Map<string, { record: EvalRecord; provenance: string }> {
  const index = new Map<string, { record: EvalRecord; provenance: string }>();
  for (const file of ['evals.jsonl', 'evals.jsonl.bak']) {
    const path = join(evalsDir, file);
    if (!existsSync(path)) continue;
    for (const record of readEvalRecordsFromFile(path)) {
      for (const key of [
        evalKey(record.challengePairId, record.prUrl),
        evalKey(record.issueId, record.prUrl),
      ]) {
        if (key && !index.has(key)) {
          index.set(key, { record, provenance: file });
        }
      }
    }
  }
  return index;
}

export function lookupPairEvals(
  evalIndex: Map<string, { record: EvalRecord; provenance: string }>,
  pair: Pick<StoredChallengeComparison, 'challengePairId' | 'primaryPrUrl' | 'challengerPrUrl'>,
): EvalLookup {
  const primary = evalIndex.get(`${pair.challengePairId}\u0000${pair.primaryPrUrl}`);
  const challenger = evalIndex.get(`${pair.challengePairId}\u0000${pair.challengerPrUrl}`);
  return {
    primary: primary?.record,
    challenger: challenger?.record,
    provenance: {
      primary: primary?.provenance,
      challenger: challenger?.provenance,
    },
  };
}
