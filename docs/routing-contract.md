---
title: Routing Contract
---

# Routing Contract

This note documents the current Wavemill routing lifecycle and defines the target contract for bootstrap routing, expanded routing, and the authoritative execution route.

HOK-1510 is documentation-only. It does not change runtime behavior. The promotion rules described here are the target contract for follow-up implementation work.

## Purpose

- Document where routing is produced, persisted, reread, and archived today.
- Define the target lifecycle boundary between pre-expansion routing and post-expansion execution routing.
- Identify the exact controller handoff where expanded routing must be promoted before coding and review.

## Non-Goals

- No changes to `shared/`, `tools/`, agent prompts, resume logic, or eval schemas in this issue.
- No change to the current startup behavior that treats `/tmp/{SESSION}-{ISSUE}-route.json` as the active startup routing artifact.
- No change to challenge-mode pairing, operator overrides, or phase launch behavior in this issue.

## Current Lifecycle

### Startup Runner

`shared/lib/wavemill-startup-runner.sh::startup_run_task_phases` writes `features/<slug>/.routing-complete` from the startup-selected planner/coder/reviewer/depth values and copies that file to `features/<slug>/.initial-route.json`. It then persists the same routed stage settings into `.wavemill/workflow-state.json` before launching planning.

### Dynamic Multi-Select Launch

`shared/lib/wavemill-mill.sh::prepare_route_input_for_issue` builds a minimal routing packet from `selected-task.json` when available, otherwise from the raw Linear title and description. `batch_route_selected_tasks()` routes those packets in batch and `apply_route_json_for_issue()` writes `/tmp/${SESSION}-${ISSUE}-route.json` plus `/tmp/${SESSION}-${ISSUE}-route-source.txt`. Later, `launch_task()` consumes that cached `/tmp` route or reroutes live, writes `features/<slug>/.routing-complete`, copies it to `.initial-route.json`, stores stage fields in task state, and launches planning.

### Planning Expansion

`tools/prompts/planning-phase.md` instructs the planner to route the expanded `task-packet.md` and save the result as `features/<slug>/.post-expansion-route.json`. That file is explicit post-expansion provenance today, but current controller code does not promote it into `.routing-complete`, `.phase-config.json`, or task state before coding and review launch.

### Routing-To-Planning Transition

Today the bootstrap route is what planning launches with. In startup and dynamic flows, the controller persists the pre-expansion route into `.routing-complete`, `.initial-route.json`, and task state before the planning agent starts.

### Planning-To-Coding Transition

In `shared/lib/wavemill-mill.sh`, the `planning)` branch checks `resolved_phase == "coding"`, validates the planning output, records plan approval, reads coding model and depth from `.phase-config.json` or task state, calls `set_task_phase "$ISSUE" "coding"`, and then calls `launch_coding_phase()`. This is the controller handoff where the expanded route must be promoted before coding starts.

### Coding-To-Review Transition

The `coding)` branch follows the same pattern for review: it reads reviewer model and mode from `.phase-config.json` or task state, calls `set_task_phase "$ISSUE" "review"`, and launches `launch_review_phase()`. Because review currently reads the same persisted execution settings, stale bootstrap values can carry through if the expanded route was never promoted earlier.

### Challenge Mode

Challenge selection currently derives paired workflow settings from the active route available at launch time. Startup challenge preparation reads `/tmp` route data and `resolve-challenge-task.ts`; `launch_task()` persists planner/coder/reviewer/depth values for both primary and challenger entries into task state; `shared/lib/challenge-mode.ts::pickChallengeWorkflows` computes one workflow route and shares planner, reviewer, and depth values across the primary and challenger while keeping distinct coder models.

### Resume Behavior

Resume uses persisted execution state, not a rerun of expansion routing. `detect_inflight_tasks()` reads `.wavemill/workflow-state.json`, `_restore_inflight_task_window_if_missing()` relaunches planning or coding from `.phase-config.json` first and task state second, and `restore_review_task_window()` rebuilds the review shell around the existing PR-backed task state. If only bootstrap values were ever persisted, resume will reuse those bootstrap values.

### Eval Artifact Archival

`archive_stage_artifacts()` copies `features/<slug>/.routing-complete` to `.wavemill/evals/artifacts/<issue>/routing-complete.json` and `features/<slug>/.post-expansion-route.json` to `.wavemill/evals/artifacts/<issue>/post-expansion-route.json`. `shared/lib/eval-context-gatherer.ts` currently loads `.routing-complete` or archived `routing-complete.json` as the routing decision; it archives but does not treat `post-expansion-route.json` as the authoritative execution route.

## Route Read/Write Audit

| Location | File / function | R/W | Current stage | Purpose |
| --- | --- | --- | --- | --- |
| `/tmp/${SESSION}-${ISSUE}-route.json` | `shared/lib/wavemill-mill.sh::apply_route_json_for_issue`, startup route calls, `read_route_json()` in `shared/lib/wavemill-common.sh` | read + write | startup, dynamic launch, challenge prep | Session-scoped bootstrap route artifact used during launch before worktree routing state exists. |
| `/tmp/${SESSION}-${ISSUE}-model-suggestion.json` | `shared/lib/wavemill-mill.sh` startup/dynamic compatibility writes, `read_route_json()` fallback | read + write | startup compatibility | Deprecated coder-only fallback shim for older consumers. |
| `/tmp/${SESSION}-${ISSUE}-route-source.txt` | `shared/lib/wavemill-mill.sh::apply_route_json_for_issue`, `launch_task()` | read + write | startup, dynamic launch | Records whether the current `/tmp` bootstrap route came from batch cache, startup cache, or live routing. |
| `/tmp/${SESSION}-route-batch-input.jsonl` and `/tmp/${SESSION}-route-batch-output.jsonl` | `shared/lib/wavemill-mill.sh` startup batch routing | write + read | startup | Batch bootstrap routing inputs and outputs for concurrent startup launch. |
| `/tmp/${SESSION}-dynamic-route-batch-input.jsonl` and `/tmp/${SESSION}-dynamic-route-batch-output.jsonl` | `shared/lib/wavemill-mill.sh::batch_route_selected_tasks` | write + read | dynamic multi-select | Batch bootstrap routing inputs and outputs for interactive launch. |
| `features/<slug>/.routing-complete` | `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-mill.sh::launch_task`, `shared/lib/eval-context-gatherer.ts` | read + write | post-bootstrap, resume, eval | Current persisted route decision consumed as the feature-local execution route, even though it usually still reflects bootstrap routing. |
| `features/<slug>/.initial-route.json` | `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-mill.sh::launch_task` | write | startup, dynamic launch | Explicit bootstrap provenance snapshot captured before expansion. |
| `features/<slug>/.post-expansion-route.json` | `tools/prompts/planning-phase.md`, archived by `archive_stage_artifacts()` | write + archive | planning completion, eval provenance | Explicit expanded-packet route snapshot captured after task-packet expansion. |
| `features/<slug>/.phase-config.json` | `shared/lib/wavemill-mill.sh::write_phase_config`, `read_phase_config`, resume helpers, coding/review transitions | read + write | planning handoff, coding, review, resume | Resolved per-stage execution settings used by downstream phase launches. |
| `.wavemill/workflow-state.json` | `save_task_state()`, `set_task_phase()`, `get_task_meta()`, resume helpers | read + write | launch, phase transitions, resume, challenge | Durable task ledger for planner/coder/reviewer models, depths, review mode, challenge metadata, PR state, and active phase. |
| `.wavemill/evals/artifacts/<issue>/routing-complete.json` | `archive_stage_artifacts()`, `eval-context-gatherer.ts` | read + write | cleanup, post-run eval | Archived copy of the current feature-local routing decision used by eval context loading. |
| `.wavemill/evals/artifacts/<issue>/post-expansion-route.json` | `archive_stage_artifacts()` | write | cleanup, provenance | Archived expanded-route snapshot retained for later route-drift analysis, but not loaded as the active routing decision today. |

## Target Lifecycle

### Bootstrap Route

The bootstrap route is the route produced from raw Linear issue fields, `selected-task.json`, or any other pre-expanded packet representation. It exists only to launch planning and early challenge preparation.

If a Linear description already contains unusually rich detail, the route is still a bootstrap route until planning completes and a post-expansion route is captured.

### Expanded Route

The expanded route is the route produced from `task-packet.md` after planning expansion and saved as `.post-expansion-route.json`.

If planning fails, expansion is incomplete, or `.post-expansion-route.json` is missing or malformed, no promotion occurs and execution falls back to the bootstrap route.

### Authoritative Execution Route

The authoritative execution route is the route consumed by coding, review, resume, challenge follow-on behavior, and eval context that claims to represent the execution workflow.

Target rule:

- Before expansion succeeds, the authoritative execution route is the bootstrap route.
- After expansion succeeds, the authoritative execution route must equal the expanded route.
- `FORCE_MODEL` remains a higher-priority operator override than either persisted route.

## Authoritative Promotion Point

The required promotion point is the planning-to-coding controller handoff in `shared/lib/wavemill-mill.sh` when the `planning)` branch sees `resolved_phase == "coding"`.

Target ordering at that handoff:

1. Validate planning output and approval state.
2. If `.post-expansion-route.json` is valid, promote it to the authoritative execution route.
3. Persist that promoted route into the execution-state surfaces used by later phases.
4. Only then read coding model and depth.
5. Only then call `set_task_phase "$ISSUE" "coding"`.
6. Only then call `launch_coding_phase()`.

Promotion should update the surfaces that coding, review, resume, and eval treat as execution state: `.routing-complete`, `.phase-config.json`, and `.wavemill/workflow-state.json`.

## Field Mutability

### Immutable / Provenance Fields

| Classification | Fields | Contract |
| --- | --- | --- |
| immutable | issue id, slug, original Linear issue id, bootstrap source, bootstrap capture time or source hash if added later, challenge pair identity | Expansion must not rewrite provenance or pair identity. |
| mutable-after-expansion | planner, coder, reviewer, planDepth, codeDepth, reviewRecommended or reviewMode, expectedSuccess, confidence, expectedCost, routingMode, neighborCount, signals, reasoning, challengeRecommendation | These fields may change when the richer task packet changes the route. |
| derived | resolved agent commands, `.phase-config.json` stage blocks, task-state execution fields, eval conversion fields | These should be regenerated from the authoritative execution route rather than treated as independent source-of-truth inputs. |

Special case: challenge entries may intentionally keep distinct coder models for primary and challenger. Expanded-route promotion must not erase challenge identity. Unless a future implementation explicitly changes that rule, planner, reviewer, and depth values for both sides should follow the authoritative execution route while challenger coder override remains allowed.

## Resume And Archival Contract

Resume should reconstruct active execution from the authoritative route persisted in `.phase-config.json` and `.wavemill/workflow-state.json`, while retaining `.initial-route.json` and `.post-expansion-route.json` as provenance artifacts.

The target contract is not to reroute implicitly during resume. Resume should reload the already promoted authoritative route, avoiding stale bootstrap values after planning approval but before coding or review relaunch.

Eval archival should continue retaining both `routing-complete.json` and `post-expansion-route.json` so later analysis can compare bootstrap-to-expanded drift. Current eval loading still treats `routing-complete.json` as the routing decision; follow-up runtime work can decide whether first-class bootstrap and expanded provenance fields belong in the eval schema.

## Current Vs Target Summary

| Surface | Current behavior | Target behavior |
| --- | --- | --- |
| startup runner | Writes bootstrap route to `.routing-complete` and `.initial-route.json` before planning. | Same bootstrap behavior, but clearly scoped as planning-launch input and provenance. |
| dynamic launch | Uses `/tmp` route cache or live route on raw/minimal packet, then writes `.routing-complete` and `.initial-route.json`. | Same bootstrap capture, followed by later promotion if expansion succeeds. |
| planning expansion | Writes `.post-expansion-route.json` only. | Writes `.post-expansion-route.json` and promotes it before coding/review execution begins. |
| coding and review launch | Read `.phase-config.json` or task state, which may still reflect bootstrap routing. | Read only authoritative execution state derived from the promoted expanded route. |
| challenge mode | Uses launch-time route and persists challenge-specific overrides. | Preserve distinct coder identities, but source shared planner/reviewer/depth values from the authoritative execution route after promotion. |
| resume | Relaunches from `.phase-config.json` or task state, even if they still hold bootstrap values. | Relaunches from the promoted authoritative route, keeping bootstrap and expanded artifacts only as provenance. |
| eval archival | Archives both `.routing-complete` and `.post-expansion-route.json`, but loads only `.routing-complete` as routing decision. | Preserve both artifacts and make the bootstrap-versus-expanded distinction explicit for later analysis. |

## Deferred Implementation

- Promote `.post-expansion-route.json` into `.routing-complete`, `.phase-config.json`, and `.wavemill/workflow-state.json` at the planning-to-coding handoff.
- Update resume and challenge handling so every downstream launch reads the authoritative execution route consistently.
- Clarify or revise `docs/mill-mode.md` wording that currently describes `/tmp/{SESSION}-{ISSUE}-route.json` as canonical, so it is explicitly canonical for bootstrap routing rather than all execution routing.
- Update eval loading or schema only if future runtime work needs first-class bootstrap-versus-expanded route provenance.
