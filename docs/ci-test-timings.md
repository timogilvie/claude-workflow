# CI Test Timings and Weighted Sharding

HOK-2939 rebalanced the required PR test gate so the `Shell and Unit Tests`
aggregator finishes in under five minutes. Two suites are sharded by
**measured weight** instead of list position:

- **Unit** (`tests/run-unit-tests.sh`): 5 CI shards.
- **Custom harness** (`tests/run-custom-tests.sh`): 3 CI shards (previously a
  single ~9-minute serial job).

Shell shards, preflight, smoke, and certification were already under budget
and are unchanged.

## How assignment works

1. The bash `TESTS=(...)` / `TS_TESTS=(...)`+`SH_TESTS=(...)` arrays in the
   runners remain the **single registration source** (see "Test Registration"
   in CLAUDE.md). Nothing else needs editing when a test is added.
2. When a runner is invoked with `--shard N/M`, it pipes its full registered
   list to `tools/ci-test-timings.ts assign`, which partitions the list with a
   deterministic greedy LPT algorithm (`shared/lib/test-partitioner.ts`):
   sort by (weight desc, path asc), assign each test to the lightest shard,
   ties to the lowest index. Identical inputs always produce identical
   assignments.
3. Weights come from the checked-in manifests `tests/timings/unit-weights.json`
   and `tests/timings/custom-weights.json` (median milliseconds per test file
   across ≥3 instrumented runs).
4. A test **not present in the manifest** (e.g. newly added) gets the
   manifest's `defaultWeightMs` — the p90 of known weights, deliberately
   conservative so a new test cannot silently overload one shard. It still
   runs; a stale manifest degrades balance, never correctness or coverage.
5. A **malformed or missing manifest fails the shard loudly** (the runner
   exits non-zero). Selection never silently falls back to a different
   partitioning.

## Failure semantics (unchanged)

- Every shard exits non-zero when any assigned test fails; an empty shard is
  exit 2 (configuration error, not a silent pass).
- The `Shell and Unit Tests` aggregator still depends on the `unit` and
  `custom` job ids, so any failed/cancelled/skipped matrix leg fails the
  required check. Required check names (`Shell and Unit Tests`,
  `Check Lifecycle Paths`, `Lifecycle Integration Tests`) are unchanged.

## The preflight guard

`npm run test:preflight` runs `npx tsx tools/ci-test-timings.ts check`, which
fails when:

- either manifest is missing, unparseable, or contains a zero/negative/
  non-finite weight (the diagnostic names the entry);
- the ci.yml matrix values, the `/M` in the job name, and the `/M` in the
  `--shard` argument disagree for the `unit` or `custom` job (a disagreement
  could silently drop shards);
- the computed assignment does not cover every registered test exactly once;
- any shard's estimated total exceeds **130% of the median** shard estimate,
  unless a single named test's weight alone exceeds that bound (reported as
  an allowed "indivisible hotspot" warning).

`npx tsx tools/ci-test-timings.ts report` prints the per-shard estimates.

## Per-run timing artifacts

Each CI unit/custom shard writes `test-timings/*.json`
(`{ suite, shard, generatedAt, results: [{ file, ms, result }] }`) and uploads
it as the `test-timings-<suite>-<shard>` artifact. Locally, set
`WAVEMILL_TEST_TIMINGS_FILE` to redirect the output. The unit runner captures
timings via a second `node --test` reporter
(`tests/lib/file-timing-reporter.mjs`), so human-readable output is
unchanged; the custom runner wraps each test with `Date.now()` timestamps.
Artifacts contain repo-relative paths and integers only — no secrets, no
environment contents.

## Regenerating the weight manifests

Regeneration is a documented maintenance task, not automatic. Do it when the
balance report drifts (preflight starts warning about many default-weight
tests, or a shard wall time visibly diverges in CI).

1. Collect **at least 3** timing samples per suite. Either download the
   `test-timings-*` artifacts from ≥3 recent CI runs (preferred — runner
   -representative), or run locally:

   ```bash
   WAVEMILL_TEST_TIMINGS_FILE=/tmp/unit-1.json bash tests/run-unit-tests.sh
   WAVEMILL_TEST_TIMINGS_FILE=/tmp/custom-1.json bash tests/run-custom-tests.sh
   # ...repeat for -2 and -3
   ```

   For CI artifacts of a sharded run, each shard uploads its own file; pass
   all shard files from all runs to `generate` — the merge is per-test, so
   partial-coverage samples are fine.

2. Generate and commit:

   ```bash
   npx tsx tools/ci-test-timings.ts generate --suite unit \
     --out tests/timings/unit-weights.json /tmp/unit-*.json
   npx tsx tools/ci-test-timings.ts generate --suite custom \
     --out tests/timings/custom-weights.json /tmp/custom-*.json
   npx tsx tools/ci-test-timings.ts check   # must pass before committing
   ```

   `generate` refuses fewer than 3 samples without `--allow-few`; a single
   noisy run must never become a permanent manifest.

## Changing a shard count

Update all three places for the job in `.github/workflows/ci.yml` (matrix
values, name suffix, `--shard` denominator) **and** the corresponding
`prePrVerification` check names in `.wavemill-config.json`. Preflight
(`ci-test-timings.ts check`, `check-ci-command-map-drift.ts`) fails on any
mismatch. `ready.localCommandMap` needs no change — lookup strips the
`(shard N/M)` suffix.

## Measuring the aggregator (REQ-F6 evidence recipe)

Median/p90 of workflow-creation → `Shell and Unit Tests` completion over ten
representative successful PR runs:

```bash
gh run list --workflow CI --event pull_request --status success \
  --limit 10 --json databaseId --jq '.[].databaseId' |
while read -r run_id; do
  gh run view "$run_id" --json createdAt,jobs --jq '
    (.jobs[] | select(.name == "Shell and Unit Tests") | .completedAt) as $done
    | "\(.createdAt) \($done)"' |
  while read -r created done; do
    python3 - "$created" "$done" "$run_id" <<'PY'
import sys, datetime
c, d, run = sys.argv[1], sys.argv[2], sys.argv[3]
parse = lambda s: datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
print(f"{run} {(parse(d) - parse(c)).total_seconds():.0f}s")
PY
  done
done
```

Targets: median ≤ 300s, p90 ≤ 420s.
