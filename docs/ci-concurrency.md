# CI Concurrency: Cancelling Superseded Pull-Request Runs (HOK-2938)

`.github/workflows/ci.yml` carries a top-level `concurrency` stanza so that a
new push to a pull request cancels the obsolete CI run for its prior head,
while every other kind of run stays fully isolated.

```yaml
concurrency:
  group: ${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.run_id) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

## Behavior per event

| Event | Concurrency group | cancel-in-progress | Effect |
|-------|-------------------|--------------------|--------|
| `pull_request` | `CI-pr-<PR number>` | `true` | A second push to the same PR cancels its prior queued/in-progress run. Different PRs have different numbers, so they never affect each other. |
| `push` to `main` / `auto/integration` | `CI-<run_id>` | `false` | Unique group per run — can never be cancelled by, or queued behind, anything. |
| `schedule` | `CI-<run_id>` | `false` | Same isolation. |
| `workflow_dispatch` | `CI-<run_id>` | `false` | Same isolation. |

## Why non-PR runs are keyed by `run_id`, not ref

GitHub allows at most one running plus one *pending* run per concurrency
group, even with `cancel-in-progress: false`. If push runs were grouped by
ref (e.g. `CI-push-refs/heads/auto/integration`), a third push to
`auto/integration` while one run was active would cancel the pending second
run — silently violating "protected push runs must not be cancelled" under
exactly the burst-push pattern the merge lane produces. `github.run_id` is
unique per run, so non-PR runs never share a group with anything, at the cost
of allowing unlimited parallel push runs (the status quo before HOK-2938;
runtime cost is HOK-2939's scope).

## Edge cases

- Cancellation only affects `queued`/`in_progress` runs. A completed run's
  conclusion is never rewritten by a later push.
- `github.event.pull_request.number` is stable across reopen and synchronize
  events, so a reopened PR reuses its own group without touching other PRs.
- The `shell-and-unit` aggregator ("Shell and Unit Tests", required on
  `main`) fails whenever any needed job is `failure`, `cancelled`, or
  `skipped` — a cancelled current-head dependency can never report the
  required check green.

## How Wavemill treats cancelled runs

Cancellation is only meaningful relative to a head SHA:

- **Old head, cancelled** — informational only. `fetchPrCiStatus`
  (`shared/lib/pr-ci-status.ts`) reads `headRefOid` and `statusCheckRollup`
  in one `gh pr view` call, so the rollup always belongs to the head it
  reports; callers that know which head they expect can pass
  `expectedHeadSha` to get a conservative `pending` +
  `head-mismatch` diagnostic instead of another head's checks. Tend's
  `waitForChecks` (`shared/lib/tend-controller.ts`) likewise verifies the
  PR head each poll when given `expectedHeadSha` and skips evaluation while
  the head mismatches; a persistent mismatch returns `head-changed` instead
  of a verdict.
- **Current head, cancelled** — a failure. `normalizeStatusCheckRollup` maps
  `CANCELLED` to `failure`, and tend's failing-check sets include
  `cancelled`/`cancel`, so readiness never passes on a cancelled
  current-head check; the system waits for a replacement run or reports the
  failure.

## Contract test

`tools/check-ci-concurrency.ts` runs in `npm run test:preflight` and fails
CI when any of these guards is removed from `ci.yml`:

1. the top-level `concurrency:` block;
2. PR-number grouping (`github.event.pull_request.number` in the group);
3. `github.run_id` isolation for the non-PR branch of the group;
4. event-scoped `cancel-in-progress` (a bare `true`/`false` literal or a
   missing key fails);
5. the aggregator's `contains(needs.*.result, 'cancelled')` failure clause.

## Operational validation recipe

```bash
# REQ-F1/F2: push twice to a test PR branch within ~2 min, then:
gh run list --branch <branch-a> --event pull_request --limit 5
# expect: older run "cancelled" within ~60s, newest queued/in_progress;
# a concurrent PR B's runs untouched

# REQ-F3: while an auto/integration push run and a workflow_dispatch run
# are active, push to a PR:
gh run list --event push --limit 5
gh run list --event workflow_dispatch --limit 5
# expect: neither cancelled
```
