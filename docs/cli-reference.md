---
title: CLI Reference
---

This page lists the public Wavemill command surface and how each command fits into the overall workflow.

## Core Workflow

### `wavemill mill`

The default way to run Wavemill. Pulls backlog work, expands thin tasks, routes model selection, launches parallel agents, monitors PRs, and records learning data.

### `wavemill init`

Initializes `.wavemill-config.json` in the current repository and can also create `.wavemill/project-context.md`.

## Supporting Workflow Tools

### `wavemill expand`

Expands backlog issues into implementation-ready task packets. Useful when you want to prepare work ahead of mill mode.

```bash
wavemill expand
wavemill expand HOK-1494
wavemill expand https://linear.app/hokusai/issue/HOK-1494/fix-archived-routing-decision-parsing-for-eval-enrichment HOK-1531
```

### `wavemill plan`

Breaks large initiatives into smaller issues that are easier for `mill` to execute autonomously.

### `wavemill review`

Runs targeted LLM-powered review on a PR or shows review metrics.

### `wavemill ready`

Runs merge-readiness checks for a PR and reports whether it is safe to merge right now. In autonomous integration mode, this is the same policy surface `tend` uses for dependency, migration, risk, and challenge guards.

For direct development use:

```bash
wavemill ready <pr> --repo-dir <repo>
npx tsx tools/ready.ts <pr> --repo-dir <repo>
```

Flags:

- `--repo-dir <path>`: inspect a repository other than the current working directory

## Autonomous Integration

### `wavemill tend`

Runs one pass or a continuous loop over PRs targeting the integration branch.

```bash
wavemill tend --once --repo-dir <repo>
wavemill tend --loop --repo-dir <repo>
wavemill tend --once --dry-run --repo-dir <repo>
```

Flags:

- `--once`: run a single controller pass and exit
- `--loop`: run continuously inside the mill tmux session
- `--dry-run`: print queue status without mutating labels, branches, or PRs
- `--repo-dir <path>`: repository directory to inspect

Subcommands:

- `promote`: open or refresh the promotion PR from the integration branch to the promotion branch

### `wavemill observer`

Inspects currently running mill tmux sessions and reports Wavemill infrastructure problems before they silently block progress. It reads tmux panes, process trees, `.wavemill/workflow-state.json`, and recent mill logs.

```bash
wavemill observer --once
wavemill observer --loop --interval 120
wavemill observer --json
wavemill observer --file-linear --linear-team HOK
```

Flags:

- `--once`: run one observation pass and exit
- `--loop`: continue watching active sessions
- `--interval <seconds>`: delay between loop iterations
- `--json`: emit structured snapshots for a supervising Codex session
- `--repo-dir <path>` / `--session <name>`: scope observation to one active mill repository/session
- `--file-linear`: create Linear issues for high-confidence urgent/high findings using `LINEAR_API_KEY` from `.env` or the environment
- `--dry-run`: report what would be found without creating Linear issues
- `--print-prompt`: print the recommended long-running Codex supervisor prompt

When launched as the Backstage service, Observer runs in detection-only mode
with `WAVEMILL_OBSERVER_SERVICE=1`, `--json`, and `--dry-run`; Linear filing is
rejected in that mode.

The observer itself is conservative: it detects and reports stuck states, warnings, crashes, and visual pane/display issues. A supervising Codex session should decide whether to apply a narrow operational nudge, file a Linear issue, or make a Wavemill PR targeting `auto/integration`.

### `wavemill promote`

Direct entry point for promotion mode.

```bash
wavemill promote --repo-dir <repo>
wavemill promote --dry-run --repo-dir <repo>
```

Flags:

- `--dry-run`: print promotion status without mutating GitHub state
- `--repo-dir <path>`: repository directory to inspect

## Routing And Learning

### `wavemill route`

Shows the recommended planner, coder, and reviewer workflow for a task or task file.

### `wavemill eval`

Evaluates completed workflow runs and supports reporting, export, and aggregation.

### `wavemill hokusai`

Manages opt-in submission for collective routing intelligence.

Subcommands:

- `wavemill hokusai status`
- `wavemill hokusai enable`
- `wavemill hokusai disable`

## Project Memory

### `wavemill context`

Manages subsystem documentation that helps agents retain project-specific architectural context.

Subcommands:

- `wavemill context init`
- `wavemill context update <subsystem>`
- `wavemill context check`
- `wavemill context search <query>`

## Utility Commands

### `wavemill version`

Shows the installed Wavemill version.

### `wavemill help`

Shows the built-in help output.

## Choosing The Right Command

- Start with `wavemill init` once per repository.
- Use `wavemill mill` for the default operating model.
- Use `wavemill expand` when task packets need manual preparation.
- Use `wavemill plan` when epics are too large to mill directly.
- Use `wavemill review` or `wavemill eval` when you want targeted inspection.
- Use `wavemill tend` when you need to inspect or drive the `auto/integration` queue.
- Use `wavemill observer` when you want a long-running watchdog over active mill sessions.
- Use `wavemill promote` when you are ready to move `auto/integration` toward `main`.
- Use `wavemill route` or `wavemill hokusai` when you are tuning the learning system.

## See Also

- [Autonomous Integration](autonomous-integration.md) — branch protection, promotion cadence, and rollback guidance
- [Getting Started](getting-started.md) — first-time setup
- [Mill Mode](mill-mode.md) — core workflow
- [Routing & Hokusai](routing-and-hokusai.md) — self-improving routing
