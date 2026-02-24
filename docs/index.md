# Wavemill

Wavemill helps developer teams run Linear-driven software delivery with LLM agents and clear human checkpoints.

This site is for engineers who use Linear as the source of truth and Claude/Codex as implementation agents.

## Start Here

1. [Getting Started](getting-started.md)
2. [Feature Workflow (Plan -> Implement -> Validate -> PR)](feature-workflow.md)
3. [Autonomous Mode (`wavemill mill`)](mill-mode.md)
4. [Troubleshooting](troubleshooting.md)
5. [Deploy to `wavemill.org`](deploy.md)

## What Wavemill Handles

- Pulls prioritized tasks from Linear.
- Expands thin issues into implementation-ready packets.
- Runs parallel agent worktrees with conflict safeguards.
- Tracks PR and workflow progress with validation gates.

## Core Modes

### 1) Human-in-the-loop workflow

Use workflow commands to move one feature from backlog to PR with explicit review gates.

### 2) Autonomous mill mode

Use `wavemill mill` to continuously process backlog tasks in parallel.

## Quick Command Reference

```bash
# install + verify
./install.sh
wavemill help

# configure repo
wavemill init

# autonomous backlog loop
wavemill mill

# expand backlog issues into task packets
wavemill expand
```

For full setup, go to [Getting Started](getting-started.md).
