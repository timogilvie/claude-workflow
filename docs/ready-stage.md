# Ready Stage

The `ready` stage is the merge-readiness gate that runs after review and before merge. Review answers "is the change correct?"; ready answers "is it safe to merge right now?"

This stage is available in two forms:

- `wavemill ready <pr>` for an on-demand check of a PR number or PR URL
- the `ready` phase inside `wavemill mill` for continuous monitor-based gating

The ready stage now includes live GitHub mergeability detection for open PRs. Merge-conflict state is reported separately from the readiness verdict so operators and the monitor can distinguish conflict remediation from other readiness failures.

## Overview

The ready stage sits between PR creation and merge:

```text
review -> ready -> merge
```

Responsibilities of each phase:

- `review`: judge correctness, requirements coverage, and major code-quality blockers
- `ready`: judge merge-readiness, release-readiness, and operator follow-up steps
- `merge`: complete the PR only after the ready gate is satisfied

The target check categories for the ready stage are:

- CI status
- required approvals
- merge conflicts
- branch freshness
- release and manual-step requirements

Current implementation details:

- mergeability comes from `gh pr view --json mergeable,mergeStateStatus`
- GitHub `UNKNOWN` mergeability is retried up to 3 times with 5-second delays
- merge conflict state is surfaced in a dedicated `mergeConflict` field
- the readiness verdict still reflects the configured `checks` array

## CLI Usage

### Syntax

```bash
wavemill ready <pr>
```

Direct tool invocation during development uses the TypeScript entrypoint:

```bash
npx tsx tools/ready.ts <pr>
```

### Arguments

| Argument | Meaning |
|----------|---------|
| `<pr>` | GitHub PR number like `42` or PR URL like `https://github.com/org/repo/pull/42` |

### Options

| Flag | Meaning |
|------|---------|
| `--repo-dir <path>` | Repository directory to inspect. Defaults to the current directory. |

### Examples

Check a PR by number:

```bash
cd ~/src/my-repo
wavemill ready 42
```

Check a PR by URL:

```bash
wavemill ready https://github.com/acme/widgets/pull/42
```

Check a PR from another checkout:

```bash
wavemill ready 42 --repo-dir ~/src/my-repo
```

### Output Format

The command writes human-readable mergeability status to `stderr` and JSON to `stdout` so it can still be consumed by scripts or the monitor:

```json
{
  "prNumber": 42,
  "verdict": "warn",
  "checks": [
    {
      "name": "release-requirements",
      "status": "warn",
      "message": "No task packet found - skipping release requirements check",
      "details": {}
    }
  ],
  "mergeConflict": {
    "status": "CLEAN",
    "message": "No merge conflicts detected",
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "CLEAN",
    "attempts": 1
  },
  "timestamp": "2026-04-08T12:00:00.000Z",
  "summary": "Checks passed with warnings - review before merge"
}
```

The shared result schema is:

| Field | Type | Meaning |
|------|------|---------|
| `prNumber` | `number` | PR that was checked |
| `verdict` | `"pass" | "fail" | "warn"` | Overall merge-readiness verdict |
| `checks` | `ReadyCheck[]` | Individual check results |
| `mergeConflict` | `MergeConflictResult \| undefined` | GitHub mergeability state for the PR |
| `timestamp` | `string` | ISO 8601 UTC timestamp |
| `summary` | `string` | Human-readable overall summary |

Each item in `checks` has:

| Field | Type | Meaning |
|------|------|---------|
| `name` | `string` | Stable check identifier such as `ci-status` |
| `status` | `"pass" | "fail" | "warn" | "skip"` | Result for that check |
| `message` | `string` | Human-readable explanation |
| `details` | `Record<string, unknown>` | Optional structured context |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Ready verdict is `pass` or `warn` |
| `1` | Ready verdict is `fail` |

Operational note: `mergeConflict.status` is independent from the main verdict. A PR can have clean readiness checks but still be blocked because GitHub reports merge conflicts.

### Example Pass Output

Example clean mergeability output:

```json
{
  "prNumber": 42,
  "verdict": "pass",
  "checks": [
    {
      "name": "ci-status",
      "status": "pass",
      "message": "All CI checks passing"
    }
  ],
  "mergeConflict": {
    "status": "CLEAN",
    "message": "No merge conflicts detected",
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "CLEAN",
    "attempts": 1
  },
  "timestamp": "2026-04-08T12:00:00.000Z",
  "summary": "All checks passed - safe to merge"
}
```

### Example Fail Output

The fail shape below shows the contract operators and scripts should be prepared to handle once real checks are implemented:

```json
{
  "prNumber": 42,
  "verdict": "fail",
  "checks": [
    {
      "name": "merge-conflicts",
      "status": "fail",
      "message": "PR has merge conflicts with main",
      "details": {
        "state": "conflicted"
      }
    },
    {
      "name": "approvals",
      "status": "pass",
      "message": "Required approvals are present"
    }
  ],
  "mergeConflict": {
    "status": "CONFLICTED",
    "message": "PR has merge conflicts with base branch",
    "mergeable": "CONFLICTING",
    "mergeStateStatus": "DIRTY",
    "attempts": 1
  },
  "timestamp": "2026-04-08T12:05:00.000Z",
  "summary": "Merge is blocked until conflicts are resolved"
}
```

## Merge Conflict Detection

The ready engine checks mergeability with:

```bash
gh pr view <pr> --json mergeable,mergeStateStatus
```

GitHub computes mergeability lazily, so the first response can be `UNKNOWN`. The ready engine retries up to 3 times with 5-second delays before surfacing `UNKNOWN` to the caller.

Reported merge states:

- `CLEAN`: GitHub reports the PR can merge cleanly
- `CONFLICTED`: GitHub reports merge conflicts
- `UNKNOWN`: GitHub is still computing mergeability after retries
- `ERROR`: GitHub CLI failed or returned an unexpected state

## Automatic Conflict Resolution

When `wavemill mill` runs the ready stage and sees `mergeConflict.status = "CONFLICTED"`:

1. It writes `features/<slug>/.conflict-detected` in the existing worktree.
2. It relaunches the task agent in that same worktree with a conflict-resolution-only prompt.
3. The agent fetches the base branch, merges it, resolves conflicts, validates, commits, and pushes.
4. After the agent exits, the monitor reruns `wavemill ready <pr>`.

If conflicts persist, or mergeability comes back `UNKNOWN` or `ERROR`, the monitor writes `features/<slug>/.needs-attention` and marks the task for operator follow-up.

## Monitor Behavior

`wavemill mill` uses the same ready-stage contract for automatic merge gating after review completes and a PR exists.

The intended workflow is:

```text
coding -> review -> PR open -> ready -> merge
```

Monitor responsibilities in the ready phase:

- move a task from `review` into `ready` once the PR is open
- run the same shared readiness engine used by `wavemill ready <pr>`
- persist the result in workflow state
- keep the task blocked from merge completion until the ready gate passes
- rerun readiness after operator action or automated remediation
- surface merge conflicts separately from other readiness verdict failures

Expected state transitions:

| From | Condition | To |
|------|-----------|----|
| `review` | PR created successfully | `ready` |
| `ready` | all required checks pass | `merge` |
| `ready` | required check fails | `blocked` or stay in `ready` pending remediation |
| `ready` | warnings only | `merge` with operator awareness |

Practical operator interpretation:

- a passing ready result means merge may proceed
- a warning result means merge may proceed, but the warning must be consciously handled
- a failing result means do not merge until the blocking condition is cleared

For conflicted PRs, the monitor attempts a narrow in-place remediation before escalating to the operator.

## Merge-Gating Policy

Policy for repositories adopting the ready stage:

1. Do not merge a PR until the ready check has run.
2. Do not allow human override for a `fail` verdict unless there is a documented incident-level reason.
3. Treat `warn` as mergeable only when the operator has completed or explicitly accepted the listed manual steps.
4. Keep the merge decision tied to the latest ready result, not an older successful run.

Manual operator workflow:

```bash
wavemill ready 42
```

Use the result to answer three questions before merge:

- Are blocking checks failing?
- Are there manual release steps that must happen before or after merge?
- Is the result current for the latest PR head?

Recommended merge rule once real checks are live:

- `pass`: merge allowed
- `warn`: merge allowed only with explicit operator handling of the warning
- `fail`: merge blocked

## Ready Configuration

The ready stage always runs for mill-managed repositories. The `ready` config section controls which checks run and which checks are required; it does not disable the ready phase itself.

Configuration cases:

- `ready` missing from `.wavemill-config.json`: all available ready checks can run
- `ready.checks`: restricts the set of checks to run
- `ready.requiredChecks`: marks a subset of checks as merge-blocking

Workflow expectations:

- the ready contract remains stable even as checks are added
- existing review and merge workflows continue after the ready gate reports `pass` or `warn`

Minimal explicit configuration:

```json
{
  "ready": {
    "checks": [],
    "requiredChecks": []
  }
}
```

## Failure Paths And Recovery

The ready stage exists to make blocking conditions explicit. The scenarios below describe the operator response expected once the real checks are enabled.

### CI Failure

Symptoms:

- ready result shows a failing `ci-status` check
- the PR is not safe to merge yet

Typical response:

```bash
gh pr checks 42
gh run view <run-id> --log-failed
```

Recovery:

- fix the failing code or flaky test in the worktree
- push a new commit
- rerun `wavemill ready 42`
- merge only after the verdict returns to `pass` or acceptable `warn`

### Merge Conflicts

Symptoms:

- ready result shows `mergeConflict.status = "CONFLICTED"`
- GitHub reports the PR is not mergeable

Typical response:

- let `wavemill mill` attempt automatic remediation first
- if it writes `.needs-attention`, open the existing worktree and resolve manually

Recovery goal:

- get the PR back to a clean merge state
- rerun ready after the push

### Approval Failure

Symptoms:

- ready result shows the approvals check failed
- required reviewers have not approved or approval was dismissed

Typical response:

```bash
gh pr view 42 --json reviews,reviewDecision
```

Recovery:

- request the missing reviewer
- address review feedback
- rerun `wavemill ready 42` after approvals land

### Manual Release Steps Required

Symptoms:

- ready result returns `warn`
- the result references a manual deployment, config, or migration action

Typical response:

- confirm who owns the manual step
- decide whether the step must happen before merge or immediately after merge
- record the handoff in the PR or release notes

Example operator checklist:

```text
- apply production config change
- run migration playbook
- invalidate caches
- confirm post-merge smoke check owner
```

### Network Or API Error

Symptoms:

- CLI exits non-zero before producing a usable result
- GitHub or local repo inspection fails transiently

Typical response:

```bash
wavemill ready 42 --repo-dir ~/src/my-repo
```

Recovery:

- rerun the command
- verify repository access and GitHub authentication
- avoid merging while readiness status is unknown

## Configuration Reference

Ready-stage settings live in `.wavemill-config.json` under `ready`.

### Schema

```json
{
  "ready": {
    "checks": [],
    "requiredChecks": []
  }
}
```

### Options

| Setting | Type | Default | Meaning |
|---------|------|---------|---------|
| `ready.checks` | `string[]` | `[]` | Checks to run. Empty means all available checks. |
| `ready.requiredChecks` | `string[]` | `[]` | Subset of checks that must pass for merge approval. |

### Minimal Configuration

```json
{
  "ready": {
    "checks": [],
    "requiredChecks": []
  }
}
```

### Explicit Full Configuration

```json
{
  "ready": {
    "checks": ["ci-status", "approvals", "merge-conflicts", "manual-steps"],
    "requiredChecks": ["ci-status", "approvals", "merge-conflicts"]
  }
}
```

Guidance:

- use `checks` to narrow which checks are evaluated
- use `requiredChecks` to distinguish blockers from advisory checks
- keep `requiredChecks` aligned with branch-protection and release policy

## Operator Policy Summary

Use the ready stage as the final pre-merge decision point.

- Review passing is necessary but not sufficient.
- Ready passing is the merge gate.
- Failures block merge.
- Warnings require deliberate operator handling.
- Missing ready configuration keeps existing workflows compatible.

The ready contract, monitor behavior, and operator policy should stay stable as additional checks are added.
