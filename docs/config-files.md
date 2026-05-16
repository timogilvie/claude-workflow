# Config Files Guide

This guide explains which Wavemill settings belong in `.wavemill-config.json`, which belong in `.wavemill-config.local.json`, and when you should prefer environment variables instead.

## Ownership and Precedence

### `.wavemill-config.json`

- Committed to the repo
- Holds repo-wide defaults the team intends to share
- Is the only file written by `npx tsx tools/sync-config.ts`

### `.wavemill-config.local.json`

- Gitignored developer overlay next to `.wavemill-config.json`
- Read at runtime and deep-merged on top of `.wavemill-config.json`
- Never modified by `sync-config`

### Environment variables and CLI flags

- Best for secrets, CI-only values, and one-off overrides
- Take precedence where the command path explicitly supports them
- Should be preferred over config files for provider credentials and tokens

## Runtime Behavior

TypeScript config loading reads `.wavemill-config.json` first and then deep-merges `.wavemill-config.local.json` on top of it. Nested objects merge recursively, arrays are replaced entirely, and primitive values from the local file win.

When command-specific environment variables or CLI flags exist, those may layer above config values. This varies by command path, so treat config files as the shared baseline and use env vars or flags for transient overrides.

## Recommended Placement

| Setting type | Recommended location | Examples |
| --- | --- | --- |
| Repo-wide defaults | `.wavemill-config.json` | shared branch names, permission patterns, review defaults, routing defaults intended for the whole repo |
| Developer overrides | `.wavemill-config.local.json` | personal model choices, local worktree roots, local branch experiments, personal Hokusai consent preferences when not a team default |
| Secrets and ephemeral overrides | Environment variables or CLI flags | API tokens, provider credentials, CI-only settings, temporary experiments |

## Guidance for Model and Router Defaults

Put model or router settings in `.wavemill-config.json` only when they are meant to be the repo-wide default. If a model choice is personal, experimental, or specific to one developer's machine, keep it in `.wavemill-config.local.json`.

Examples:

- Shared default planner or router settings for the repo: `.wavemill-config.json`
- A developer trying `gpt-5.5` locally before the team adopts it: `.wavemill-config.local.json`
- Provider API keys or tokens for those models: environment variables

## `sync-config` Behavior

`sync-config` upgrades and writes `.wavemill-config.json` only. It does not edit `.wavemill-config.local.json`.

When `.wavemill-config.local.json` exists, run `npx tsx tools/sync-config.ts --dry-run` to see how local-only or conflicting fields are classified:

- `will add to repo default`: the field exists only in `.wavemill-config.local.json`, is part of Wavemill's canonical config template, and would be a candidate to copy into `.wavemill-config.json`
- `already local-only`: the field does not need to be synced — either it exists only in `.wavemill-config.local.json` and is not a canonical field, or it exists in both files with the same value (redundant override)
- `requires decision`: the field looks sensitive, machine-local, or intentionally overridden relative to `.wavemill-config.json`

This dry-run output is there to prevent accidental promotion of secrets, local paths, or personal-only settings into the committed repo config.
