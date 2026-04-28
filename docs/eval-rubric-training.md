# Eval Rubric Training Data

Historical eval datasets now mix rubric-aware and legacy rows. `rubric_provenance` makes that mix explicit so downstream trainers can choose consistent policies instead of inferring intent from missing fields.

Challenge PR comparisons now use the same five canonical rubric criteria as per-PR evals:
`completeness`, `correctness`, `code_quality`, `intervention_impact`, and `autonomy`.

## Provenance Values

- `judge`: The eval judge emitted `rubricEval` directly during record creation. This is the highest-confidence source.
- `backfill_derived`: A later tool reconstructed rubric semantics from historical data. Consumers should assume weaker fidelity than `judge`.
- `legacy_absent`: The record predates rubric capture and was explicitly marked as lacking rubric metadata.

## Recommended Trainer Policies

- Filter-only policy: train rubric-sensitive components only on `judge` rows.
- Weighted policy: use weights such as `judge=1.0`, `backfill_derived=0.5`, `legacy_absent=0.0`.
- Train-twice policy: run one experiment on only `judge` rows and a second on the full dataset with provenance as an input feature.

If `rubric_provenance` is missing entirely, treat the row as an old unbackfilled legacy record rather than as evidence that no rubric was needed.

## Backfill Historical Records

Run:

```bash
npx tsx tools/backfill-rubric-eval-records.ts --repo /path/to/repo
```

Preview without writing:

```bash
npx tsx tools/backfill-rubric-eval-records.ts --repo /path/to/repo --dry-run
```

The tool reads `.wavemill/evals/evals.jsonl`, marks only rows that do not already have `rubric_provenance`, and rewrites the file atomically through a temp file plus rename.

## Deduplication and Aggregation

- Aggregation preserves `rubricEval` and `rubric_provenance` intact.
- When duplicate records collide, dedup prefers `judge` over `backfill_derived`, `backfill_derived` over `legacy_absent`, and all of those over an unset value.
- If provenance ties, existing earliest-timestamp behavior still decides the winner.

## Task Descriptor Rubric Features

`TaskDescriptor` now includes an optional `rubric` section derived from `EvalRecord.rubricEval`:

- `rubric.has_rubric`: Always `true` when the section is present.
- `rubric.criterion_count`: Count of rubric criteria with finite scores.
- `rubric.mean_score`: Mean across finite criterion scores (clamped to `0..1`).
- `rubric.criteria_scores`: Fixed per-criterion numeric scores:
  `completeness`, `correctness`, `code_quality`, `intervention_impact`, `autonomy`.
- `rubric.determinative_boundary`: Optional boundary label copied from `rubricEval`.

Router/training feature intent:

| Feature | Nearest-neighbor ready | Future learned models |
|---|---|---|
| `has_rubric` | Yes | Yes |
| `criterion_count` | Yes | Yes |
| `mean_score` | Yes | Yes |
| `criteria_scores.*` | Yes | Yes |
| `determinative_boundary` | Yes (categorical encoding) | Yes |
| Rubric rationale text | No | No |

Contract notes:

- The `rubric` section is additive-only and optional for backward compatibility.
- Legacy rows without rubric criteria must continue to omit `taskDescriptor.rubric`.
- Consumers should treat unknown future keys as forward-compatible additions only when schema versions permit.

## Router Rollout

Stage-aware routing consumes rubric descriptors through `router.rubricAware`:

```json
{
  "router": {
    "rubricAware": {
      "mode": "shadow",
      "minCoverage": 0.3,
      "weight": 0.3
    }
  }
}
```

Rollout sequence:

- `off`: Default behavior. The router ignores rubric descriptors and uses scalar stage scores only.
- `shadow`: Canonical routing remains scalar-only. When the nearest-neighbor window meets `minCoverage`, the router also computes a rubric-aware `shadowDecision`.
- `on`: When the nearest-neighbor window meets `minCoverage`, each rubric-bearing record blends its scalar stage score with `rubric.mean_score`: `scalar * (1 - weight) + rubricMean * weight`.

Coverage is measured across the nearest-neighbor window after KNN selection: `rubriced_neighbors / total_neighbors`. Legacy rows still participate through the scalar path. If coverage is below `minCoverage`, `shadowDecision` is `null` in shadow mode and `on` mode falls back to scalar scoring.

Decision reasoning starts with one of these tags when rubric-aware config is active:

- `rubric-aware (mode=shadow, coverage=0.60, weight=0.3)`
- `rubric-aware (mode=on, coverage=0.60, weight=0.3)`
- `rubric-aware fallback: coverage 0.10 < minCoverage 0.30`

## Schema Reference

See the `1.13.0` changelog entry in [shared/lib/eval-schema.ts](../shared/lib/eval-schema.ts).

## Reverting a Backfill

To strip only the provenance marker:

```bash
jq -c 'del(.rubric_provenance)' .wavemill/evals/evals.jsonl > /tmp/evals.jsonl && mv /tmp/evals.jsonl .wavemill/evals/evals.jsonl
```
