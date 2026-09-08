# Wavemill Terminal Lifecycle And Resources

Wavemill task state separates workflow outcome from resource disposition. Legacy `status` and `phase` remain display and compatibility fields; consumers that decide cleanup, slot accounting, Observer classification, or startup recovery must read the normalized lifecycle view.

## Canonical Fields

Each task may carry `lifecycle` in `.wavemill/workflow-state.json`:

- `workflowOutcome`: `active`, `merged`, `closed`, `aborted`, or `error`.
- `resourceDisposition`: `allocated`, `released`, `retained`, `reaping`, `reaped`, or `verification-required`.
- `launchContract`: immutable effective launch and cleanup contract. It records base branch, base SHA, integration mode, merge method, remote branch deletion policy, challenge role/pair, session/run epoch, and window ID.
- `deliveryEvidence`: mutable evidence learned later, including reviewed/published head SHA, PR head SHA, PR number/state/base, and merge SHA.
- `retention`: required when a terminal outcome still has allocated, retained, or verification-required resources.

The lifecycle schema is `shared/schemas/task-lifecycle-state.schema.json`; TypeScript readers use `shared/lib/task-lifecycle.ts`.

## Slot Accounting

Mill slot consumption follows `resourceDisposition`, not `phase` naming:

- Consumes a slot: `allocated`, `reaping`.
- Does not consume a slot: `released`, `retained`, `reaped`, `verification-required`.

Queue-owned ready tasks are `released` and do not consume a task pane slot. Retained or verification-required terminal tasks stay visible/actionable but do not block new launches merely because their old phase was terminal.

## Allowed Combinations

`active + allocated` is the normal in-flight task state. `active + released` is allowed for queue handoff. `active + reaping` is allowed during durable cleanup.

Terminal outcomes (`merged`, `closed`, `aborted`, `error`) may use `reaping`, `reaped`, or `released` without retention. They may use `allocated`, `retained`, or `verification-required` only with `retention.reason`.

Invalid combinations:

- `active + reaped`.
- Any terminal outcome with `allocated`, `retained`, or `verification-required` and no retention reason.
- Any remote branch deletion decision without `launchContract.remoteBranchDeletionPolicy.allowed` explicitly set by the effective launch/session contract.

## Terminal Postconditions

| Terminal reason | Workflow outcome | Resource postcondition |
| --- | --- | --- |
| `review_complete` | `active` | PR/review evidence may be recorded; resources remain `allocated` unless queue handoff releases the pane. |
| `ready_complete` | `active` | Ready evidence may be recorded; resources remain `allocated` until queue handoff or cleanup. |
| `pr_opened` | `active` | PR evidence is recorded; no pane release is implied. |
| `pr_merged` | `merged` | Pane policy `release` (unless `REQUIRE_CONFIRM` holds the window open): transcript is archived, a terminal record is written, and the pane is killed. Cleanup separately moves git resources through `reaping` to `reaped` or fail-safe retention. |
| `pr_closed_unmerged` | `closed` | Pane policy `release`. No branch deletion authority is implied; cleanup must retain or verify git resources before removal, and the pane is released either way. |
| `challenge_resolved_winner` | `closed` | Pane policy `release`. Losing side may be cleaned by existing challenge cleanup authority; retained state needs an explicit reason. |
| `challenge_invalid` | `closed` | Pane policy `release`. Git resources are retained or verification-required unless cleanup completes. |
| `challenge_no_comparison` | `closed` | Pane policy `release`. Git resources are retained or verification-required unless cleanup completes. |
| `challenge_superseded` | `closed` | Pane policy `release`. Legacy status/phase may remain `superseded`; it maps to the closed workflow outcome and never rehydrates as active work. |
| `operator_abort` | `aborted` | Cleanup authority is unchanged; remote PR branches are retained. |
| `recovery_failure` | `error` | Resources require manual verification unless cleanup can prove they were reaped. |

## Ownership

- Panes: task-owned while `allocated`; queue-owned when `released`; cleanup-owned while `reaping`; manually owned when `retained` or `verification-required`.
- Worktrees and local branches: cleanup may remove them only after existing dirty/unpushed-work guards pass.
- Remote branches: deletion requires an explicit lifecycle launch contract and existing PR-merged evidence. Legacy state never grants this authority by default.
- Hooks: terminal reconciliation may terminalize hook state, but that is not proof of pane release.
- Retries and incidents: cleanup failures retain task state and write retry/incident evidence rather than deleting uncertain resources.
- Task-state entries: removed only after cleanup has reached `reaped`, or by pre-existing explicit state-removal paths whose safety contracts already own that decision.

## Pane Release vs Git Retention (HOK-2952)

Terminal pane release is deterministic, truthful, idempotent, and independent of git worktree/branch cleanup. Killing the tmux window never deletes or modifies git work, and preserving git work never keeps a dead pane allocated.

### Policy table

`wavemill_terminal_pane_policy_for_reason` (shared/lib/terminal-reconciler.sh) maps every terminal reason to one pane action:

| Terminal reason | Pane policy |
| --- | --- |
| `pr_merged`, `pr_closed_unmerged`, `challenge_resolved_winner`, `challenge_invalid`, `challenge_no_comparison`, `challenge_superseded` | `release` |
| `review_complete`, `ready_complete`, `pr_opened` | `metadata-only` (workflow still active; HOK-2937 queue handoff owns any release) |
| `operator_abort`, `recovery_failure` | `retain` (the pane is the operator's diagnostic surface) |

Overrides, applied in order: the feature gate off downgrades `release` to `metadata-only`; `REQUIRE_CONFIRM=true` on `pr_merged` downgrades to `metadata-only` (the "window stays open for review" operator hold).

For a closed, unmerged PR, `closed_pr_resource_policy` (shared/lib/wavemill-monitor.sh) decides the git side: a challenger whose challenge comparison is still pending under auto-merge gets `pane-release-only` (git work must survive for the comparison; the challenge loser-cleanup path keeps deletion authority), and every other role — non-challenge tasks, tasks with missing/drifted `challengeRole`, and manual-review challengers — gets `full-cleanup` through `cleanup_completed_task`, whose fail-safe guards retain unproven git work while the pane is still released.

### Release sequence and fault boundaries

`wavemill_release_terminal_pane` runs a fault-ordered sequence: ownership guard → archive diagnostics → durable terminal record → verified `kill-window` → truthful state write. Each step is idempotent, so an interruption at any boundary converges on the next monitor pass with no duplicate errors:

1. **Ownership guard**: a live agent process in the pane (`mill_pane_has_live_blocking_process`), indeterminate liveness, or a fresh hook in `working`/`waiting`/`approval-needed`/`blocked` blocks release. A missing or already-dead window with ownership proven is treated as success and still completes the remaining steps.
2. **Archive**: full pane scrollback is captured to `.wavemill/evals/artifacts/<issue>/pane-transcript-<reason>.txt` and the current hook snapshot is appended to the feature dir's `.terminal-history.jsonl`. Archive failures never block release.
3. **Terminal record**: `.wavemill/evals/artifacts/<issue>/terminal-record.json` (atomic tmp+mv, survives worktree deletion) records issue, reason, PR, branch, worktree, head SHA, window target, whether the transcript was archived, and a `recovery` block telling an operator how to recover retained work without a live pane.
4. **Kill**: `tmux kill-window` is verified; the hook file is removed only after the window is gone.
5. **State**: `paneState=released`, `paneReleased=true`, `paneReleasedAt`, `terminalRecordWritten=true`. `resourceDisposition` stays owned by git truth — it becomes `released` only for an `active`+`allocated` task; `retained`/`verification-required`/`reaping`/`reaped` from cleanup are never overwritten, so fields describe the real state of tmux and git, not an attempted action.

`cleanup_completed_task` uses the same primitive before its git steps, so a worktree-removal failure, preserved unpushed work, or unverified remote-branch cleanup keeps the git-side retention *without* re-allocating the pane. Retained and verification-required tasks do not consume a mill slot (see Slot Accounting), so a retained dirty worktree never blocks new launches.

### Feature gate and rollback

`terminal.paneRelease.enabled` (default **true**; user → repo → local config layering) and the `WAVEMILL_TERMINAL_PANE_RELEASE=0` env kill-switch disable automated release. Rollback keeps the truthful state fields, archived transcripts, and terminal records — only the kill step stops happening.

### Recovering retained work after pane release

1. Read `.wavemill/evals/artifacts/<issue>/terminal-record.json` — its `recovery.howToRecover` names the branch and (if it still existed at release time) the worktree.
2. `pane-transcript-<reason>.txt` beside it holds the final pane scrollback; the feature dir's `.terminal-history.jsonl` holds hook-state history.
3. If the worktree was retained, it is still on disk at the recorded path; otherwise re-create one with `git worktree add <dir> <branch>`.

## Legacy Migration

Readers normalize old or malformed task records on read. Missing launch contracts, missing remote branch deletion policy, terminal status with active pane metadata, or malformed lifecycle values become `resourceDisposition=verification-required` and `branchDeletionAuthorized=false`.

Startup does not mass-rewrite legacy state. Normal state mutations backfill lifecycle fields when enough effective session data is available, while preserving unknown fields for rollback compatibility.

## Startup Terminal Preflight

`wavemill mill` runs `wavemill_startup_terminal_preflight` after the state ledger exists and before stale cleanup, the resume menu, tmux session creation, pane restoration, or agent launch. The preflight checks persisted task entries against bounded GitHub PR evidence, persisted lifecycle state, and challenge sibling state. Entries whose PR or sibling state is already terminal are routed through `wavemill_reconcile_terminal`; entries that remain active and have enough provenance are stamped as rehydratable.

Each startup has a `runEpoch` (`YYYYMMDDTHHMMSSZ-<pid>`) exported as `WAVEMILL_RUN_EPOCH`/`RUN_EPOCH`. The top-level state file records the current `.runEpoch`. New task launch contracts record the same value in `lifecycle.launchContract.runEpoch`; rehydrated historical entries keep their original immutable launch contract and use the per-entry preflight stamp to show whether they were checked in the current startup.

Per-entry stamps live at `.tasks[issue].startupPreflight`:

- `verdict`: `rehydrate`, `terminal:<reason>`, `superseded`, `verification-required:<reason>`, or `unverified:network`.
- `reason`: the verdict detail without the prefix when applicable.
- `prState`: confirmed `OPEN`, `MERGED`, `CLOSED`, `UNKNOWN`, or empty when no PR evidence was required.
- `checkedAt`: UTC timestamp for this startup check.
- `runEpoch`: the startup epoch that produced the stamp.

`verification-required:*` entries are preserved and do not launch an agent. `unverified:network` preserves state without destructive action and writes one aggregated network episode to `.wavemill/startup-preflight.json`. The rollback lever is `startup.terminalPreflight.enabled=false` or `WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0`; rollback skips the preflight but does not rewrite terminal entries to active state.
