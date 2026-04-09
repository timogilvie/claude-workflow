# Implementation Plan: `ready` Stage and `wavemill ready <pr>`

## Overview

Add a new workflow stage named `ready` that runs after PR review and before merge. This stage will evaluate merge readiness, post a strict release-readiness verdict, detect merge conflicts, and support targeted agent re-entry for fixups.

The standalone entrypoint for this work is:

```bash
wavemill ready <pr>
```

The long-running `wavemill mill` monitor should also use the same underlying readiness engine so that post-PR checks are consistent whether they are run manually or automatically.

## Goals

- Introduce a first-class `ready` stage in the mill workflow.
- Add a standalone `wavemill ready <pr>` CLI command.
- Build a shared release-readiness engine that combines deterministic checks with planning-aware reasoning.
- Detect open-PR merge conflicts and support targeted agent re-entry to resolve them.
- Encode planning metadata needed for release readiness:
  - `database_change_risk: none | possible | required`
  - release/manual-step expectations

## Architectural Direction

### Shared core

Create a shared TypeScript library responsible for:

- loading task packet + plan context
- reading PR metadata and diff against base
- inspecting deploy/config/package-script files
- evaluating DB/schema/migration expectations
- checking for non-code release requirements
- checking GitHub mergeability / conflict state
- producing a structured verdict

This library should be used by both:

- the standalone `wavemill ready <pr>` command
- the `wavemill mill` post-PR `ready` phase

### Workflow shape

Current phase flow:

```text
routing -> planning -> coding -> review -> PR open -> merged/closed
```

Target flow:

```text
routing -> planning -> coding -> review -> ready -> merge
```

Where:

- `review` still handles self-review and PR creation
- `ready` handles merge readiness and merge-conflict remediation
- merge should not be considered safe until `ready` passes

## Stage Transition Refactor

The current phased workflow relies on a fragile combination of:

- agent-specific exit behavior inside reused tmux panes
- filesystem markers such as `.plan-approved` and `.coding-complete`
- monitor polling that infers transition safety from pane state and marker timing

That model has already produced repeated bugs across abort handling, Codex launch mode, pane readiness, and cross-phase model selection. The `ready` stage should not be added on top of the same mechanism. Instead, HOK-1174 should establish the new contract for all phased execution.

### Proposed contract

The orchestrator, not the agent, owns workflow state transitions.

Each task should persist:

- `features/<slug>/.phase-config.json`
- one controller-owned result file per stage, for example:
  - `features/<slug>/.planning-result.json`
  - `features/<slug>/.coding-result.json`
  - `features/<slug>/.review-result.json`
  - `features/<slug>/.ready-result.json`

`phase-config.json` is the canonical source for resolved per-stage configuration:

- planner model / agent / depth
- coder model / agent / depth
- reviewer model / agent / mode
- ready-stage model / agent / mode when introduced
- challenge metadata if applicable
- the effective configuration after applying overrides such as `FORCE_MODEL`

Each stage result file is written by the orchestrator after observing the stage outcome and should include:

- `status`: `running | awaiting_user | completed | aborted | failed`
- `startedAt`
- `finishedAt`
- `agent`
- `model`
- `artifacts`
- `notes` or `failureReason` when relevant

### Key design decisions

1. Agents produce work artifacts, not workflow bookkeeping.

- Planning produces `plan.md`
- Coding produces code changes, commits, and test results
- Review produces a PR
- Ready produces readiness output

The orchestrator records the structured stage result after observing those artifacts. Agents should not be responsible for emitting the final JSON state record.

2. User approval is a real stage state.

Planning should transition to `awaiting_user` once the plan is ready for review. User approval should be recorded by the controller as a separate transition from planning completion, rather than inferred from `.plan-approved` alone.

3. Stage launches should use fresh execution.

Each stage should launch a fresh process or tmux window/pane instance rather than reusing a live interactive session across planning, coding, review, and ready. tmux remains a visibility/debugging layer, but not the state machine.

4. Prompts should be agent-agnostic about lifecycle.

Prompts should no longer tell agents to run `/exit`, remain in the session, or otherwise manage phase transitions manually. They should only describe the stage task and any required work artifacts. The orchestrator handles termination and progression.

5. Migration must support both contracts during rollout.

While in-flight work still uses legacy markers, the monitor should support a compatibility path:

- read structured stage result files when present
- fall back to legacy markers when the new files are absent

Once all in-flight legacy tasks have drained, the marker path can be removed.

## Required Output Contract

Every ready check should emit a compact block:

```markdown
## Release Readiness
- Database impact: none | schema changed | migration required
- Migration committed: yes | no | not applicable
- Production migration application: automatic | manual | not applicable
- Env/config changes required: yes | no
- Manual release steps required: yes | no
- Merge verdict: safe | safe with manual steps | not safe

### Required actions before/after merge
- ...
```

Also track merge conflict state separately:

- `clean`
- `conflicted`
- `unknown`

## Planning Metadata Schema

Task packets and implementation plans include a `## Release Readiness` section with the following structured fields. The ready-stage engine (HOK-1176) reads these fields to compare implementation against planning expectations.

### Fields

| Field | Type | Allowed Values | Description |
|-------|------|---------------|-------------|
| `database_change_risk` | enum | `none`, `possible`, `required` | Whether the task is expected to involve database schema changes |
| `env_changes` | list | comma-separated names or `none` | Environment variables that must be added or changed for deployment |
| `config_changes` | list | comma-separated names or `none` | Configuration file changes required for deployment |
| `manual_steps` | list | descriptive items or `none` | Manual steps required before or after merge (e.g., run migration script, update DNS) |

### Markdown Format

```markdown
## Release Readiness
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
```

Example with populated fields:

```markdown
## Release Readiness
- **database_change_risk**: required
- **env_changes**: NEW_API_KEY, FEATURE_FLAG_X
- **config_changes**: config/production.json
- **manual_steps**: Run migration script `scripts/migrate-v2.sh`, Update CDN cache rules
```

### Parsing Rules

- `database_change_risk` must be exactly one of `none`, `possible`, or `required` (case-sensitive)
- List fields use comma-separated values; `none` maps to an empty list
- The section is optional — existing task packets without it remain valid
- Extraction returns `null` when the section is absent

## Delivery Plan

### 1. Ready stage contract and CLI skeleton

Define the new stage name (`ready`), CLI surface (`wavemill ready <pr>`), and shared result schema before wiring behavior into the monitor. This creates a stable contract for later issues.

### 2. Planning metadata for release readiness

Extend planning/task-packet generation and validation to include:

- `database_change_risk`
- release requirements / manual-step expectations

This makes the readiness gate planning-aware instead of relying on freeform prose.

### 3. Shared release-readiness engine

Implement the deterministic + synthesized checks behind a reusable library and a standalone CLI command:

- PR diff inspection
- schema / migration reconciliation
- deployment application check
- env/config/manual-step detection
- strict verdict generation

### 4. Mill integration for the `ready` phase

Teach the monitor to transition open PRs into `ready`, run the shared readiness engine, and keep the issue blocked from merge completion until the gate passes.

### 5. Merge conflict monitoring and auto-resolution handoff

Inspect open PR mergeability during the `ready` stage. When conflicts exist, re-enter the agent in the existing worktree with a narrow prompt to rebase/merge and resolve conflicts automatically, then rerun readiness.

### 6. Tests, docs, and rollout policy

Add test coverage, docs, and policy changes so the new stage is operable:

- `Do not allow user merges until ready passes`
- docs for `wavemill ready <pr>`
- monitor and review-mode documentation

## Linear Issue Breakdown

Parent issue: `HOK-1138 Create Merge Readiness Step`

### Current Status

The issue tree started executing against an earlier version of this plan before the phase-transition refactor was fully articulated:

- `HOK-1174` shipped in PR `#208`
- `HOK-1175` shipped in PR `#207`
- `HOK-1176` shipped in PR `#213`
- `HOK-1183` shipped in PR `#214`
- `HOK-1178` shipped in PR `#215`

Because of that, the stage-transition refactor described above should be treated as follow-up architectural guidance layered on top of the shipped baseline, not as a retroactive rewrite of completed issue scopes. The contract-gap work already captured in `HOK-1183` remains the bridge from the original scaffold toward a more controller-owned model.

This avoids reopening completed work or silently changing the meaning of merged PRs.

## Implementation Contract (HOK-1174)

### Type Definitions

The ready stage contract is defined in `shared/lib/ready-stage.ts`:

- `ReadyCheckStatus`: 'pass' | 'fail' | 'warn' | 'skip'
- `ReadyCheck`: Individual check result with name, status, message, details
- `ReadyResult`: Overall result with verdict, checks array, timestamp, summary
- `ReadyStageConfig`: Configuration for ready stage

### CLI Surface

Command: `wavemill ready <pr>`

Arguments:
- `<pr>`: PR number or GitHub PR URL

Options:
- `--repo-dir <path>`: Repository directory (default: current directory)

Output: JSON to stdout  
Exit codes: 0 for pass/warn, 1 for fail

### Configuration

In `.wavemill-config.json`:

```json
{
  "ready": {
    "enabled": false,  // Must be explicitly enabled
    "checks": [],      // Empty = run all available checks
    "requiredChecks": []  // Subset that must pass
  }
}
```

### Phase Boundary

**Review → Ready Transition**: Occurs when PR is opened. Review judges code quality; ready judges merge-readiness.

**Current Implementation**: The scaffold shipped in HOK-1174; follow-on issues add the engine, controller compatibility, conflict handling, and full monitor wiring.

### Issue 1

Identifier: `HOK-1174`

Title: `Define ready-stage workflow contract and scaffold wavemill ready`

Priority: High

Dependencies: none

Scope:

- add the `ready` stage concept to workflow/state handling
- add CLI command scaffolding for `wavemill ready <pr>`
- define the shared result schema and stage artifacts
- document phase boundaries between `review` and `ready`

### Issue 2

Identifier: `HOK-1175`

Title: `Add planning metadata for release readiness expectations`

Priority: High

Dependencies: Issue 1

Scope:

- add `database_change_risk` to planning/task-packet outputs
- add release-requirements/manual-step fields
- update prompt templates and validation logic
- flag unexpected DB changes vs expected DB changes

### Issue 3

Identifier: `HOK-1176`

Title: `Implement shared release-readiness engine and ready CLI`

Priority: High

Dependencies: Issue 1, Issue 2

Scope:

- implement shared readiness library
- implement `wavemill ready <pr>`
- support deterministic checks plus final structured verdict
- produce the required release-readiness block

### Issue 4

Identifier: `HOK-1177`

Title: `Integrate ready stage into wavemill mill monitor and merge policy`

Priority: High

Dependencies: Issue 3

Scope:

- transition PRs from `review` to `ready`
- persist ready-stage status in workflow state
- keep merge completion gated on ready pass
- support safe / safe-with-manual-steps / not-safe outcomes

### Issue 5

Identifier: `HOK-1178`

Title: `Add merge-conflict detection and targeted agent re-entry for open PRs`

Priority: Normal

Dependencies: Issue 4

Scope:

- inspect GitHub mergeability for open PRs
- detect conflicted PRs during `ready`
- relaunch the agent in the existing worktree with a conflict-resolution prompt
- rerun ready checks after conflict resolution

### Issue 6

Identifier: `HOK-1179`

Title: `Add tests and documentation for the ready stage`

Priority: Normal

Dependencies: Issue 2, Issue 3, Issue 4, Issue 5

Scope:

- add unit/integration coverage for readiness checks and monitor transitions
- update mill-mode/review-mode/README docs
- document operator behavior and failure cases
- document the policy that merges require a passing ready check

## Recommended Execution Order

1. Issue 1
2. Issue 2
3. Issue 3
4. Issue 4
5. Issue 5
6. Issue 6

This ordering intentionally minimizes merge conflicts by keeping the workflow contract, planning metadata, engine, monitor wiring, and docs/tests in separate steps with explicit dependencies.

## Gap Analysis (HOK-1183 Backfill)

After HOK-1174 (PR `#208`) shipped and HOK-1176 (PR `#213`) merged, the revised architecture identified requirements that were not part of the original delivery plan. This section tracks the delta.

| Requirement | Status | Issue |
|---|---|---|
| Ready stage type definitions (`ReadyCheck`, `ReadyResult`, `ReadyStageConfig`) | Shipped | HOK-1174 |
| CLI surface (`wavemill ready <pr>`) | Shipped | HOK-1174 |
| Planning metadata (`database_change_risk`, env/config/manual-step fields) | Shipped | HOK-1175 |
| Shared readiness engine (`runReadyStage`, deterministic checks, verdict) | Shipped | HOK-1176 |
| Config schema (`ready.enabled`, `ready.checks`, `ready.requiredChecks`) | Shipped | HOK-1174 |
| Mill integration (`launch_ready_phase` shell function) | Shipped | HOK-1176 |
| Controller-owned readiness check (`controllerCheckReadiness`) | Backfilled | HOK-1183 |
| Legacy marker compatibility (`checkLegacyMarkers`) | Backfilled | HOK-1183 |
| Controller readiness CLI (`tools/controller-ready.ts`) | Backfilled | HOK-1183 |
| Shell orchestrator stub (`check_ready_stage`) | Backfilled | HOK-1183 |
| Phase transition wiring in orchestrator | Shipped | HOK-1177 |
| Controller-owned stage state (.phase-config.json) | Shipped | HOK-1177 |
| Explicit awaiting_user state for plan approval | Shipped | HOK-1177 |
| Stage-result JSON artifacts | Shipped | HOK-1177 |
| Legacy marker fallback compatibility | Shipped | HOK-1177 |
| Ready-phase blocking of merge completion | Deferred | HOK-1182 |
| Full mill-mode integration, dashboard, monitoring | Deferred | HOK-1182 |
| Merge conflict detection and auto-resolution | Shipped | HOK-1178 |
| Tests and documentation for full ready stage | Shipped | HOK-1179 |

## Handoff Boundaries

Explicit deliverables and expectations for each issue in the ready-stage chain.

### HOK-1176 → HOK-1183

**HOK-1176 delivers:**
- Shared readiness engine: `runReadyStage()` with `checkSchemaMigrations`, `checkCIStatus`, `checkReleaseRequirements`, `checkDeployPaths`
- `wavemill ready <pr>` CLI via `tools/ready.ts`
- Basic `launch_ready_phase()` shell function in `wavemill-mill.sh`

**HOK-1183 expects from HOK-1176:**
- `ReadyCheck`, `ReadyResult`, `ReadyStageConfig` types exported from `shared/lib/ready-stage.ts`
- `computeVerdict()` exported for reuse
- `getReadyConfig()` available from `shared/lib/config.ts`

### HOK-1183 → HOK-1177

**HOK-1183 delivers:**
- `controllerCheckReadiness(featureDir)` — evaluates feature directory phase state without PR/GitHub context
- `checkLegacyMarkers(featureDir)` — detects `.plan-approved`, `.coding-complete`, `.workflow-aborted` and maps to `ReadyCheck[]`
- `ControllerReadinessResult` and `LegacyMarkerResult` types
- `tools/controller-ready.ts` — thin CLI wrapper
- `check_ready_stage()` shell function stub in `wavemill-mill.sh`

**HOK-1177 expects from HOK-1183:**
- `controllerCheckReadiness()` function callable from shell via `tools/controller-ready.ts`
- `check_ready_stage()` shell function defined with stable interface
- Phase detection logic that maps markers to `planning | coding | review | ready | aborted | unknown`

### HOK-1177 → HOK-1182

**HOK-1177 delivers:**
- Controller-owned stage state via `shared/lib/stage-state.sh`
- `.phase-config.json` as canonical per-task stage state file
- Per-stage result files (`.planning-result.json`, `.coding-result.json`, etc.)
- Explicit `awaiting_user` phase between planning and coding
- `stage_state_transition()` called at every phase boundary in the monitor loop
- Legacy marker fallback when `.phase-config.json` is absent
- Phase transition wiring: orchestrator calls `stage_state_transition()` at transition points

**HOK-1182 expects from HOK-1177:**
- `.phase-config.json` exists in feature directories for all new tasks
- `stage_state_get_current()` returns the authoritative phase for any feature dir
- Stage-result JSON files exist after each completed phase
- `launch_ready_phase()` fully integrated into the phase loop
- Ready-stage state persisted via `.ready-result.json` and `.phase-config.json`
