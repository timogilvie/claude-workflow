# Arbiter Swap Test

The swap test measures whether the current blinded Arbiter judge changes its
winner when the same challenge pair is presented in the opposite order.

Definitions:

- Adjudicated pair: a `challenge-records.jsonl` row with an LLM verdict
  (`winner`, `dimensions`, `rationale`; `comparisonOutcome` absent or
  `compared`), excluding manual resolutions, forfeits, skips, invalids, and
  voided records. Duplicate `challengePairId` rows keep the newest timestamp.
- Flip: the replay winner differs between `primary-first` and
  `challenger-first` for the same pair.
- Position preference: among flips, whether the judge chose Candidate A in both
  orders (`first`) or Candidate B in both orders (`second`).
- Unrecoverable type: a pair whose challenged stage cannot be derived from
  varied dimensions, stored challenge type, eval `challengeStage`, or challenge
  intent. It is counted and included overall, but flagged out of per-type
  analysis.

Commands:

```bash
npx tsx tools/swap-test.ts --hydrate --repo-dir /Users/timothyogilvie/Dropbox/wavemill
npx tsx tools/swap-test.ts --run --dry-run --run-id swap-YYYY-MM-DD --repo-dir /Users/timothyogilvie/Dropbox/wavemill
npx tsx tools/swap-test.ts --run --run-id swap-YYYY-MM-DD --max-cost-usd 200 --repo-dir /Users/timothyogilvie/Dropbox/wavemill
npx tsx tools/swap-test.ts --report --run-id swap-YYYY-MM-DD --repo-dir /Users/timothyogilvie/Dropbox/wavemill
```

Useful smoke-test flags:

```bash
npx tsx tools/swap-test.ts --run --limit 3 --run-id swap-smoke
npx tsx tools/swap-test.ts --run --pairs HOK-1225,HOK-1333 --only-order primary-first
```

The replay uses the production blind judge path in `runBlindJudge()`. Each row
records `judgeModel`, `judgePromptHash`, and `judgeTemplateHash`; an existing
run refuses to resume if the model or template hash changed.

Only aggregate summaries are intended for commit. Raw diffs, prompts, results,
and contexts remain under `.wavemill/evals`.
