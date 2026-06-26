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

### Native Read-Only Opt-In

Use `.wavemill-config.json` for the shared `nativeAgent.enabled`, `nativeAgent.allowedPhases`, and provider model allow-list values that define whether a repo opts into native read-only expansion, planning, or review.

Keep native provider secrets such as `OPENAI_API_KEY` and `OPENROUTER_API_KEY` in environment variables only.

See [Native Read-Only Runtime](./native-read-only-runtime.md) for the exact config shape and phase examples.

### Native Patch Coding Alpha

Use `.wavemill-config.json` for the shared `nativeAgent.patchCoding` block when a repo wants to opt into native patch coding alpha:

```json
{
  "nativeAgent": {
    "patchCoding": {
      "enabled": true,
      "certificationPath": ".wavemill/native/patch-coding-certification.json"
    }
  }
}
```

- `enabled` defaults to `false`
- `certificationPath` is optional and points to the emitted certification record for smoke evidence and handoff tracking

This flag does not replace the model-level certification gate. A model must still carry `nativeCapability.patchCodingAlpha: "certified"` before coding routes to a native agent.

### Router Exploration Sampling

`router.exploration` converts deterministic argmax model selection (stage-aware
KNN routing and the Layer 3 policy resolver) into stochastic sampling so newer
or undersampled models keep receiving routing traffic:

```json
{
  "router": {
    "exploration": {
      "enabled": true,
      "mode": "epsilon",
      "rate": 0.15,
      "temperature": 0.7,
      "topK": 3,
      "ucbConstant": 0.05,
      "priors": {
        "enabled": true,
        "blendSamples": 10
      }
    }
  }
}
```

- `enabled` (default `false`): when off, sampling is byte-identical to argmax.
- `mode`: `epsilon` picks a non-argmax candidate from the top-K window with
  probability `rate`; `softmax` samples the top-K window weighted by
  `exp(score / temperature)`.
- `topK`: candidates eligible for sampling per stage (minimum 2, default 3).
- `ucbConstant` (default `0` = off): adds a UCB-style uncertainty bonus
  `c * sqrt(ln(totalObservations + 1) / max(support, 1))` to each candidate's
  ranking key, so undersampled models get a temporary boost that decays as
  eval records accumulate. The bonus affects selection order only — reported
  expected success stays bonus-free.
- `priors` (default disabled): seeds every eligible stage model into the
  stage-aware candidate set even with zero eval records, scored by its
  registry quality prior. Empirical KNN scores blend in as evidence
  accumulates: weight `min(support / blendSamples, 1)` — zero records means
  pure prior, `blendSamples` records means pure empirical. This is how a
  brand-new registry model (e.g. a freshly released frontier model) becomes
  routable before any challenge runs produce eval data for it.
- `newModelBoost` (default off, `multiplier: 1`): models whose registry
  `releasedAt` falls within `windowDays` (default 45) get their exploration
  sampling weight multiplied by `multiplier`, decaying linearly to 1.0 at the
  window edge — a temporary thumb on the scale while a new model accumulates
  data, never a permanent one. The same window also makes the challenge
  scheduler prioritize recently released under-covered models over older
  deliberately-unused ones. Set `releasedAt` per model in the registry
  defaults or via `modelRegistry.models.<id>.releasedAt` config overrides.
  Boosted picks are marked `[recency-boosted]` in decision reasoning.

Sampling, the UCB bonus, and prior seeding all operate inside the
already-filtered candidate set (allowlists, capability constraints, disabled
models, DeepSeek opt-in), and a sampled stage-aware combination that would
exceed `maxCostUsd` reverts to the exploit selection. Decisions record
explore-vs-exploit attribution in `reasoning` and an `exploration` field that
is persisted to route artifacts. Zero-record candidates get cost estimates
from the pricing table instead of reporting zero cost.

### Router Coverage Targets and Diversity Report

`router.coverage` configures the diversity report
(`npx tsx tools/router-diversity-report.ts`):

```json
{
  "router": {
    "coverage": {
      "minRecordsPerModelStage": 15,
      "maxStageShare": 0.7,
      "window": 50
    }
  }
}
```

- `minRecordsPerModelStage`: eval records each model should accumulate per
  workflow stage; cells below the target are starred in the report.
- `maxStageShare`: dominance threshold — the report warns when one model
  exceeds this share of any stage over the window.
- `window`: most recent eval records used for stage-share and routing-mode
  breakdowns (coverage counts are cumulative).

The challenge scheduler also consumes per-model-per-stage counts: `new-model`
recommendations target the least-covered (model, stage) cell, and
`low-data-stage` recommendations pick the least-tested model for the starved
stage specifically.

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
