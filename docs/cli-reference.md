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

### `wavemill plan`

Breaks large initiatives into smaller issues that are easier for `mill` to execute autonomously.

### `wavemill review`

Runs targeted LLM-powered review on a PR or shows review metrics.

### `wavemill ready`

Runs merge-readiness checks for a PR and reports whether it is safe to merge right now.

## Integration Mode Tools

### `wavemill tend`

Runs the autonomous integration merge controller. The controller looks for `wm:ready` Wavemill PRs targeting the configured integration branch, selects one eligible PR, rebases it onto the integration branch, waits for checks, reruns readiness, and merges it.

Common options:

- `--once`: run one controller pass and exit
- `--loop`: run continuously, normally inside the mill tmux session
- `--dry-run`: print the queue status without merging or closing challenge losers
- `--repo-dir <path>`: operate on a repository other than the current directory

Examples:

```bash
wavemill tend --once --repo-dir .
wavemill tend --loop --repo-dir /path/to/repo
wavemill tend --once --dry-run
```

### `wavemill promote`

Opens or updates the promotion PR from `integration.integrationBranch` to `integration.promotionBranch`. Promotion reports the PR URL when available and prints the current check summary, but it does not auto-merge the promotion PR.

Use either command form:

```bash
wavemill promote --repo-dir .
wavemill tend promote --repo-dir .
```

Exit code is `0` when the promotion command completed, including cases where checks are pending or failing and the status is reported for the operator. Argument or runtime errors exit non-zero through the shared tool runner.

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

## Development Entry Points

These are documented because they are useful during development in addition to the public CLI.

### Ready Stage

The ready stage runs automatically inside `wavemill mill` between review and merge, and is also available as `wavemill ready <pr>`.

For direct development use:

```bash
npx tsx tools/ready.ts <pr>
```

## Choosing The Right Command

- Start with `wavemill init` once per repository.
- Use `wavemill mill` for the default operating model.
- Use `wavemill expand` when task packets need manual preparation.
- Use `wavemill plan` when epics are too large to mill directly.
- Use `wavemill review` or `wavemill eval` when you want targeted inspection.
- Use `wavemill route` or `wavemill hokusai` when you are tuning the learning system.

## See Also

- [Getting Started](getting-started.md) — first-time setup
- [Mill Mode](mill-mode.md) — core workflow
- [Routing & Hokusai](routing-and-hokusai.md) — self-improving routing
