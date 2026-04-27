# Eval Rubric Training Data

Historical eval datasets now mix rubric-aware and legacy rows. `rubric_provenance` makes that mix explicit so downstream trainers can choose consistent policies instead of inferring intent from missing fields.

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

## Schema Reference

See the `1.12.0` changelog entry in [shared/lib/eval-schema.ts](/Users/timothyogilvie/Dropbox/wavemill/worktrees/backfill-and-aggregate-rubric-aware-eval-records-for-collective-training-data/shared/lib/eval-schema.ts:1).

## Reverting a Backfill

To strip only the provenance marker:

```bash
jq -c 'del(.rubric_provenance)' .wavemill/evals/evals.jsonl > /tmp/evals.jsonl && mv /tmp/evals.jsonl .wavemill/evals/evals.jsonl
```
