# Challenge Comparison

Challenge pairs now persist an explicit comparison state on both tasks in the pair.

Launch invariant: non-control challenge pairs must differ on at least one routing dimension before any challenger work starts. Comparable routing dimensions are `planner`, `coder`, `reviewer`, `planDepth`, `codeDepth`, and `reviewMode`.

## States

- `comparison_running`: comparison job is in flight.
- `retrying_eval`: at least one eval timed out and wavemill is retrying within the configured cap.
- `manual_comparison_needed`: automatic comparison reached a terminal manual-attention state, including bounded retry exhaustion and settled comparison job failures.

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

## Coder Override Contract (HOK-2272)

When launching the coding phase for a challenge task, `challengeModel` overrides the
phase-config/expanded coder route ONLY when the challenge varied the implementation/coding
stage (`challengeStage == "implementation"` or absent for legacy tasks).

For plan-stage and review-stage challenges, `challengeModel` refers to the varied stage's
model (planner or reviewer), not the coder. The coding handoff honors the expanded/refreshed
`coderModel` from `.phase-config.json.coding.model` or task metadata in these cases.

### Stage-Aware Override Logic

- `challengeStage == "implementation"` OR `challengeStage` is absent → `challengeModel` overrides coder
- `challengeStage == "plan"` → honor expanded coder route (challengeModel is the varied planner)
- `challengeStage == "review"` → honor expanded coder route (challengeModel is the varied reviewer)

### Related Issues

- **HOK-2237**: Established full routing field persistence on challenge refresh
- **HOK-2272**: Gated coder override on `challengeStage` to fix route-to-launch mismatch
  for non-coder-stage challenges

## Merge-Lane Expectations

- `retrying_eval` should remain an active, non-terminal wait.
- `manual_comparison_needed` is a `needs-user` condition. The pair should not look merge-ready until an operator resolves the comparison manually.
- Failed comparison jobs must not leave `comparison_running` behind after settlement. They transition the pair to `manual_comparison_needed` and preserve the failure in `comparisonBlockedReason`.
- Identical-routing pairs are a terminal skipped-comparison outcome, not a failed comparison job. The compare backstop records `comparisonOutcome=skipped`, `skipReason=identical-routing-dimensions`, and `cleanupPolicy=primary-wins-close-challenger`.
- Skipped identical pairs deterministically declare the primary as winner and the challenger as the cleanup target. This keeps the merge lane moving and prevents watchdog retry spam.
