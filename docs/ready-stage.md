# Ready Stage

The `ready` stage is the merge-readiness gate that runs after review and before merge. Review answers "is the change correct?"; ready answers "is it safe to merge right now?"

This stage is available in two forms:

- `wavemill ready <pr>` for an on-demand check of a PR number or PR URL
- the `ready` phase inside `wavemill mill` for continuous monitor-based gating

The current implementation is a scaffolded contract with stubbed checks. The CLI shape, result schema, config surface, and merge policy are stable now so operators can adopt the workflow before HOK-1176 adds the real CI, approval, and mergeability checks.

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

Today, the shared ready-stage library returns a stub result with:

- `verdict: "pass"`
- `checks: []`
- a valid ISO 8601 `timestamp`
- a summary noting that no checks are implemented yet

That stub behavior preserves backwards compatibility while the monitor, CLI, and docs settle around a stable contract.

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

The command writes JSON to stdout so it can be consumed by scripts or the monitor:

```json
{
  "prNumber": 42,
  "verdict": "pass",
  "checks": [],
  "timestamp": "2026-04-08T12:00:00.000Z",
  "summary": "Ready stage stub - no checks implemented yet"
}
```

The shared result schema is:

| Field | Type | Meaning |
|------|------|---------|
| `prNumber` | `number` | PR that was checked |
| `verdict` | `"pass" | "fail" | "warn"` | Overall merge-readiness verdict |
| `checks` | `ReadyCheck[]` | Individual check results |
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

Operational note: the stub implementation currently returns `pass`, so the command exits `0` until real checks are added.

### Example Pass Output

This is what operators should expect today:

```json
{
  "prNumber": 42,
  "verdict": "pass",
  "checks": [],
  "timestamp": "2026-04-08T12:00:00.000Z",
  "summary": "Ready stage stub - no checks implemented yet"
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
  "timestamp": "2026-04-08T12:05:00.000Z",
  "summary": "Merge is blocked until conflicts are resolved"
}
```

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

While checks are stubbed, the monitor keeps the phase boundary visible without blocking existing workflows.

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

## Compatibility Mode

The ready stage is opt-in. Existing repositories remain compatible if they do not configure it.

Compatibility cases:

- `ready` missing from `.wavemill-config.json`: ready stage is disabled by default
- `"enabled": false`: ready stage stays disabled
- `"enabled": true`: ready stage is active and the monitor/CLI should use the ready contract

Backwards-compatibility expectations:

- repositories that have not opted in should not see workflow regressions
- the stubbed implementation preserves the CLI and result shape without requiring a live readiness engine
- existing review and merge workflows can continue while teams adopt the ready phase incrementally

Minimal opt-in example:

```json
{
  "ready": {
    "enabled": true
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

- ready result shows `merge-conflicts` with status `fail`
- GitHub reports the PR is not mergeable

Typical response:

```bash
git fetch origin
git checkout task/my-branch
git rebase origin/main
# resolve conflicts
git add <resolved-files>
git rebase --continue
git push --force-with-lease
wavemill ready 42
```

Recovery goal:

- get the PR back to a clean merge state
- rerun ready after the force-push

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
    "enabled": false,
    "checks": [],
    "requiredChecks": []
  }
}
```

### Options

| Setting | Type | Default | Meaning |
|---------|------|---------|---------|
| `ready.enabled` | `boolean` | `false` | Master switch. Must be explicitly enabled. |
| `ready.checks` | `string[]` | `[]` | Checks to run. Empty means all available checks. |
| `ready.requiredChecks` | `string[]` | `[]` | Subset of checks that must pass for merge approval. |

### Minimal Configuration

```json
{
  "ready": {
    "enabled": true
  }
}
```

### Explicit Full Configuration

```json
{
  "ready": {
    "enabled": true,
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

When checks are stubbed, the contract and docs can still be adopted. When HOK-1176 lands, operators should already be running against the correct CLI, config, and policy surface.
