# Ready Stage Subsystem

The ready subsystem has two cooperating loops:

- `tools/ready.ts` runs the local readiness checks and writes structured results.
- `tools/ready-watchdog.ts` compares local ready state against GitHub truth during monitor ticks.

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

## Merge-Lane Dedupe and Rate-Limiting

Merge-lane watchdog findings (`waiting-on-merge-lane` and stalled `needs-user`) include volatile idle/waited minute counts in their detail text. To prevent repeated log spam when only the minute count changes, the watchdog uses a **stable fingerprint** that strips those tokens (`idle Nm` → `idle Xm`, `waited Nm` → `waited Xm`) before comparing against the last logged entry.

All repeated `reported` findings (same classification, action, and stable fingerprint) are **rate-limited**: subsequent emissions within `WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS` (default: 3600s) are suppressed. The state file (`ready-watchdog-state.json`) still receives current idle-minute counts on every tick so the dashboard stays accurate without generating noise.

State entries track four `lastLogged*` fields (`lastLoggedAt`, `lastLoggedFingerprint`, `lastLoggedClassification`, `lastLoggedAction`) to distinguish "current dashboard state" from "last emitted event." Existing state files without these fields are treated as never logged and emit once on the next tick.

## Migration Checks

When a repo has `alembic/versions/` and no explicit `ready.checks`, ready auto-enables:

- `migration-chain-integrity` as a required universal check.
- `migration-base-refresh` as a non-blocking pre-check that fetches the base branch before migration validation.

Operators can disable this with `ready.migrationChecks.enabled = false`.
