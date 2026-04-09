---
title: Mill Mode
---

Use `wavemill mill` when you want continuous execution of backlog tasks with parallel agents.

## What It Does

- Fetches and ranks backlog tasks from Linear and prompts you for what's next.
- Expands issues that are missing implementation detail into effective plans.
- Assesses the task and chooses the best model
- Launches parallel worktrees/agents via `tmux`.
- Monitors PR, ready-stage, and merge status.
- Cleans up completed tasks and updates issue state.
- **Auto-updates project context** after each PR merge with a summary of changes.

## Run It

```bash
cd <your-project>
wavemill mill
```

Common overrides:

```bash
MAX_PARALLEL=5 wavemill mill
AGENT_CMD=codex wavemill mill
```

## Safety Defaults

- conflict checks for overlapping areas/components
- migration conflict avoidance
- review-to-ready-to-merge gating before marking tasks done
- persistent workflow state in `.wavemill/workflow-state.json`

## Ready Phase

When the ready stage is enabled, `wavemill mill` inserts a merge-readiness phase after PR creation and before merge completion:

```text
review -> ready -> merge
```

In that phase, the monitor is responsible for:

- running the same shared contract exposed by `wavemill ready <pr>`
- recording whether the PR is ready, blocked, or warning-only
- holding merge completion until required ready checks pass
- surfacing manual release steps and merge-conflict remediation needs

The current implementation is scaffolded and returns a stub ready result, which keeps the workflow backwards-compatible while the full readiness engine is built out. For operator details, see [Ready Stage](ready-stage.md).

## Operator Controls

- `Ctrl+B D` detach from `tmux`
- `touch ~/.wavemill/.stop-loop` stop after current cycle
- `Ctrl+C` interrupt and reset in-progress tasks

## When to Prefer Mill Mode

Use mill mode when your backlog has many independent tasks and your team is comfortable reviewing multiple agent-generated PRs in parallel.

## Project Context Integration

Mill mode automatically maintains a `.wavemill/project-context.md` file that helps agents learn from previous work.

### Setup

**Option 1: Use `wavemill init` (Recommended)**
```bash
cd ~/your-repo
wavemill init
# Answer 'Y' when prompted to initialize project context
```

**Option 2: Auto-initialization**

When you first run `wavemill mill` or `wavemill expand`, you'll be prompted:
```bash
wavemill mill
# Will prompt: "Initialize project context? [Y/n]"
```

Skip the prompt with: `SKIP_CONTEXT_CHECK=true wavemill mill`

**Option 3: Manual initialization**
```bash
npx tsx tools/init-project-context.ts
```

### How It Works

After initialization, the file is **automatically updated** after each PR merge with:
- What changed in the implementation
- New patterns or conventions established
- Known gotchas or constraints discovered

This ensures that agent #5 knows what agents #1-4 built, leading to more consistent implementations and fewer repeated mistakes.

### Maintenance

- The "Recent Work" section is auto-updated (append-only)
- Other sections (Architecture, Conventions) can be manually edited
- Agents receive this context when expanding Linear issues

## Routing Artifact Contract

At startup, `wavemill mill` runs `route-task.ts --json` per task and persists the result
as `/tmp/{SESSION}-{ISSUE}-route.json`. This is the **canonical routing artifact** —
all downstream consumers should read it via `read_route_json()` from `wavemill-common.sh`.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `planner` | string | Model ID for the planning phase |
| `coder` | string | Model ID for the coding phase |
| `reviewer` | string | Model ID for the review phase |
| `planDepth` | `"light"` \| `"deep"` | Planning depth recommendation |
| `codeDepth` | `"light"` \| `"medium"` \| `"deep"` | Coding depth recommendation |
| `reviewRecommended` | `"none"` \| `"static"` \| `"llm"` \| `"static+llm"` | Review mode recommendation (stored as `reviewMode` in state) |
| `routingMode` | string | How the route was determined (e.g. `"stage-aware"`, `"heuristic-fallback"`) |
| `neighborCount` | number | Number of similar eval records used for routing |
| `expectedSuccess` | number | Estimated success probability (0-1) |
| `expectedCost` | number | Estimated total cost in USD |
| `signals` | object | Prompt analysis signals (taskType, riskScore, etc.) |
| `challengeRecommendation` | object? | Optional challenge-mode recommendation |

### Consumers

| Consumer | File | Fields Used |
|----------|------|-------------|
| Phase 5 challenge planning | `wavemill-mill.sh` | coder, planner, reviewer, planDepth, codeDepth, reviewRecommended |
| Orchestrator (skip mode) | `wavemill-orchestrator.sh` | coder, planner, reviewer, planDepth, codeDepth, reviewRecommended, routingMode |
| Orchestrator (interactive) | `wavemill-orchestrator.sh` | Full route (runs router inline) |
| Monitor launch_task() | `wavemill-mill.sh` | Full route (re-routes or reads cached) |

### Fallback Chain

`read_route_json()` implements: `route.json` → `model-suggestion.json` → default value.

`model-suggestion.json` is a **deprecated** compatibility shim that only carries the `coder`
model (as `recommendedModel`). It will be removed in a future PR once all consumers have
been confirmed to work with `route.json`.

## See Also

- [Feature Workflow](feature-workflow.md) — guided single-issue execution with plan and validate gates
- [Plan Mode](plan-mode.md) — decompose epics into mill-ready sub-issues
- [Review Mode](review-mode.md) — LLM-powered code review (runs automatically in each agent's workflow)
- [Ready Stage](ready-stage.md) — merge-readiness checks and operator policy
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
