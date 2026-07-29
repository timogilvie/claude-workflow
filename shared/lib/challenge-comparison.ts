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

export type RoutingDimensionKey =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'planDepth'
  | 'codeDepth'
  | 'reviewMode';

export type ChallengeType =
  | 'coder-only'
  | 'planner-only'
  | 'reviewer-only'
  | 'multi-variable'
  | 'full-stack';

export type StageEvidenceMode = 'direct' | 'inferred-fallback' | 'not-applicable';
export type ChallengeComparisonOutcome = 'compared' | 'skipped' | 'forfeit' | 'double-forfeit' | 'invalid_challenge';
export type ChallengeTerminalReason =
  | 'eval_hard_failed'
  | 'primary_eval_hard_failed'
  | 'challenger_eval_hard_failed'
  | 'both_eval_hard_failed'
  | 'orphan_pair';

export interface ChallengeComparison {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  winner?: 'primary' | 'challenger';
  winnerModel?: string;
  rationale: string;
  dimensions: ChallengeComparisonDimensions;
  timestamp: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  variedDimensions?: VariedDimensions;
  challengeType?: ChallengeType;
  variedStage?: 'plan' | 'implementation' | 'review';
  stageEvidenceMode?: StageEvidenceMode;
  workflowInsight?: string;
  comparisonOutcome?: ChallengeComparisonOutcome;
  skipReason?: 'identical-routing-dimensions';
  invalidChallengeReason?: 'stage_override_lost' | 'native_launch_fallback' | 'identical_effective_route';
  invalidChallengeDetails?: string;
  invalidChallenge?: boolean;
  primaryAttestation?: unknown;
  challengerAttestation?: unknown;
  terminalReason?: ChallengeTerminalReason;
  cleanupPolicy?: 'primary-wins-close-challenger';
  /** Source of the primary comparison score (e.g. "stage.review", "stage.plan", "overall") */
  primaryEvalScoreSource?: string;
  /** Source of the challenger comparison score */
  challengerEvalScoreSource?: string;
  /** Data-quality warnings emitted when a stage score was unavailable */
  dataQualityWarnings?: string[];
}

export interface ChallengeComparisonDimensions {
  completeness: { primary: number; challenger: number };
  correctness: { primary: number; challenger: number };
  code_quality: { primary: number; challenger: number };
  intervention_impact: { primary: number; challenger: number };
  autonomy: { primary: number; challenger: number };
}

interface LegacyChallengeComparisonDimensions {
  correctness: { primary: number; challenger: number };
  codeQuality: { primary: number; challenger: number };
  completeness: { primary: number; challenger: number };
  scopeDiscipline: { primary: number; challenger: number };
}

export type StoredChallengeComparison = Omit<ChallengeComparison, 'dimensions'> & {
  dimensions: ChallengeComparisonDimensions | LegacyChallengeComparisonDimensions;
};

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const CHALLENGE_RECORDS_FILENAME = 'challenge-records.jsonl';
const ROUTING_DIMENSION_KEYS: readonly RoutingDimensionKey[] = [
  'planner',
  'coder',
  'reviewer',
  'planDepth',
  'codeDepth',
  'reviewMode',
];
const EMPTY_DIMENSIONS: ChallengeComparisonDimensions = {
  completeness: { primary: 0, challenger: 0 },
  correctness: { primary: 0, challenger: 0 },
  code_quality: { primary: 0, challenger: 0 },
  intervention_impact: { primary: 0, challenger: 0 },
  autonomy: { primary: 0, challenger: 0 },
};

type ChallengeEntryLike = {
  planner?: string;
  model?: string;
  reviewer?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
};

function resolveRecordsFile(dir?: string): string {
  const baseDir = resolve(dir || DEFAULT_EVALS_DIR);
  return join(baseDir, CHALLENGE_RECORDS_FILENAME);
}

function normalize(value: string | undefined): string {
  return value?.trim() || '';
}

function variantDiffers(a: string | undefined, b: string | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na !== '' && nb !== '' && na !== nb;
}

export function routingMetaFromChallengeEntry(entry: ChallengeEntryLike): ChallengeRoutingMeta {
  return {
    planner: normalize(entry.planner),
    coder: normalize(entry.model),
    reviewer: normalize(entry.reviewer),
    planDepth: normalize(entry.planDepth),
    codeDepth: normalize(entry.codeDepth),
    reviewMode: normalize(entry.reviewMode),
  };
}

export function listVariedRoutingDimensions(
  primaryRouting: ChallengeRoutingMeta | undefined,
  challengerRouting: ChallengeRoutingMeta | undefined,
): RoutingDimensionKey[] {
  if (!primaryRouting || !challengerRouting) {
    return [];
  }

  return ROUTING_DIMENSION_KEYS.filter(
    (key) => normalize(primaryRouting[key]) !== normalize(challengerRouting[key]),
  );
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
  const variedRoutingDimensions = new Set(listVariedRoutingDimensions(primaryRouting, challengerRouting));

  return {
    planner: variedRoutingDimensions.has('planner'),
    coder: variedRoutingDimensions.has('coder'),
    reviewer: variedRoutingDimensions.has('reviewer'),
    planDepth: variedRoutingDimensions.has('planDepth'),
    codeDepth: variedRoutingDimensions.has('codeDepth'),
    reviewMode: variedRoutingDimensions.has('reviewMode'),
    routerVariant: variantDiffers(primaryRouting.routerVariant, challengerRouting.routerVariant),
    plannerPromptVariant: variantDiffers(primaryRouting.plannerPromptVariant, challengerRouting.plannerPromptVariant),
    reviewerPromptVariant: variantDiffers(primaryRouting.reviewerPromptVariant, challengerRouting.reviewerPromptVariant),
  };
}

export function hasAnyVariedDimension(varied: VariedDimensions): boolean {
  return Object.values(varied).some(Boolean);
}

/**
 * Classify the challenge type based on which dimensions varied.
 */
export function classifyChallengeType(varied: VariedDimensions): ChallengeType {
  if (!hasAnyVariedDimension(varied)) {
    throw new Error('Cannot classify challenge type: no routing dimensions varied');
  }

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

export function buildSkippedIdenticalComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  timestamp?: string;
}): ChallengeComparison {
  const variedDimensions = detectVariedDimensions(input.primaryRouting, input.challengerRouting);
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryEvalScore: input.primaryEvalScore,
    challengerEvalScore: input.challengerEvalScore,
    winner: 'primary',
    winnerModel: input.primaryRouting?.coder || input.primaryModel,
    rationale: 'Comparison skipped because primary and challenger used identical routing dimensions.',
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    variedDimensions,
    workflowInsight: 'No LLM comparison was run because both workflows resolved to identical routing dimensions.',
    comparisonOutcome: 'skipped',
    skipReason: 'identical-routing-dimensions',
    cleanupPolicy: 'primary-wins-close-challenger',
  };
}

export function buildInvalidChallengeComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  reason: 'stage_override_lost' | 'native_launch_fallback' | 'identical_effective_route';
  details?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryAttestation?: unknown;
  challengerAttestation?: unknown;
  timestamp?: string;
}): ChallengeComparison {
  const variedDimensions = detectVariedDimensions(input.primaryRouting, input.challengerRouting);
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryEvalScore: input.primaryEvalScore,
    challengerEvalScore: input.challengerEvalScore,
    rationale: input.details || `Invalid challenge: ${input.reason}`,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    primaryRouting: input.primaryRouting,
    challengerRouting: input.challengerRouting,
    variedDimensions,
    comparisonOutcome: 'invalid_challenge',
    invalidChallenge: true,
    invalidChallengeReason: input.reason,
    ...(input.details ? { invalidChallengeDetails: input.details } : {}),
    ...(input.primaryAttestation ? { primaryAttestation: input.primaryAttestation } : {}),
    ...(input.challengerAttestation ? { challengerAttestation: input.challengerAttestation } : {}),
    workflowInsight: 'No LLM comparison was run because the selected challenge intent did not execute.',
  };
}

export function buildForfeitComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  winner: 'primary' | 'challenger';
  rationale: string;
  terminalReason: ChallengeTerminalReason;
  timestamp?: string;
}): ChallengeComparison {
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryEvalScore: 0,
    challengerEvalScore: 0,
    winner: input.winner,
    winnerModel: input.winner === 'primary' ? input.primaryModel : input.challengerModel,
    rationale: input.rationale,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    comparisonOutcome: 'forfeit',
    terminalReason: input.terminalReason,
  };
}

export function buildDoubleForfeitComparison(input: {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  rationale: string;
  terminalReason: ChallengeTerminalReason;
  timestamp?: string;
}): ChallengeComparison {
  return {
    challengePairId: input.challengePairId,
    primaryModel: input.primaryModel,
    challengerModel: input.challengerModel,
    primaryPrUrl: input.primaryPrUrl,
    challengerPrUrl: input.challengerPrUrl,
    primaryEvalScore: 0,
    challengerEvalScore: 0,
    winner: 'primary',
    winnerModel: input.primaryModel,
    rationale: input.rationale,
    dimensions: EMPTY_DIMENSIONS,
    timestamp: input.timestamp || new Date().toISOString(),
    comparisonOutcome: 'double-forfeit',
    terminalReason: input.terminalReason,
  };
}

export function readChallengeComparisons(dir?: string): StoredChallengeComparison[] {
  const filePath = resolveRecordsFile(dir);
  if (!existsSync(filePath)) {
    return [];
  }

  return readJsonlFile<StoredChallengeComparison>(filePath);
}
