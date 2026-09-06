# PR Attribution Contract

## Overview

The PR attribution system determines three independent dimensions for each pull request:

1. **agentAuthored** — Was this PR produced by an agent?
   - Values: `agent` | `unknown` (never `human`)
   - Never conflicts: all signals saying an agent touched the code collapse to `agent`

2. **harness** — Which agent product/harness produced it?
   - Values: harness identity | `unknown`
   - Examples: `github-copilot`, `claude-code`, `openai-codex`, `cursor`, `aider`, etc.

3. **model** — Exact model identity
   - Values: canonical model ID | `unknown`
   - Examples: `claude-opus-5`, `claude-fable-5-1`, `claude-sonnet-5`

Each dimension includes:
- **value**: the attribution result
- **confidence**: `verified` | `strong` | `weak` (null if value is `unknown`)
- **conflict**: boolean indicating same-tier disagreement
- **evidence**: array of all contributing signals, kept even when collapsed to `unknown`

## Attribution Signals

Signals are evaluated in this precedence order (verified > strong > weak):

| Signal | agentAuthored | harness | model | Confidence | Precedence |
|--------|--------------|---------|-------|------------|-----------|
| `firstPartyRoute` | `agent` | wavemill adapter | executed coder model | `verified` | 1 |
| `botAuthor` | `agent` | bot-login mapping | — | `strong` | 2 |
| `commitSignature` | `agent` | signature mapping | — | `strong` | 3 |
| `coAuthoredBy` | `agent` | trailer fragment mapping | exact trailer → model | `strong` | 4 |
| `branchPrefix` | `agent` | prefix mapping | — | `weak` | 5 |
| `label` | `agent` | label mapping | — | `weak` | 6 |

### Within-tier precedence

When multiple signals at the same confidence tier fire:

- `botAuthor` > `commitSignature` > `coAuthoredBy` > `branchPrefix` > `label`

If two *distinct* values tie at the highest tier, the dimension collapses to `unknown` with `conflict: true`.

## First-Party Route Data (Phase 3)

The `firstPartyRoute` signal comes from wavemill metadata in the PR body:

```html
<!-- wavemill-meta
route_schema: 1
executed_route: {"planner":{...},"coder":{...},"reviewer":{...}}
-->
```

**Extraction rules:**

- **Lenient scan** of `wavemill-meta` block; strict validation of `executed_route` JSON
- **Payload structure**: per-role entries with required `model`, `adapter`, `status`
- **Valid status values**: `executed` | `inherited` | `not_run` | `unknown`
- **Only `executed` status with fresh head SHA** contributes attribution
- **Head SHA freshness**: if role's `headSha` doesn't match PR head SHA → treated as stale
- **Model dimension**: uses **executed coder role's model** (the merged artifact producer)
- **Planner/reviewer identities**: included in evidence, not attributed as models

**When first-party route is absent or invalid:**
- Fallback to heuristic signals
- No error; extraction is silent and graceful

**Coordination note for HOK-2945:** This extractor assumes the contract in that issue's packet. If field names/shape change, update the extraction logic here (single place). The lenient block scan + strict payload validation allows both schemas to evolve independently.

## Configuration

Attribution is configurable per repository via an optional JSON config file:

```json
{
  "defaults": {
    "minEligiblePrs": 20,
    "modelCoverageFloor": 60,
    "harnessCoverageFloor": 60,
    "disabledSignals": []
  },
  "repos": {
    "owner/repo": {
      "minEligiblePrs": 15,
      "modelCoverageFloor": 50
    }
  }
}
```

**Fields:**
- `minEligiblePrs` (default: 20) — minimum sampled PRs for a repo to count as eligible
- `modelCoverageFloor` (default: 60, percent) — threshold for rendering survival-by-model section
- `harnessCoverageFloor` (default: 60, percent) — threshold for rendering survival-by-harness section
- `disabledSignals` (default: []) — array of signals to skip during analysis

**Floor comparison:** uses exact ratios `(attributed / total) * 100 >= floor`, never rounded display percentages.

## Coverage Metrics

Per repository:

- **Per-signal coverage** — count and % of PRs with each signal
- **Per-dimension coverage** — count and % of PRs with non-`unknown` value for agentAuthored, harness, model
- **Union coverage** — % of PRs with at least one signal
- **agentOrHarness union** — % of PRs with agentAuthored OR harness attributed (drives feasibility gate)

Aggregates across repositories:

- **Micro** — pooled over all sampled PRs
- **Macro** — unweighted mean of eligible repos' coverages
- **Feasibility gate** — count of eligible repos clearing ≥60% agentOrHarness coverage
- **Precision** (optional) — audited-and-confirmed / audited for each dimension; explicit `audited: false` if no audit file

## Section Gating

**Eligibility:** repo must have ≥ `minEligiblePrs` sampled merged PRs.

**Section gates** (independent per repo):

- `survivalByModel` renders iff:
  - Repo is eligible, AND
  - Model coverage ratio ≥ `modelCoverageFloor`
  
- `survivalByHarness` renders iff:
  - Repo is eligible, AND
  - Harness coverage ratio ≥ `harnessCoverageFloor`

Each gate includes a reason string (e.g., `floor_met`, `below_min_prs_20`, `floor_not_met_60%`) for auditability.

**Ineligible repos** are still fully scored and listed in the report; they simply don't contribute to macro coverage or the feasibility gate count.

## Report Schema (v2)

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-09-06T12:34:56.789Z",
  "sampleLimit": 50,
  "detectorSignatures": {...},
  "config": { "owner/repo": {...} },
  "repositories": [
    {
      "repo": "owner/repo",
      "sampledMergedPrs": 50,
      "signalCounts": { "firstPartyRoute": 0, "botAuthor": 10, ... },
      "coverage": { "firstPartyRoute": 0, "botAuthor": 20, ..., "union": 50, "unattributed": 20 },
      "dimensionCoverage": {
        "agentAuthored": { "total": 50, "attributed": 40, "coverage": 80.0 },
        "harness": { "total": 50, "attributed": 30, "coverage": 60.0 },
        "model": { "total": 50, "attributed": 10, "coverage": 20.0 },
        "agentOrHarness": { "total": 50, "attributed": 35, "coverage": 70.0 }
      },
      "eligible": true,
      "eligibilityReason": "meets_min_prs",
      "sections": {
        "survivalByModel": { "render": false, "reason": "floor_not_met_60%" },
        "survivalByHarness": { "render": true, "reason": "floor_met" }
      },
      "pullRequests": [
        {
          "number": 123,
          "signals": ["botAuthor"],
          "agentAuthored": { "value": "agent", "confidence": "strong", "conflict": false, "evidence": [...] },
          "harness": { "value": "github-copilot", "confidence": "strong", "conflict": false, "evidence": [...] },
          "model": { "value": "unknown", "confidence": null, "conflict": false, "evidence": [] }
        }
      ]
    }
  ],
  "aggregate": {
    "micro": { "agentAuthored": {...}, "harness": {...}, "model": {...}, "agentOrHarness": {...} },
    "macro": { "agentAuthored": {...}, "harness": {...}, "model": {...}, "agentOrHarness": {...} },
    "feasibility": {
      "eligibleRepos": 11,
      "totalRepos": 15,
      "agentOrHarnessGate": { "passed": 10, "total": 11, "percentage": 90.9 }
    },
    "precision": {
      "audited": true,
      "agentAuthored": { "confirmed": 45, "audited": 50 },
      "harness": { "confirmed": 28, "audited": 30 },
      "model": { "confirmed": 9, "audited": 10 }
    }
  }
}
```

## Framing: "All PRs, Agent-Attributed Highlighted"

Per R4 findings and revised design:

- **Never drop unattributed PRs** — they're scored and included in all metrics
- **Survival-by-model section gated separately** — model coverage is expected to be lower; gate independently
- **Survival-by-harness table accurately titled** — shows harness distribution only when ≥60% harness coverage
- **Report always surfaces coverage** — the section gates are explicit decisions, never hidden
- **Owner-correctable** — precision audit file allows manual review of edge cases

## Implementation Notes

- **No wavemill state required** — scan pipeline runs independently with only `gh api` calls
- **Backward compatibility** — tool re-exports signal-analysis types; existing imports stay valid
- **Lenient failure handling** — malformed first-party routes, missing config files, invalid audit data don't crash; evidence records the issue
- **Hard config errors** — unknown config keys are rejected (typos must not silently erase settings)
