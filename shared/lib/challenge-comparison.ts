import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';

export interface ChallengeRoutingMeta {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: string;
  codeDepth: string;
  reviewMode: string;
  routerVariant?: string;
  plannerPromptVariant?: string;
  reviewerPromptVariant?: string;
}

export interface VariedDimensions {
  planner: boolean;
  coder: boolean;
  reviewer: boolean;
  planDepth: boolean;
  codeDepth: boolean;
  reviewMode: boolean;
  routerVariant: boolean;
  plannerPromptVariant: boolean;
  reviewerPromptVariant: boolean;
}

export type ChallengeType =
  | 'coder-only'
  | 'planner-only'
  | 'reviewer-only'
  | 'multi-variable'
  | 'full-stack';

export interface ChallengeComparison {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  winner: 'primary' | 'challenger';
  winnerModel: string;
  rationale: string;
  dimensions: {
    correctness: { primary: number; challenger: number };
    codeQuality: { primary: number; challenger: number };
    completeness: { primary: number; challenger: number };
    scopeDiscipline: { primary: number; challenger: number };
  };
  timestamp: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  variedDimensions?: VariedDimensions;
  challengeType?: ChallengeType;
  workflowInsight?: string;
}

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const CHALLENGE_RECORDS_FILENAME = 'challenge-records.jsonl';

function resolveRecordsFile(dir?: string): string {
  const baseDir = resolve(dir || DEFAULT_EVALS_DIR);
  return join(baseDir, CHALLENGE_RECORDS_FILENAME);
}

/**
 * Detect which dimensions varied between primary and challenger routing.
 * Returns undefined if either routing is missing.
 */
export function detectVariedDimensions(
  primaryRouting: ChallengeRoutingMeta | undefined,
  challengerRouting: ChallengeRoutingMeta | undefined,
): VariedDimensions | undefined {
  if (!primaryRouting || !challengerRouting) {
    return undefined;
  }

  // Treat empty strings as equivalent to missing values
  const normalize = (val: string) => val.trim() || '';

  return {
    planner: normalize(primaryRouting.planner) !== normalize(challengerRouting.planner),
    coder: normalize(primaryRouting.coder) !== normalize(challengerRouting.coder),
    reviewer: normalize(primaryRouting.reviewer) !== normalize(challengerRouting.reviewer),
    planDepth: normalize(primaryRouting.planDepth) !== normalize(challengerRouting.planDepth),
    codeDepth: normalize(primaryRouting.codeDepth) !== normalize(challengerRouting.codeDepth),
    reviewMode: normalize(primaryRouting.reviewMode) !== normalize(challengerRouting.reviewMode),
    routerVariant: normalize(primaryRouting.routerVariant || '') !== normalize(challengerRouting.routerVariant || ''),
    plannerPromptVariant: normalize(primaryRouting.plannerPromptVariant || '') !== normalize(challengerRouting.plannerPromptVariant || ''),
    reviewerPromptVariant: normalize(primaryRouting.reviewerPromptVariant || '') !== normalize(challengerRouting.reviewerPromptVariant || ''),
  };
}

/**
 * Classify the challenge type based on which dimensions varied.
 */
export function classifyChallengeType(varied: VariedDimensions): ChallengeType {
  const roleChanges = [varied.planner, varied.coder, varied.reviewer].filter(Boolean).length;
  const configChanges = [
    varied.planDepth,
    varied.codeDepth,
    varied.reviewMode,
    varied.routerVariant,
    varied.plannerPromptVariant,
    varied.reviewerPromptVariant,
  ].filter(Boolean).length;

  // All dimensions varied
  if (roleChanges === 3 && configChanges === 6) {
    return 'full-stack';
  }

  // Exactly one role varied, no config changes
  if (roleChanges === 1 && configChanges === 0) {
    if (varied.planner) return 'planner-only';
    if (varied.coder) return 'coder-only';
    if (varied.reviewer) return 'reviewer-only';
  }

  // Multiple variables changed
  return 'multi-variable';
}

export function appendChallengeComparison(record: ChallengeComparison, dir?: string): void {
  appendJsonlRecord(resolveRecordsFile(dir), record);
}

export function readChallengeComparisons(dir?: string): ChallengeComparison[] {
  const filePath = resolveRecordsFile(dir);
  if (!existsSync(filePath)) {
    return [];
  }

  return readJsonlFile<ChallengeComparison>(filePath);
}
