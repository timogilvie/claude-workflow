---
title: Autonomous Integration Setup
---

Autonomous integration mode routes task PRs through a shared `auto/integration` branch before anything reaches `main`. Use it when the team wants Wavemill to merge reviewed, ready task PRs continuously while keeping the production branch behind a promotion PR.

## Branch Model

Set `mill.baseBranch` to the integration branch so new task PRs target `auto/integration`:

```json
{
  "mill": {
    "baseBranch": "auto/integration"
  },
  "integration": {
    "enabled": true,
    "integrationBranch": "auto/integration",
    "promotionBranch": "main",
    "mergeMethod": "squash",
    "deleteBranchAfterMerge": true,
    "haltOnRed": true,
    "highRiskPolicy": "manual",
    "useMillSession": true,
    "readyPolicy": {
      "enabled": true,
      "riskPolicy": "require-label",
      "enforceMigrationCoupling": true
    }
  }
}
```

With this topology, task PRs are not direct candidates for `main`. `wavemill tend` merges one ready PR into `auto/integration`; `wavemill promote` creates or updates the PR that moves `auto/integration` into `main`.

## Protect `auto/integration`

Recommended GitHub branch protection:

- require status checks for the same CI jobs required on task PRs
- block direct pushes
- require linear history if the repository expects rebased task branches
- dismiss stale reviews when task PR branches change
- restrict who can bypass branch protection

The integration branch is the autonomous queue base. If it is red, every later task PR is evaluated on top of a bad base, so `integration.haltOnRed` should remain enabled for normal operation.

## Protect `main`

Recommended GitHub branch protection:

- require review on the promotion PR
- require passing checks on the promotion PR head
- block direct pushes
- restrict admin bypasses to incident use
- keep deployment or release checks attached to the promotion PR, not only to task PRs

Promotion is intentionally separate from task merging. The controller opens or updates the release PR but does not auto-merge it.

## Operating Runbook

1. Create `auto/integration` from the current `main`.
2. Enable the config above and commit it to the repository.
3. Run `wavemill mill` as usual. New task PRs target `auto/integration` when `mill.baseBranch` is set.
4. Let the mill tmux session start the integration window when `integration.useMillSession` is enabled, or run a single pass with `wavemill tend --once --repo-dir <repo>`.
5. Use `wavemill promote --repo-dir <repo>` or `wavemill tend promote --repo-dir <repo>` to open or refresh the `auto/integration -> main` PR.
6. Review and merge the promotion PR according to the repository's release policy.

## High-Risk Choices

Choose the high-risk policy before enabling unattended tending:

- `integration.highRiskPolicy: "block"` means high-risk work should never be merged by the autonomous controller.
- `integration.highRiskPolicy: "manual"` means high-risk work needs explicit human acknowledgement.
- `integration.highRiskPolicy: "allow"` means the controller may merge high-risk work after ordinary gates pass.

When `integration.readyPolicy.enabled` is true, `integration.readyPolicy.riskPolicy` is the executable ready gate. Use `block`, `require-label`, or `auto` to match the repository stance.

## Troubleshooting

Integration red: stop tending, inspect the failing check on `auto/integration`, fix or revert on the integration branch, then rerun `wavemill tend --once`.

Dependency loops: inspect the PR metadata for `depends_on` cycles. A dependency chain must eventually reach a PR with no unresolved dependency.

Blocked Linear dependencies: complete or cancel the referenced issue, then rerun ready and tend.

Approval required: add the required acknowledgement label only after review has accepted the high-risk implication.

Rebase conflict: tend marks the PR blocked and comments with the rebase failure. Resolve the task branch against `auto/integration`, push, and rerun ready.

Challenge loser cleanup: after a comparison result, the loser is marked superseded and closed. Reopen only if the comparison record was wrong or the challenge pair is being rerun.
