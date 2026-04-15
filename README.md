# Wavemill

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

## Requirements

- **Node.js** >= 18
- **npm**
- **Linear API key** (`LINEAR_API_KEY` env var)
- **tmux** (for `wavemill mill`: `brew install tmux`)
- **jq** (for JSON processing: `brew install jq`)
- Optional: **GitHub CLI** (`gh`) for PR automation

## Quick Start

### Install Wavemill CLI

```bash
git clone <this repo> && cd wavemill
./install.sh
```

This makes `wavemill` globally accessible. Test with:
```bash
wavemill help
```

### Configure for your project

1. **Set Linear API key:**
```bash
export LINEAR_API_KEY="your-key-here"
# Add to ~/.zshrc or ~/.bashrc for persistence
```

2. **Initialize config in your repo:**
```bash
cd ~/your-repo
wavemill init
# Edit .wavemill-config.json:
#   - Set linear.project (required)
#   - Configure features: eval, review, router, permissions, etc.
#   - Adjust defaults as needed
```

The comprehensive config includes all features with sensible defaults. The config version is automatically checked when running workflows.

### Run Wavemill

```bash
# Start continuous autonomous loop
wavemill mill

# Or expand issues interactively
wavemill expand
```

### Configuration

Settings are loaded in layers (later wins):
1. Hardcoded defaults
2. `~/.wavemill/config.json` (user-level, shared across repos)
3. `.wavemill-config.json` (per-repo, in project root)
4. Environment variables (always override)

See `wavemill-config.schema.json` for the full schema.

### Permissions

Auto-approve read-only commands in worktrees to reduce friction during autonomous workflows. See [docs/permissions.md](docs/permissions.md) for setup.

## Wavemill Commands

### Ready Stage - Merge Readiness Checks

The ready stage validates whether a reviewed PR is safe to merge right now, covering the phase boundary between review and merge. Use `wavemill ready <pr>` for manual checks; `wavemill mill` runs the `ready` phase by default before treating a PR as merge-safe. Set `ready.enabled: false` only for repositories that intentionally skip this gate. See [docs/ready-stage.md](docs/ready-stage.md) for CLI details, monitor behavior, merge policy, and recovery paths.

### `wavemill mill` - Continuous Task Execution

Fully autonomous task execution system that continuously processes your Linear backlog.

**What it does:**
1. Fetches prioritized tasks from Linear backlog (auto-detects project from `.wavemill-config.json`)
2. Ranks tasks using intelligent priority scoring (considers: Linear priority, task packet completeness, foundational work, dependencies, estimates)
3. Auto-expands issues without detailed descriptions (using Claude + issue-writer prompt)
4. Launches parallel agent workers in tmux windows (default: 7 concurrent tasks)
5. Monitors PR creation and merge status
6. Auto-cleans completed tasks (closes tmux windows, removes worktrees, updates Linear to "Done")
7. Prompts for next batch with 10s auto-continue

**Usage:**
```bash
cd ~/my-repo
wavemill mill

# With custom settings:
MAX_PARALLEL=5 wavemill mill
```

**Controls:**
- `Ctrl+B D` - Detach from tmux (loop continues in background)
- `touch ~/.wavemill/.stop-loop` - Stop loop after current cycle
- `Ctrl+C` - Interrupt and reset in-progress tasks to Backlog

**Features:**
- **Conflict avoidance** - Won't run multiple tasks on same area/component
- **Migration conflict prevention** - Pre-assigns migration numbers to parallel tasks
- **Validation gates** - Checks CI status and merge target before marking tasks "Done"
- **State persistence** - Tracks all work in `.wavemill/workflow-state.json`
- **Project context learning** - Automatically maintains `.wavemill/project-context.md` with architectural decisions, patterns, and lessons learned from each completed task

**Environment variables:**
- `MAX_PARALLEL` - Number of parallel tasks (default: 7)
- `SESSION` - Tmux session name (default: wavemill)
- `AGENT_CMD` - Agent to use (default: claude, can be: codex)
- `WORKTREE_ROOT` - Worktree location (default: ../worktrees)
- `BASE_BRANCH` - Base branch (default: main)
- `POLL_SECONDS` - PR polling interval (default: 10)
- `DRY_RUN` - Dry run mode (default: false)
- `REQUIRE_CONFIRM` - Require confirmations (default: true)

### `wavemill expand` - Batch Expand Linear Issues

Interactively expand multiple Linear issues with detailed task packets.

**What it does:**
1. Fetches Linear backlog (auto-detects project from repo)
2. Filters to issues WITHOUT detailed task packets
3. Ranks by priority score (same algorithm as wavemill mill)
4. Shows up to 9 candidates
5. Lets you select up to 3 issues
6. Expands each with Claude using issue-writer prompt
7. Extracts and applies suggested labels
8. Updates both description and labels in Linear

**Usage:**
```bash
cd ~/my-repo
wavemill expand

# With custom project:
LINEAR_PROJECT="My Project" wavemill expand
```

**Environment variables:**
- `LINEAR_PROJECT` - Explicit Linear project override
- `PROJECT_NAME` - Legacy project override, only used when no repo project is configured
- `MAX_SELECT` - Max issues to select (default: 3)
- `MAX_DISPLAY` - Max issues to display (default: 9)

**Output example:**
```
Issues needing expansion (ranked by priority, showing up to 9):

1. HOK-219 - Build Registration Dashboard (score: 85)
2. HOK-217 - Add Usage Credits System (score: 75)
3. HOK-216 - Create Welcome Email (score: 70)

Enter up to 3 numbers to expand (e.g. 1 3 5), or press Enter to skip:
> 1 2 3

Processing HOK-219...
  ✓ Expanded and updated in Linear
  → Adding labels...
    ✓ Added: Risk: Medium
    ✓ Added: Layer: UI
    ✓ Added: Area: Dashboard
```

### `wavemill context` - Subsystem Documentation Lifecycle

Manage subsystem documentation for AI agent consumption. Implements a three-tier memory system:
- **Hot memory**: `project-context.md` (always loaded)
- **Cold memory**: `.wavemill/context/{subsystem}.md` (loaded on-demand)
- **Agent memory**: Session-specific context

**Subcommands:**

1. **`wavemill context init`** - Bootstrap subsystem specs from codebase analysis
2. **`wavemill context update <subsystem>`** - Refresh a specific subsystem spec
3. **`wavemill context check`** - Drift detection (stale/orphaned/undocumented subsystems)
4. **`wavemill context search <query>`** - Keyword search across specs

**Examples:**
```bash
# Initialize subsystem documentation
wavemill context init

# Check for stale documentation
wavemill context check

# Update a specific subsystem
wavemill context update linear-api

# Search for "error handling"
wavemill context search "error handling"
```

**How it works:**
- Detects subsystems from directory structure, file patterns, and git analysis
- Generates structured markdown specs with tables and architectural constraints
- Auto-updates specs after PR merges (when using `wavemill mill`)
- Keyword search returns ranked results with relevant snippets

**Spec format:** Each subsystem spec includes:
- Purpose and key files
- Architectural constraints (DO/DON'T)
- Known failure modes
- Testing patterns
- Dependencies
- Recent changes

See [CLAUDE.md](CLAUDE.md) for detailed documentation on subsystem specs and the context system.

## Eval

Every completed task is automatically scored by an LLM judge on a 0–1 scale:

| Band | Score | Meaning |
|------|-------|---------|
| Full Success | 1.0 | Merged autonomously, no human intervention |
| Minor Feedback | 0.8–0.9 | Needed small review comments |
| Assisted Success | 0.5–0.7 | Required meaningful human guidance |
| Partial | 0.2–0.4 | Significant rework needed |
| Failure | 0.0–0.1 | Did not produce a usable result |

The eval gathers PR diffs, CI results, review comments, and detects interventions (manual commits, force pushes, multiple review rounds). Records are stored in `.wavemill/evals/evals.jsonl` and feed directly into routing. In `stage-aware` mode, fresh local evals are merged with aggregated/backfilled history so the next similar task can benefit immediately, while historical artifacts still cover cold starts.

```bash
# Eval is automatic in mill mode. To run manually:
wavemill eval
```

See [docs/eval-mode.md](docs/eval-mode.md) for details.

## Model Routing

The router picks the best model for each task based on historical eval performance. It classifies tasks by type (bugfix, feature, refactor, etc.), analyzes complexity, and checks which models perform best on similar work.

**Routing modes:**
- **heuristic** — regex-based task classification + historical averages
- **llm** — DSPy-optimized model selection with few-shot examples
- **stage-aware** — nearest-neighbor routing over live local evals plus aggregated/backfilled history
- **auto** (default) — tries LLM routing, falls back to heuristic

Configure in `.wavemill-config.json`:
```json
{
  "router": {
    "enabled": true,
    "mode": "auto",
    "models": ["claude-sonnet-4-6", "claude-opus-4-6", "o3"],
    "defaultModel": "claude-sonnet-4-6"
  }
}
```

## Challenge Mode

Challenge mode runs the same task with two different models in parallel to generate head-to-head comparison data. This builds the dataset that makes routing increasingly accurate.

On each mill cycle, a configurable percentage of tasks (default: 10%) are selected for challenge. The router picks a primary model and a random challenger. Both produce independent PRs, both get eval'd, and a comparison record captures which model won and why.

```json
{
  "challenge": {
    "enabled": true,
    "rate": 0.10,
    "autoMergeWinner": false
  }
}
```

This is the self-improving loop: challenge generates comparison data → eval scores both → router learns which models excel at which task types → future tasks get better model assignments.

## Under the Hood

### Wavemill Architecture

The `wavemill` CLI is a thin wrapper around these core scripts:

- **`wavemill-mill.sh`** - Main loop implementation
- **`wavemill-orchestrator.sh`** - Parallel task launcher (tmux)
- **`wavemill-expand.sh`** - Issue expansion implementation
- **`wavemill-common.sh`** - Shared utilities (DRY)

**Shared functions in wavemill-common.sh:**
- `detect_project_name()` - Auto-detect Linear project from `.wavemill-config.json`
- `is_task_packet()` - Check if issue has detailed description
- `score_and_rank_issues()` - Priority scoring algorithm
- `expand_issue_with_tool()` - Expand issues using expand-issue.ts
- `write_task_packet()` - Backwards-compatible wrapper
- `extract_labels_from_description()` - Parse labels from expanded issues

## Repo Layout

```
wavemill/
├── wavemill                    # Main CLI entry point
├── install.sh                  # Installation script
├── shared/lib/                 # Core autonomous workflow scripts
│   ├── wavemill-mill.sh       # Continuous task execution loop
│   ├── wavemill-orchestrator.sh # Parallel task launcher (tmux)
│   ├── wavemill-expand.sh     # Batch issue expansion tool
│   ├── wavemill-common.sh     # Shared functions (DRY)
│   └── linear.js              # Linear API client
├── tools/                      # TypeScript wrappers for Linear API
│   ├── expand-issue.ts        # Expand single issue with Claude CLI
│   ├── add-issue-label.ts     # Add labels to Linear issues
│   ├── list-backlog-json.ts   # Fetch backlog as JSON
│   └── get-issue.ts           # Fetch single issue (use --json for JSON output)
├── commands/                   # Claude slash commands (symlinked)
└── codex/                      # Codex commands and prompts
```

## Documentation

- [Getting started](docs/getting-started.md)
- [Feature workflow](docs/feature-workflow.md)
- [Autonomous mode (mill)](docs/mill-mode.md)
- [Eval system](docs/eval-mode.md)
- [Permissions](docs/permissions.md)

## Troubleshooting

- Linear errors: confirm `LINEAR_API_KEY` is exported and the project name in config exists.
