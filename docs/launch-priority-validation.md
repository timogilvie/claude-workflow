# Launch-Priority Validation

`tools/launch-validation.ts` builds the grouped OpenRouter launch artifact at
`.wavemill/audits/launch-validation.json`.

## Modes

Fixture mode is the default:

```bash
npx tsx tools/launch-validation.ts
```

- Uses the checked-in launch-priority fixture for catalog provenance.
- Uses fixture-backed smoke responses so CI stays deterministic.
- Produces an artifact that exercises grouping, diagnostics, and Hokusai export
  fields without live network dependencies.

Live mode is operator-only:

```bash
OPENROUTER_LIVE_SMOKE=1 \
OPENROUTER_API_KEY=... \
npx tsx tools/launch-validation.ts --live
```

- Fetches the public OpenRouter catalog before composing the artifact.
- Attempts live smoke against every active/watchlist launch-priority model in
  the snapshot.
- Missing `OPENROUTER_API_KEY` does not crash the run; the artifact records a
  per-model smoke blocker so launch readiness can distinguish access blockers
  from silent gaps.

## Artifact semantics

The artifact joins three sources:

- launch-priority list provenance: fixture schema version and source hash
- catalog snapshot provenance: generated time, schema version, entry/blocker
  counts
- validation evidence: smoke results plus per-role audit counts from existing
  eval history

Each active/watchlist model lands in one of three states:

- `covered`: smoke succeeded or Wavemill already has direct execution evidence
- `blocked`: no coverage yet, but at least one explicit catalog/audit/smoke
  blocker explains why
- `gap`: no successful smoke, no evidence, and no blocker; this fails the CLI

The `families` section highlights `qwen`, `deepseek`, and `kimi`, including
their lowest-cost challenger, successful models, and blocked models. The
`diagnostics` section splits overrepresented `anchor` traffic (`claude`/`gpt`)
from under-sampled launch `target` traffic so downstream pipeline reports can
separate incumbent-heavy evidence from launch gaps.

## Hokusai export

`shared/lib/hokusai-submission-trigger.ts` now adds launch-priority fields to
contribution-row `inputs` when the eval record maps to a launch-priority model:

- alias and OpenRouter id
- family, status, tier, and eligible roles
- `anchor` vs `target` track
- launch-priority fixture schema version and source hash

That keeps downstream coverage joins additive and row-based; eval-record schema
changes are not required for launch-validation provenance.
