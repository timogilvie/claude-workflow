---
title: Wavemill
---

**Wavemill** is a self-improving AI software development pipeline. It offers a CLI tool for autonomous AI-powered software development workflows to automatically process backlogs, expand issues, and ship features in parallel. It works across multiple models and includes eval functionality to understand which models are most effective at each type of task, routing tasks to the right model automatically.

```
Linear Backlog → Expand → Route → Build (parallel) → Eval → Learn
                                      ↑                       |
                                      └── routing improves ───┘
```

### How it works

1. **`wavemill expand`** — enriches Linear issues into detailed task packets with context, constraints, and validation steps
2. **`wavemill mill`** — continuously pulls from your backlog, launches parallel AI agents in tmux worktrees, monitors PRs, and auto-completes tasks
3. **Eval** — scores every completed task on a 0–1 scale measuring autonomy and quality
4. **Router** — uses eval history to pick the best model for each task type
5. **Challenge mode** — periodically runs the same task with two models head-to-head, building the dataset that makes routing smarter over time

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

For agent instruction ownership and prompt update points, see [Prompt Locations](prompt-locations.md).

Wavemill is open source under the [MIT License](https://github.com/timogilvie/wavemill/blob/main/LICENSE).
