# Task Dependency Queue — Rollout Plan

This document tracks the rollout of the dependency-aware task queue feature, which allows wavemill to sequence child tasks behind parent task PRs during autonomous mill sessions.

## Scenario Coverage

| # | Scenario | Requirement | Coverage | Test Path |
|---|----------|-------------|----------|-----------|
| 1 | Read-only analysis produces queue metadata | REQ-F2 | Shell fixture | `tests/fixtures/lifecycle/queue_readonly_analysis.sh` |
| 2 | Dependency-aware selection: roots available, children deferred | REQ-F3 | Shell fixture + unit | `tests/wavemill-launch-plan-queue-metadata.test.sh`, `tests/wavemill-queued-tasks-state.test.sh` |
| 3 | First-wave launch: roots launched, queued children held | REQ-F4 | Shell fixture | `tests/fixtures/lifecycle/queue_first_wave_launch.sh` |
| 4 | Queued child dispatch when parent PR observed | REQ-F5 | Shell fixture | `tests/fixtures/lifecycle/parent_pr_triggers_child_launch.sh` |
| 5 | PR dependency metadata: `dependsOnPr` state + PR body block | REQ-F6 | Shell fixture | `tests/fixtures/lifecycle/parent_pr_triggers_child_launch.sh`, `tests/fixtures/lifecycle/tend_blocked_by_dependency.sh` |
| 6 | Plan cache reuse via fingerprint-based hit detection | REQ-F7 | Unit test | `shared/lib/task-dependency-plan-cache.test.ts` |
| 7 | Partial refresh: per-task cache invalidation on input change | REQ-F8 | Unit test | `shared/lib/queue-partial-refresh.test.ts` |
| 8a | Fallback: queue disabled → all tasks launched immediately | REQ-F9a | Shell fixture | `tests/fixtures/lifecycle/queue_fallback_disabled.sh` |
| 8b | Fallback: parent branch missing → child stays queued with reason | REQ-F9b | Shell fixture | `tests/fixtures/lifecycle/parent_branch_missing_fails_clearly.sh` |

## End-to-End Test Runner

`tests/queue-end-to-end.test.sh` aggregates all dependency-queue lifecycle fixtures into a single executable test suite. Cache reuse (scenario 6) and partial refresh (scenario 7) are covered at the unit test level in `shared/lib/` and cited here rather than duplicated in shell fixtures.

## Key Implementation Files

| File | Role |
|------|------|
| `shared/lib/task-dependency-planner.ts` | Builds dependency graph from Linear relations |
| `shared/lib/plan-queue-utils.ts` | Computes `availableNow` / `queuedAfterDependencies` |
| `shared/lib/task-dependency-plan-cache.ts` | Fingerprint-based plan caching |
| `shared/lib/queue-partial-refresh.ts` | Per-task cache invalidation |
| `shared/lib/wavemill-startup-runner.sh` | `seed_queued_tasks_from_plan()` — seeds queued_tasks state |
| `shared/lib/wavemill-mill.sh` | `dispatch_queued_children_for_parent()` — launches children on parent PR |
| `shared/lib/wavemill-common.sh` | `queue_add_task()` / `queue_remove_task()` — state mutation helpers |
| `tools/merge-queue-select.ts` | Merge queue candidate selection |

## Operator Documentation

See `docs/mill-mode.md` § "Dependency-Aware Task Queues" for operator-facing guidance, including troubleshooting fallback modes and state inspection.

## Subsystem Specification

The machine-readable subsystem spec lives at `.wavemill/context/dependency-queue.md`. This path is gitignored by design — it is a runtime-generated artifact created by `npx tsx tools/init-project-context.ts` (or auto-initialized by `wavemill init`). The spec is present locally after initialization but is not committed to the repository.

## Rollout Closure

All scenarios are implemented and tested as of 2026-05-07.

| # | Scenario | Status | Closed In |
|---|----------|--------|-----------|
| 1 | Read-only analysis | ✅ | This PR |
| 2 | Dependency-aware selection | ✅ | Prior PRs (cited) |
| 3 | First-wave launch | ✅ | This PR |
| 4 | Queued child dispatch | ✅ | Prior PRs (cited) |
| 5 | PR dependency metadata | ✅ | Prior PRs (cited) |
| 6 | Plan cache reuse | ✅ | Prior PRs (cited) |
| 7 | Partial refresh | ✅ | Prior PRs (cited) |
| 8a | Fallback: queue disabled | ✅ | This PR |
| 8b | Fallback: parent branch missing | ✅ | Prior PRs (cited) |
