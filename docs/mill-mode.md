# Mill Mode (`wavemill mill`)

Use `wavemill mill` when you want continuous, autonomous execution of backlog tasks with parallel agents.

## What It Does

- Fetches and ranks backlog tasks from Linear.
- Expands issues that are missing implementation detail.
- Launches parallel worktrees/agents via `tmux`.
- Monitors PR and merge status.
- Cleans up completed tasks and updates issue state.

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
