---
title: Plan Mode
---

Use plan mode to decompose a broad epic or initiative into well-scoped sub-issues and push them to Linear with dependencies and milestones.

## What It Does

1. Selects an epic from your Linear backlog.
2. Optionally researches comparable products and patterns.
3. Decomposes the epic into 3–10 independently executable sub-issues.
4. Creates a milestone and all sub-issues in Linear with priority, estimates, and dependency links.

## Run It

```bash
# interactive epic selection + decomposition
wavemill plan

# or use the tool directly
npx tsx tools/plan-initiative.ts list        # rank initiatives by size
npx tsx tools/plan-initiative.ts decompose   # decompose + create issues
```

## Workflow Phases

### 1) Epic Selection

Pick an initiative or large issue from your Linear backlog. Context is saved to `epics/<epic-name>/selected-task.json`.

### 2) Research (optional)

Pass `--research` to have Claude study 2–3 comparable products and extract patterns and anti-patterns before planning. Output goes to `epics/<epic-name>/research-summary.md`.

### 3) Decomposition

Claude breaks the epic into sub-issues organized by milestone:

- **Proof of Concept** — validate core assumptions
- **MVP** — minimum shippable feature set
- **V1 Launch** — polish, edge cases, observability
- **Long-term** — extensions, optimizations

Each sub-issue includes a title, user story, description, priority (P0–P3), and dependency references.

### 4) Linear Issue Creation

The decomposition plan is pushed to Linear:

- A milestone is created (or matched to an existing one).
- Sub-issues are created with enhanced descriptions that reference the parent epic and relevant files.
- Dependency relations (`blocks`) are created between issues so the backlog reflects execution order.

## Key Files

| File | Purpose |
|------|---------|
| `tools/plan-workflow.ts` | Epic selection and issue creation orchestrator |
| `tools/plan-initiative.ts` | List and decompose initiatives |
| `tools/prompts/initiative-planner.md` | System prompt for decomposition |
| `tools/prompts/research-phase.md` | Research phase prompt template |
| `shared/lib/linear.js` | Linear API helpers (create issues, milestones, relations) |

## See Also

- [Feature Workflow](feature-workflow.md) — guided single-issue execution with plan → implement → validate gates
- [Labels](LABEL-SYSTEM.md) — how labels control parallel task scheduling
