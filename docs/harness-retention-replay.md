# Harness Retention Replay

Harness retention replay is a fixed, held-out regression suite for decisions
that should remain stable across harness changes. It reports `D`, the count of
cases that pass under the deployed baseline harness and fail under the
candidate harness.

The committed seed suite lives at
`shared/fixtures/harness-replay/harness-retention-v1/manifest.json`, outside
`.wavemill/evals/` and outside runtime prompt/resource discovery paths. It is
evaluation-only: task, review, judge, and expansion prompts must not load the
suite except through `tools/run-harness-replay.ts` or direct replay tests.

## Surfaces

- `routing`: re-runs stored routing prompts and exact-matches planner/coder/reviewer.
- `review`: runs `runReview` against a stored sanitized diff and exact-matches verdict.
- `eval_judging`: runs the eval judge path against stored artifact evidence and exact-matches success.
- `issue_expansion`: runs `expandIssue` against stored issue context and checks stable output evidence.

Malformed cases and execution errors are explicit failures in enforce mode.
Unstable cases are excluded by the stability probe; replay does not average
over nondeterminism.

## Sampling

Suite `harness-retention-v1` contains 226 cases: 170 previously passing, 56
previously failing, and 26 incident placeholders. The ratio follows the
paper-inspired rule of keeping a fixed majority of previously passing cases
while retaining known prior failures. The local worktree did not include
`.wavemill/evals/artifacts/` or `.wavemill/incidents/`, so the committed seed is
sanitized synthetic evidence with source-provenance notes. Replace it with
real sanitized snapshots when those stores are available.

## Probes

The manifest records both required pre-enforcement probes:

- Stability: repeat unchanged-harness replay and exclude per-case variance.
- Coverage: map the three named incidents to caught/missed evidence. At least
  two must be caught; otherwise cheap replay is not enough and full workflow
  replay is required.

The current manifest marks the ready-watchdog and challenge-pairing incidents
as caught, and the monitor-bundle regeneration incident as a workflow-replay
gap.

## Running

```bash
npx tsx tools/run-harness-replay.ts \
  --baseline-harness-id "$DEPLOYED_HARNESS_ID" \
  --candidate-harness-id "$CANDIDATE_HARNESS_ID" \
  --mode shadow
```

Configure rollout in `.wavemill-config.json`:

```json
{
  "harness": {
    "retention": {
      "enabled": true,
      "mode": "shadow",
      "tolerance": 1
    }
  }
}
```

Shadow mode always retains and reports the replay result without blocking.
Enforce mode fails closed when `D > harness.retention.tolerance`, or when the
suite/baseline evidence is missing or invalid. The default tolerance is `1`.

Before enabling blocking, publish two weeks of `auto/integration` shadow
reports and their rejection rate. The first enforcement point is the
post-completion memory rewrite: failed enforce replay preserves the report and
skips `project-context.md` and subsystem spec updates.

## Refresh

Refresh the suite every six months. Retire cases only after replacing them with
stable newer cases at the same pass/fail ratio, and only when the retired cases
have produced no regression signal for six months.
