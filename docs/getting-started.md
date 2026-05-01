---
title: Getting Started
---

Wavemill is designed to be run primarily through `wavemill mill`. The other commands help you prepare work, inspect results, or step in manually when needed.

## Prerequisites

- Node.js 18+
- npm
- `tmux`
- `jq`
- Linear API key (`LINEAR_API_KEY`)
- Optional: GitHub CLI (`gh`)

## 1) Install Wavemill

```bash
git clone https://github.com/timogilvie/wavemill/ wavemill
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

This creates a comprehensive `.wavemill-config.json` with all available sections:

- **linear**: Project name for backlog queries
- **mill**: Continuous execution settings (parallelism, agent, worktree root)
- **expand**: Batch expansion settings
- **plan**: Epic decomposition settings
- **eval**: LLM evaluation with judge model, pricing, and intervention penalties
- **autoEval**: Auto-run eval after workflow completion
- **review**: Self-review loop configuration
- **router**: Model routing based on historical eval data
- **validation**: Task packet validation layers
- **constraints**: Constraint rule validation
- **ui**: UI review and design verification settings
- **permissions**: Auto-approve patterns for agent tools

Edit `.wavemill-config.json` and set:

- Linear project name (required)
- Base branch (usually `main`)
- Parallelism and agent defaults as needed
- Enable/disable features like autoEval, router, review, etc.

## 4) Run Mill Mode

Start with the default workflow:

```bash
cd <your-project>
wavemill mill
```

What happens next:

- Wavemill reads the configured backlog
- expands thin tasks when needed
- routes work to the best available models
- launches parallel worktrees and agents
- evaluates outcomes so future routing improves

## 5) Optional: Enable Autonomous Integration

By default, Wavemill opens task PRs against `main` and you merge them yourself. If you want Wavemill to also handle merging — landing reviewed PRs onto a staging branch and opening a managed promotion PR to `main` — turn on autonomous integration.

This is opt-in because it requires a one-time branch setup and adds a `tend` loop to your mill session. See [Autonomous Integration](autonomous-integration.md) for the quickstart, complete config reference, branch protection guidance, high-risk policy, and rollback playbook.

## 6) Optional: Opt Into Hokusai

If you want routing to benefit from collective intelligence in addition to your own local history:

```bash
wavemill hokusai enable
```

Hokusai is optional. Wavemill still improves from your own repository data without it.

### Per-Developer Config Overrides

If you want a different config than the one committed in `.wavemill-config.json` — for example, to dogfood autonomous integration on a repo where the shipping default keeps it off — drop the overrides in `.wavemill-config.local.json` next to it. The local file is gitignored, deep-merged on top of the base at load time, and validated against the same schema.

```json
// .wavemill-config.local.json
{
  "integration": {
    "enabled": true,
    "readyPolicy": { "enabled": true }
  },
  "mill": {
    "baseBranch": "auto/integration"
  }
}
```

Merge rules: nested objects are recursively merged, arrays are replaced entirely (not concatenated), and primitive values from the local file win. The local file alone is also valid — if you have no committed config but a local one, it acts as the whole config.

### Config Versioning

The config includes a `configVersion` field to track format compatibility. When running `wavemill mill`, `expand`, or `plan`, you'll be prompted to upgrade if your config is outdated.

To manually upgrade:

```bash
npx tsx tools/sync-config.ts
```

To skip version checks:

```bash
SKIP_CONFIG_CHECK=true wavemill mill
```

## Next Steps

- For the default operating model: [Mill Mode](mill-mode.md)
- For the routing and learning loop: [Routing & Hokusai](routing-and-hokusai.md)
- For every available command: [CLI Reference](cli-reference.md)

## See Also

- [Mill Mode](mill-mode.md) — autonomous parallel backlog processing
- [Autonomous Integration](autonomous-integration.md) — auto-merge reviewed PRs into a staging branch before `main`
- [Routing & Hokusai](routing-and-hokusai.md) — how Wavemill gets better over time
- [CLI Reference](cli-reference.md) — full command surface
- [Plan Mode](plan-mode.md) — decompose epics into well-scoped sub-issues
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
