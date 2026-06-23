# Ready Stage Subsystem

The ready subsystem has two cooperating loops:

- `tools/ready.ts` runs the local readiness checks and writes structured results.
- `tools/ready-watchdog.ts` compares local ready state against GitHub truth during monitor ticks.

The watchdog refreshes `.wavemill/ready-watchdog-state.json` on every tick so dashboard data like `idleMinutes` stays current, but it only emits returned findings and appends `.wavemill/ready-watchdog.jsonl` when a finding is newly actionable, materially reclassified, or the optional `READY_WATCHDOG_RELOG_SECONDS` heartbeat interval expires. Merge-lane waiting/stalled fingerprints intentionally ignore the changing idle-minute text so repeated monitor ticks do not spam logs.

## Watchdog Classifications

- `fresh`: local ready state has progressed recently enough.
- `waiting-on-ci`: checks are still pending or failing, but the failure is not yet stable enough to act on.
- `stable-failing-safe`: the same safe-to-remediate CI failure persisted across the configured number of polls. The watchdog emits `queue-remediation`.
- `stuck`: GitHub is clean and green, but the local ready state stopped advancing.
- `auto-update`: the PR is mergeable but behind its base branch.
- `waiting-on-eval-comparison`: background eval/comparison work is still running.
- `needs-user`: ambiguous, unsafe, or exhausted conditions that require operator attention.

## Safety Gate

Watchdog-triggered remediation is default-deny:

- Only failures matching `ready.watchdog.safeRemediationCategories` are considered safe.
- Safe failures must remain unchanged for `stableFailureConsecutivePolls`.
- Unsafe failures escalate only after `stableFailureEscalateAfterPolls`.
- Remediation still runs through `launch_ready_phase`, so existing per-PR launch caps and launch-head deduplication stay in force.

## Migration Checks

When a repo has `alembic/versions/` and no explicit `ready.checks`, ready auto-enables:

- `migration-chain-integrity` as a required universal check.
- `migration-base-refresh` as a non-blocking pre-check that fetches the base branch before migration validation.

Operators can disable this with `ready.migrationChecks.enabled = false`.
