---
title: Config Files
---

## Overview

Wavemill configuration has two file layers plus environment variables:

- `.wavemill-config.json`: shared repository defaults, usually committed.
- `.wavemill-config.local.json`: developer-specific overrides, should stay gitignored.
- Environment variables: best for secrets and ephemeral environment-specific overrides.

`sync-config` writes `.wavemill-config.json` only. It never modifies `.wavemill-config.local.json`.

## Precedence at Runtime

At runtime, Wavemill loads config in this order:

1. `.wavemill-config.json` (base)
2. `.wavemill-config.local.json` (deep-merged override when present)
3. Environment variables (where a code path supports env overrides)

Merge behavior for local overrides:

- Nested objects are deep-merged.
- Arrays replace the base array.
- Primitive values in local override win.

### Cross-PR Revert Checker

`tools/check-cross-pr-reverts.ts` resolves the integration branch in this order:

1. `--integration-ref <ref>` when the CLI argument is non-empty.
2. `.wavemill-config.json` / `.wavemill-config.local.json` `integration.integrationBranch`.
3. Default `auto/integration`.

If the resolved integration ref does not exist in the repo, the checker skips gracefully instead of blocking ready on a config lookup failure.

## Recommended Placement by Category

Use `.wavemill-config.json` for:

- Team-wide defaults that should be consistent for everyone.
- Shared relative repo paths that apply across developers.
- Canonical router/model defaults when the whole repo should use them.

Use `.wavemill-config.local.json` for:

- Personal model experiments and temporary model preferences.
- Developer-specific challenge rate or local routing preferences.
- Consent/data-submission preferences when they are personal opt-in choices.
- Machine-specific values that should not be committed.

Use environment variables for:

- API keys, credentials, and tokens.
- CI-specific runtime values.
- Temporary shell-session overrides.

Never store secrets in either config file when an environment variable or secret manager is available.

## Model and Router Defaults

When new model/router config fields are added in future versions:

- Put them in `.wavemill-config.json` when the repository should share the same default behavior.
- Keep personal model trials and developer-specific provider preferences in `.wavemill-config.local.json`.
- Keep provider credentials in environment variables, not config files.

## Local Paths Guidance

- Relative paths shared by the team can live in `.wavemill-config.json`.
- Absolute machine paths (for example `/Users/...` or `C:\\Users\\...`) should stay local-only or env-backed.

## Ready Stage Settings

`ready.watchdog` controls how mill reacts to stale or failing ready states:

- `thresholdMinutes`: stale-local-state threshold before the watchdog intervenes.
- `autoRecover`: allows local stale-state cleanup when GitHub is clean and green.
- `timeoutSeconds`: watchdog subprocess timeout per monitor tick.
- `stableFailureConsecutivePolls`: identical safe failures required before queueing remediation.
- `stableFailureEscalateAfterPolls`: identical unsafe failures required before escalating to operator attention.
- `safeRemediationCategories`: allowlist for watchdog-driven remediation, defaulting to `lint`, `type`, `test`, `build`, `migration-chain`, and `alembic`.

`ready.migrationChecks` controls automatic migration validation:

- `enabled`: master switch for automatic migration integrity checks.
- `autoDetectAlembic`: auto-enables `migration-chain-integrity` when `alembic/versions/` exists and `ready.checks` is otherwise empty.
- `baseRefresh.enabled`: fetches the PR base branch before local migration validation.
- `baseRefresh.timeoutSeconds`: timeout for that fetch.

These settings are additive and optional. Repositories that do nothing keep the defaults.

## How sync-config Interacts with Config Files

`npx tsx tools/sync-config.ts` syncs canonical fields into `.wavemill-config.json`.

- It may add missing canonical fields with canonical default values.
- It does not copy values from `.wavemill-config.local.json` into shared config.
- In `--dry-run`, it reports local-only missing fields to help you decide if a shared default should be added manually.
- If a local-only missing path appears secret-like or host-specific and overlaps a pending canonical addition, write mode aborts so you can make an explicit decision.
