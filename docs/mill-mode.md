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

## See Also

- [Feature Workflow](feature-workflow.md) — guided single-issue execution with plan and validate gates
- [Plan Mode](plan-mode.md) — decompose epics into mill-ready sub-issues
- [Review Mode](review-mode.md) — LLM-powered code review (runs automatically in each agent's workflow)
- [Troubleshooting](troubleshooting.md) — common issues and fixes
