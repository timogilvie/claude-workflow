# Challenge Comparison

Challenge pairs now persist an explicit comparison state on both tasks in the pair.

## States

- `comparison_running`: comparison job is in flight.
- `retrying_eval`: at least one eval timed out and wavemill is retrying within the configured cap.
- `manual_comparison_needed`: automatic comparison could not complete after bounded retries.
- `skipped_identical`: legacy pair reached comparison with identical canonical routing dimensions; comparison is recorded as a deterministic primary win without invoking the judge.

## Stored Fields

- `comparisonState`
- `comparisonBlockedReason`
- `comparisonRetryCount`
- `comparisonRetryMaxAttempts`
- `comparisonRetryTargetIssue`
- `comparisonTimedOutSides`
- `manualComparisonArtifact`

## Timeout Flow

1. An eval job times out.
2. Wavemill records the pair-level timeout on both tasks.
3. If `challenge.eval.retryMaxAttempts` has not been exhausted, the pair moves to `retrying_eval` and the timed-out eval is relaunched through the normal eval path.
4. If retries are exhausted, the pair moves to `manual_comparison_needed` and wavemill writes `ready/challenge-comparison-needed.md` under the primary task feature directory.

## Merge-Lane Expectations

- Challenge launch must vary at least one canonical routing dimension across planner, coder, reviewer, plan depth, code depth, or review mode.
- Launch-time repair is bounded and idempotent: try the configured stage first, then a deterministic alternative model on another canonical stage, otherwise fall back to a single run before work starts.
- Unrepairable launch plans must downgrade to single-mode rather than launching a challenger that cannot be compared.
- `skipped_identical` is terminal. The persisted comparison record resolves ready/tend gates, primary wins by policy, and challenger cleanup follows the existing loser path.
- `retrying_eval` should remain an active, non-terminal wait.
- `manual_comparison_needed` is a `needs-user` condition. The pair should not look merge-ready until an operator resolves the comparison manually.
