# Challenge Comparison

Challenge pairs now persist an explicit comparison state on both tasks in the pair.

## States

- `comparison_running`: comparison job is in flight.
- `retrying_eval`: at least one eval timed out and wavemill is retrying within the configured cap.
- `manual_comparison_needed`: automatic comparison could not complete after bounded retries.

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

- `retrying_eval` should remain an active, non-terminal wait.
- `manual_comparison_needed` is a `needs-user` condition. The pair should not look merge-ready until an operator resolves the comparison manually.
