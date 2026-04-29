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

### `tools/state.ts`

Locked JSON state-file operations for safe concurrent access. Used internally by shell scripts to replace `jq > tmp && mv` patterns with atomic, lock-protected mutations.

Subcommands:

- `get <file> <jq-expr>` — Read value at JSON path (no lock)
- `set <file> [--arg k v]... [--argjson k v]... -- <jq-expr>` — Run jq expression with locking
- `merge <file> <json-obj>` — Shallow merge JSON object (locked)
- `delete <file> <jq-path>` — Delete key at path (locked)
- `init <file> <json-default>` — Create file with default if missing (locked)

Exit codes:

- 0: Success
- 2: Lock timeout (contention)
- 3: Invalid input
- 4: File/IO error

Example:

```bash
npx tsx tools/state.ts set /tmp/state.json --arg issue "HOK-123" \
  -- '.tasks[$issue].status = "done" | .updated = (now | todate)'
```

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
- Use `wavemill promote` when you are ready to move `auto/integration` toward `main`.
- Use `wavemill route` or `wavemill hokusai` when you are tuning the learning system.

## See Also

- [Autonomous Integration](autonomous-integration.md) — branch protection, promotion cadence, and rollback guidance
- [Getting Started](getting-started.md) — first-time setup
- [Mill Mode](mill-mode.md) — core workflow
- [Routing & Hokusai](routing-and-hokusai.md) — self-improving routing
