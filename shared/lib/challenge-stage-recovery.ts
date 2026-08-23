import type { ChallengeStage } from './challenge-mode.ts';

const VALID_STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];
const VALID_STAGE_SET = new Set<string>(VALID_STAGES);

export interface ChallengeStageRecoveryRecord {
  challengeSide?: 'primary' | 'challenger';
  challengeIntent?: {
    challengeStage?: unknown;
    selectedStage?: unknown;
    primary?: { challengeStage?: unknown };
    challenger?: { challengeStage?: unknown };
  };
}

export function isChallengeStage(value: unknown): value is ChallengeStage {
  return typeof value === 'string' && VALID_STAGE_SET.has(value);
}

export function stageFromChallengeType(value: unknown): ChallengeStage | undefined {
  if (value === 'planner-only') return 'plan';
  if (value === 'coder-only') return 'implementation';
  if (value === 'reviewer-only') return 'review';
  return undefined;
}

export function recoverStageFromIntent(record: ChallengeStageRecoveryRecord): ChallengeStage | undefined {
  const intent = record.challengeIntent;
  if (!intent) return undefined;
  if (isChallengeStage(intent.challengeStage)) return intent.challengeStage;
  if (isChallengeStage(intent.selectedStage)) return intent.selectedStage;

  const sideIntent = record.challengeSide === 'challenger' ? intent.challenger : intent.primary;
  if (isChallengeStage(sideIntent?.challengeStage)) return sideIntent.challengeStage;
  if (isChallengeStage(intent.primary?.challengeStage)) return intent.primary.challengeStage;
  if (isChallengeStage(intent.challenger?.challengeStage)) return intent.challenger.challengeStage;
  return undefined;
}
