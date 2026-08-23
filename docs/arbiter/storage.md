# Arbiter Storage

Challenge comparisons persist a compact diff identity for both arms so later
analysis can reconstruct the compared contributions from local git state.

Each comparison record may include `primaryDiffIdentity` and
`challengerDiffIdentity`:

- `head_sha`: the side's PR head commit at comparison time.
- `merge_sha`: the diff base SHA used for reconstruction. For forked pairs this
  is `forkCommit`; for independently launched pairs it is the local
  `git merge-base` of the PR base ref and the side's head commit.
- `files_touched`: file paths reported by `git diff --name-only merge_sha
  head_sha`.
- `line_ranges`: added-side line ranges parsed from `git diff --unified=0
  merge_sha head_sha`.

The pair structure is represented by the comparison-level fork descriptor:
`forkStage`, `forkCommit`, `sharedPrefix`, `primaryInheritedStages`, and
`challengerInheritedStages`. For today's independent pairs `forkCommit` is
`null` and each side's `merge_sha` is its own merge base. For future forked
pairs, `forkCommit` plus both side `head_sha` values is the retained shape.

The losing side's full patch is retained locally when there is a winner:

```text
.wavemill/evals/artifacts/<challengePairId>/loser.patch
```

Only the loser patch is written by default. The winner is represented by the
comparison identity and normal git history after merge, while the loser is the
side most likely to lose branch/worktree state after PR closure.

Patch retention is capped at 10 MiB. If `git diff merge_sha head_sha` exceeds
that cap, Wavemill skips `loser.patch`, emits a warning, and still writes both
sides' compact diff identities to the comparison record.

These artifacts are local runtime data under `.wavemill/evals`, which is
gitignored. They are not uploaded, included in PR comments, sent to Linear or
Hokusai export, or otherwise moved across the repository privacy boundary by
comparison storage. No database migration, external egress path, or config file
is required for this retention policy.

## Swap-test corpus and runs

The presentation-order swap test retains its replay corpus and raw run outputs
under the same local eval artifact root:

```text
.wavemill/evals/artifacts/<challengePairId>/primary.diff
.wavemill/evals/artifacts/<challengePairId>/challenger.diff
.wavemill/evals/artifacts/<challengePairId>/swap-test-context.json
.wavemill/evals/swap-test/runs/<runId>/manifest.json
.wavemill/evals/swap-test/runs/<runId>/results.jsonl
.wavemill/evals/swap-test/runs/<runId>/summary.json
.wavemill/evals/swap-test/runs/<runId>/summary.md
```

Hydration is one-time and idempotent. Existing `primary.diff`,
`challenger.diff`, and retained `loser.patch` files are reused; missing side
diffs are fetched by full PR URL and then replayed locally. The runner never
fetches GitHub state.

`swap-test-context.json` records prompt provenance, challenge type and
difficulty strata, head identity, original verdict metadata, and degenerate
flags such as empty diffs or tied original dimensions. Raw result rows include
judge model, prompt hash, template hash, usage, cost, truncation state, and
duration for each pair/order call.

These files are runtime artifacts and remain gitignored. The committed
write-up material is limited to aggregate Markdown summaries, with no diffs,
prompts, or per-pair judge rationales.
