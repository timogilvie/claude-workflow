---
title: Autonomous Integration
---

# Autonomous Integration

Autonomous integration mode inserts a managed staging branch between task PRs and `main`.

```text
task/* -> auto/integration -> main
```

Use it when you want Wavemill to merge reviewed task PRs into a shared integration branch continuously, then promote that branch to `main` on a separate cadence.

## Recommended Configuration

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

Set `mill.baseBranch` to the same branch as `integration.integrationBranch`. That keeps new task worktrees aligned with the branch tend is merging into. If `mill.baseBranch` stays on `main`, tend can still rebase each PR onto `auto/integration`, but you are pushing conflict resolution later in the pipeline.

## Pipeline

- `mill` opens task PRs against `auto/integration`.
- `ready` evaluates autonomous-merge policy guards.
- `tend` merges at most one eligible PR into `auto/integration` per pass.
- `promote` opens or refreshes the `auto/integration -> main` promotion PR.

When `integration.useMillSession = true`, the tend loop runs in the `integration` tmux window inside the existing mill session.

## Branch Protection

Recommended GitHub settings for `auto/integration`:

- Require status checks before merge.
- Require the Wavemill-ready labels and metadata workflow your repo uses before a PR is considered mergeable.
- Block direct pushes.
- Allow merges only through PRs so `tend` remains the only autonomous writer.

Recommended GitHub settings for `main`:

- Require status checks before merge.
- Require linear history if your release process expects a clean promotion trail.
- Restrict who can merge so promotion happens through the managed `auto/integration -> main` PR, not ad hoc task PRs.
- Block direct pushes.

## Required Checks

The exact check set is repo-specific, but autonomous integration should protect two surfaces:

- Task PR checks on PRs targeting `auto/integration`.
- Branch-health checks on the head commit of `auto/integration` itself.

The config surface for these rules lives in:

- [`wavemill-config.schema.json`](../wavemill-config.schema.json) for `integration` and `integration.readyPolicy`
- [`docs/ready-stage.md`](./ready-stage.md) for the ready-policy guard behavior

At minimum, protect:

- CI on every task PR
- CI on `auto/integration`
- required review/label workflows your repo depends on
- migration safety checks if you use database migrations

## High-Risk Policy

High-risk handling is split across two config names:

- `integration.highRiskPolicy` in the top-level integration config uses schema values `block`, `manual`, and `allow`.
- `integration.readyPolicy.riskPolicy` is the ready-engine setting actually enforced by autonomous merge, with values `block`, `require-label`, and `auto`.

The default top-level value is `manual`, which maps to ready-stage behavior equivalent to `require-label`.

High risk is triggered when either of these is true:

- the PR has label `Risk: High`
- the PR metadata block contains `risk: high`

Policy options:

- `block`: the PR never merges autonomously. Operator override means changing policy or merging outside the autonomous path.
- `require-label`: tend holds the PR until a human adds `wm-risk-acknowledged`.
- `auto`: tend allows the merge path to continue and records the situation as a warning instead of a block.

Recommended default:

- Use `require-label` for most repos.
- Reserve `block` for branches that must never self-merge risky changes.
- Use `auto` only when your downstream controls already absorb that risk.

## Integration-Red Halt Behavior

Before tend selects a PR, it checks the current `auto/integration` head commit. If any branch check run reports a failing conclusion, tend returns an idle status with `health=degraded` and no PR is eligible.

After a merge, tend checks `auto/integration` again. If the branch turns red after the merge, tend marks the just-merged PR as the last action, posts a failure comment, and halts the loop so operators can intervene before the next merge.

## Promotion Cadence

Promotion should be treated as a release decision, not a background side effect.

Common patterns:

- Manual cadence: run `wavemill tend promote --repo-dir <repo>` or `wavemill promote --repo-dir <repo>` when the integration branch is green and you are ready to release.
- Scheduled cadence: trigger the promote command from CI on a schedule, but still let `main` branch protection govern whether the PR can merge.

Use manual cadence when:

- deployments are coordinated
- production windows are narrow
- human approval is required for releases

Use automated cadence when:

- `auto/integration` is already your release-quality branch
- promotion PR checks are strong enough to act as the final gate

## Rollback Playbook

If a bad merge lands in `auto/integration`:

1. Revert the offending task PR or commit on `auto/integration`.
2. Re-run the integration branch checks until the branch is green again.
3. Resume `wavemill tend` only after the branch health recovers.

If the branch itself needs a hard reset:

1. Stop the tend loop.
2. Reset `auto/integration` to the last known good commit using your normal protected-branch process.
3. Re-open or recreate any task PRs that should still be considered for merge.
4. Restart tend after the branch checks are green.

## Challenge Mode

Challenge-mode PR pairs are not allowed to race into `auto/integration`. Tend waits for a resolved comparison record first.

- If no comparison exists yet, both sides stay blocked.
- If a winner exists and challenge auto-merge is enabled, tend keeps the winner eligible and closes the loser.
- If auto-merge of winners is disabled, the winner is still held for manual action.

## See Also

- [Mill Mode](mill-mode.md)
- [Ready Stage](ready-stage.md)
- [CLI Reference](cli-reference.md)
