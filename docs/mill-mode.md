---
title: Mill Mode
---

Use `wavemill mill` when you want continuous execution of backlog tasks with parallel agents.

## What It Does

- Fetches and ranks backlog tasks from Linear and prompts you for what's next.
- Expands issues that are missing implementation detail into effective plans.
- Assesses the task and chooses the best model
- Launches parallel worktrees/agents via `tmux`.
- Monitors PR and merge status.
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
- validation before marking tasks done
- persistent workflow state in `.wavemill/workflow-state.json`

## Operator Controls

- `Ctrl+B D` detach from `tmux`
- `touch ~/.wavemill/.stop-loop` stop after current cycle
- `Ctrl+C` interrupt and reset in-progress tasks

## When to Prefer Mill Mode

Use mill mode when your backlog has many independent tasks and your team is comfortable reviewing multiple agent-generated PRs in parallel.

## Project Context Integration

Mill mode automatically maintains a `.wavemill/project-context.md` file that helps agents learn from previous work:

**First-time setup:**
```bash
npx tsx tools/init-project-context.ts
```

After initialization, the file is **automatically updated** after each PR merge with:
- What changed in the implementation
- New patterns or conventions established
- Known gotchas or constraints discovered

This ensures that agent #5 knows what agents #1-4 built, leading to more consistent implementations and fewer repeated mistakes.

**Manual maintenance:**
- The "Recent Work" section is auto-updated (append-only)
- Other sections (Architecture, Conventions) can be manually edited
- Agents receive this context when expanding Linear issues
