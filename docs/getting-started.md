---
title: Getting Started
---

## Prerequisites

- Node.js 18+
- npm
- `tmux`
- `jq`
- Linear API key (`LINEAR_API_KEY`)
- Optional: GitHub CLI (`gh`)

## 1) Install Wavemill

```bash
git clone <repo-url> wavemill
cd wavemill
./install.sh
wavemill help
```

## 2) Configure Linear Access

```bash
export LINEAR_API_KEY="your-key-here"
```

Add that export to your shell profile for persistence.

## 3) Initialize Repo Config

In the target project repo:

```bash
wavemill init
```

Edit `.wavemill-config.json` and set:

- Linear project name
- Base branch (usually `main`)
- Parallelism and agent defaults as needed

## 4) Optional: Enable Claude/Codex Command Sync

```bash
./sync-claude.sh links
```

This links:

- `~/.claude/commands` -> repo `commands/`
- `~/.codex/prompts` -> repo `codex/prompts/`

Then restart Claude/Codex clients.

## Next Steps

- For guided feature execution: [Feature Workflow](feature-workflow.md)
- For autonomous backlog processing: [Mill Mode](mill-mode.md)
