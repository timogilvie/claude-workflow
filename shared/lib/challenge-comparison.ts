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

  // For optional variant fields introduced post-feature-ship: only flag as varied when
  // both sides have a defined value. A legacy record (undefined) vs a new record ('baseline')
  // would otherwise produce cross-boundary false positives in variant win-rate statistics.
  const variantDiffers = (a: string | undefined, b: string | undefined): boolean => {
    const na = normalize(a || '');
    const nb = normalize(b || '');
    return na !== '' && nb !== '' && na !== nb;
  };

  return {
    planner: normalize(primaryRouting.planner) !== normalize(challengerRouting.planner),
    coder: normalize(primaryRouting.coder) !== normalize(challengerRouting.coder),
    reviewer: normalize(primaryRouting.reviewer) !== normalize(challengerRouting.reviewer),
    planDepth: normalize(primaryRouting.planDepth) !== normalize(challengerRouting.planDepth),
    codeDepth: normalize(primaryRouting.codeDepth) !== normalize(challengerRouting.codeDepth),
    reviewMode: normalize(primaryRouting.reviewMode) !== normalize(challengerRouting.reviewMode),
    routerVariant: variantDiffers(primaryRouting.routerVariant, challengerRouting.routerVariant),
    plannerPromptVariant: variantDiffers(primaryRouting.plannerPromptVariant, challengerRouting.plannerPromptVariant),
    reviewerPromptVariant: variantDiffers(primaryRouting.reviewerPromptVariant, challengerRouting.reviewerPromptVariant),
  };
}

/**
 * Classify the challenge type based on which dimensions varied.
 */
export function classifyChallengeType(varied: VariedDimensions): ChallengeType {
  const roleChanges = [varied.planner, varied.coder, varied.reviewer].filter(Boolean).length;
  // Base config dimensions are the original 3; new variant dimensions are additive.
  // Keep them separate so legacy records (which lack variant fields) can still reach 'full-stack'.
  const baseConfigChanges = [varied.planDepth, varied.codeDepth, varied.reviewMode].filter(Boolean).length;
  const totalConfigChanges = baseConfigChanges + [
    varied.routerVariant,
    varied.plannerPromptVariant,
    varied.reviewerPromptVariant,
  ].filter(Boolean).length;

  // All base dimensions varied (roles + original config); variant fields are optional extras
  if (roleChanges === 3 && baseConfigChanges === 3) {
    return 'full-stack';
  }

  // Exactly one role varied, no config changes
  if (roleChanges === 1 && totalConfigChanges === 0) {
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
