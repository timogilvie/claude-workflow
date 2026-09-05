/** Shared readiness/execution evidence selection for `compare-prs`. */

import type { EvalRecord } from './eval-schema.ts';
import {
  selectCurrentChallengeEval,
  type CurrentChallengeEvalResult,
} from './current-challenge-eval-selector.ts';

export interface CurrentPrChallengeIdentity {
  prUrl: string;
  prNumber: string;
  headSha: string;
}

export interface ChallengeComparisonEvalEvidence {
  primary: CurrentChallengeEvalResult;
  challenger: CurrentChallengeEvalResult;
  hasRequiredEvalRecords: boolean;
}

/**
 * This is intentionally mode-agnostic: --check-only and the comparison path
 * consume this exact result, so they cannot diverge on which JSONL row won.
 */
export function selectChallengeComparisonEvalEvidence(input: {
  records: readonly EvalRecord[];
  pairId: string;
  primary: CurrentPrChallengeIdentity;
  challenger: CurrentPrChallengeIdentity;
}): ChallengeComparisonEvalEvidence {
  const primary = selectCurrentChallengeEval(input.records, {
    pairId: input.pairId,
    side: 'primary',
    prUrl: input.primary.prUrl,
    prNumber: input.primary.prNumber,
    currentHeadSha: input.primary.headSha,
    // The existing unscored comparison outcome handles evaluated fast-fails.
    requireScore: false,
  });
  const challenger = selectCurrentChallengeEval(input.records, {
    pairId: input.pairId,
    side: 'challenger',
    prUrl: input.challenger.prUrl,
    prNumber: input.challenger.prNumber,
    currentHeadSha: input.challenger.headSha,
    requireScore: false,
  });
  return {
    primary,
    challenger,
    hasRequiredEvalRecords: primary.ok && challenger.ok,
  };
}
