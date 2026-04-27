---
title: Prompt Execution Audit
---

# Prompt Execution Audit

This audit inventories the prompt-construction and orchestration paths that currently exist in the repo, identifies which ones are live, and proposes a low-risk consolidation sequence.

## Prompt-Construction Inventory

| Function | File | Line | Template source | Callers |
|---|---|---:|---|---|
| `build_autonomous_prompt` | `shared/lib/agent-adapters.sh` | removed in this change | inline heredoc | none |
| `build_interactive_prompt` | `shared/lib/agent-adapters.sh` | 210 | inline heredoc | `tests/check-shell.sh:816` |
| `build_routing_prompt` | `shared/lib/agent-adapters.sh` | 334 | inline heredoc | `tests/check-shell.sh:812` |
| `build_planning_prompt` | `shared/lib/agent-adapters.sh` | 421 | `tools/prompts/planning-phase.md` | `shared/lib/wavemill-startup-runner.sh:513`, `shared/lib/wavemill-mill.sh:3099`, `tests/check-shell.sh:768`, `tests/check-shell.sh:772`, `tests/check-shell.sh:792` |
| `build_coding_prompt` | `shared/lib/agent-adapters.sh` | 545 | `tools/prompts/coding-phase.md` | `shared/lib/wavemill-mill.sh:3128`, `tests/check-shell.sh:776`, `tests/check-shell.sh:780`, `tests/check-shell.sh:796`, `tests/check-shell.sh:808` |
| `build_conflict_resolution_prompt` | `shared/lib/agent-adapters.sh` | 668 | inline heredoc | `shared/lib/wavemill-mill.sh:3457` |
| `build_ready_remediation_prompt` | `shared/lib/agent-adapters.sh` | 719 | inline heredoc | `shared/lib/wavemill-mill.sh:3558` |
| `build_review_prompt` | `shared/lib/agent-adapters.sh` | 787 | `tools/prompts/review-phase.md` | `shared/lib/wavemill-mill.sh:3157`, `tests/check-shell.sh:784`, `tests/check-shell.sh:788`, `tests/check-shell.sh:800`, `tests/check-shell.sh:804` |

## Call Graph

| Builder | Production callers | Phase | Agent surface |
|---|---|---|---|
| `build_planning_prompt` | `wavemill-startup-runner.sh`, `wavemill-mill.sh` | planning | mill-managed Claude/Codex launch |
| `build_coding_prompt` | `wavemill-mill.sh` | coding | mill-managed Claude/Codex launch |
| `build_review_prompt` | `wavemill-mill.sh` | review | mill-managed Claude/Codex launch |
| `build_conflict_resolution_prompt` | `wavemill-mill.sh` | conflict remediation | mill-managed Claude/Codex launch |
| `build_ready_remediation_prompt` | `wavemill-mill.sh` | ready remediation | mill-managed Claude/Codex launch |
| `build_routing_prompt` | none | legacy/test render only | not launched in production |
| `build_interactive_prompt` | none | legacy/test render only | not launched in production |
| `build_autonomous_prompt` | none | removed path | not launched in production |

## Orchestration Entry Points

| Entry point | Role | Current status |
|---|---|---|
| `shared/lib/wavemill-mill.sh` | Main orchestrator and phase launcher | active |
| `shared/lib/wavemill-startup-runner.sh` | Startup planner launcher invoked by mill | active |
| `shared/lib/wavemill-orchestrator.sh` | Thin compatibility wrapper that execs startup runner | deprecated |
| `codex/src/commands/workflow.js` plus `codex/prompts/*.md` | Codex-native state machine and prompt docs | active, intentionally separate |

## Classification

| Surface | Classification | Justification |
|---|---|---|
| `build_planning_prompt` | active | Production callers in startup runner and mill orchestrator |
| `build_coding_prompt` | active | Production caller in mill orchestrator |
| `build_review_prompt` | active | Production caller in mill orchestrator |
| `build_conflict_resolution_prompt` | active | Production caller in mill orchestrator |
| `build_ready_remediation_prompt` | active | Production caller in mill orchestrator |
| `build_routing_prompt` | dead, test-only | No production callers; rendered only by shell regression test |
| `build_interactive_prompt` | dead, test-only | No production callers; rendered only by shell regression test |
| `build_autonomous_prompt` | dead, zero callers | Repository-wide search found only the function definition |
| `wavemill-orchestrator.sh` | deprecated wrapper | Script prints its own deprecation notice and just execs startup runner |

## Deprecation Resolution

The stale part of the issue description is the claim that `wavemill-startup-runner.sh` is deprecated.

The code says the opposite:

- `shared/lib/wavemill-orchestrator.sh` prints `wavemill-orchestrator.sh is deprecated.` when invoked without a launch plan.
- `shared/lib/wavemill-mill.sh` still calls `shared/lib/wavemill-startup-runner.sh`.
- `git log --oneline -- shared/lib/wavemill-startup-runner.sh` shows recent maintenance, including `694de1a`, `95786c4`, and `df43035`.
- Commit `0976b92` removed skip-planning mode, which explains why `build_autonomous_prompt` no longer has any live path.

## Codex Workflow

`codex/prompts/*.md` and `codex/src/commands/workflow.js` form an intentional parallel workflow rather than an accidental duplicate of the shell builders:

- Codex tracks phase state in code under `codex/src/workflow.js`.
- Codex command entry points live under `codex/src/commands/`.
- `codex/README.md` documents prompt usage via `~/.codex/prompts`.
- No shell builder in `shared/lib/agent-adapters.sh` is used by the Codex-native workflow.

That separation should be documented clearly, but it should not be merged into the shell prompt builders.

## Refactoring Roadmap

1. Delete `build_autonomous_prompt()` from `shared/lib/agent-adapters.sh`.
   Verification: repository-wide search shows zero callers.
2. Delete `build_routing_prompt()` and the regression render that snapshots it from `tests/check-shell.sh`.
   Verification: diff the rendered routing prompt before removal and confirm routing now lives in `route-task.ts`.
3. Delete `build_interactive_prompt()` and its regression render from `tests/check-shell.sh`.
   Verification: diff the rendered interactive prompt before removal and confirm split-phase workflow is the only supported path.
4. Remove `shared/lib/wavemill-orchestrator.sh` or reduce it to a temporary compatibility shim with an explicit removal target.
   Verification: search for direct callers and update any remaining tests or docs.
5. Extract shared issue-context assembly used by `wavemill-startup-runner.sh` and `wavemill-mill.sh` into one helper.
   Verification: compare rendered planning prompts before and after extraction to keep output byte-identical.
6. Keep documenting Codex as an intentional parallel in `docs/prompt-locations.md` and related entrypoint docs.
   Verification: doc-only.

## First Consolidation Step in This Change

This change implements the safest first step from the roadmap: removing `build_autonomous_prompt()`.

The verification burden is low because the function had no callers and no tests. There is no runtime output path to compare, only the absence of dead code to maintain.
