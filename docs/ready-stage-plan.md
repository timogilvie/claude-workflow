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

**Current Implementation**: All checks stubbed. See HOK-1176 for check implementation.

## Linear Issue Breakdown

Parent issue: `HOK-1138 Create Merge Readiness Step`

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
