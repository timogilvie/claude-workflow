# HOK-984 Plan

## Goal

Extract the repeated JSONL parsing, error-message formatting, and GitHub review fetch/repo-resolution logic into shared utilities, then switch the affected libraries and tools to those utilities without changing behavior.

## Findings From Research

- `shared/lib/eval-persistence.ts`, `shared/lib/model-router.ts`, `shared/lib/session-adapters.ts`, `shared/lib/outcome-collectors.ts`, and `tools/backfill-pricing-snapshot.ts` each hand-roll the same JSONL `readFileSync` + `split('\n')` + `trim` + `JSON.parse` + skip-malformed pattern. `tools/deduplicate-evals.ts` and `tools/backfill-workflow-cost-status.ts` also contain near-identical readers.
- `err instanceof Error ? err.message : String(err)` is repeated broadly, with the densest clusters in `shared/lib/outcome-collectors.ts` and `shared/lib/intervention-detector.ts`.
- `shared/lib/outcome-collectors.ts` and `shared/lib/intervention-detector.ts` both call `gh api repos/.../pulls/.../reviews` separately and both need owner/repo resolution.
- `tools/deduplicate-evals.ts` and `tools/backfill-pricing-snapshot.ts` define local `EvalRecord` interfaces even though `shared/lib/eval-schema.ts` exports the canonical type.

## Implementation Phases

### Phase 2.1: Add shared utilities

- Create a small shared utility module for JSONL reading and generic error-message extraction.
- Export `readJsonlFile<T>(path: string): T[]` with current behavior preserved:
  - returns parsed JSON objects in file order
  - skips blank lines
  - skips malformed JSON lines instead of throwing
  - returns `[]` when the file is missing only where the caller already gates on `existsSync`; tools that currently throw on missing files will keep that explicit check before calling the helper
- Export `errorMessage(err: unknown): string`.
- Keep the utility dependency-free beyond Node built-ins so it can be used by both `shared/lib` and `tools`.

### Phase 2.2: Move GitHub review/repo helpers into a shared module

- Create `shared/lib/github-utils.ts` to host:
  - `resolveOwnerRepo(repoDir?: string): string | undefined`
  - `fetchPrReviews(prNumber: string, repoDir?: string, nwo?: string): PrReview[]`
- Make `fetchPrReviews()` fetch the full review payload needed by both consumers once, then let callers derive:
  - author/body/state/submittedAt for `detectReviewComments()`
  - state/submittedAt counts/rounds for `collectReviewOutcome()`
- Preserve existing degraded behavior:
  - return `[]` on repo-resolution failure or API failure
  - keep warnings at the call sites so log prefixes remain module-specific
- Re-export or update imports so `intervention-detector.ts` and `outcome-collectors.ts` both depend on the shared module instead of each other for repo resolution.

### Phase 2.3: Migrate callers to the utilities

- Replace duplicated JSONL readers with `readJsonlFile()` in:
  - `shared/lib/eval-persistence.ts`
  - `shared/lib/model-router.ts`
  - `shared/lib/session-adapters.ts`
  - `shared/lib/outcome-collectors.ts`
  - `tools/backfill-pricing-snapshot.ts`
- Also fold in the same helper where it is effectively the same code in:
  - `tools/deduplicate-evals.ts`
  - `tools/backfill-workflow-cost-status.ts`
- Replace repeated error-message extraction with `errorMessage()` in:
  - `shared/lib/outcome-collectors.ts`
  - `shared/lib/intervention-detector.ts`
- Opportunistically switch other touched files that already import the new utility if it stays low-risk, but do not do a repo-wide cleanup beyond the files implicated by this task.
- Replace local `EvalRecord` interfaces in:
  - `tools/deduplicate-evals.ts`
  - `tools/backfill-pricing-snapshot.ts`
  with `import type { EvalRecord } from '../shared/lib/eval-schema.ts';`
- For `backfill-pricing-snapshot.ts`, keep the existing loose access pattern by using the canonical type plus local narrowing/casts rather than redefining the interface.

### Phase 2.4: Tests and validation between phases

- After utility extraction and caller migration, run targeted tests first:
  - `node --test shared/lib/eval-persistence.test.ts`
  - `node --test shared/lib/session-adapters.test.ts`
  - `node --test shared/lib/intervention-detector.test.ts`
  - `node --test shared/lib/outcome-collectors.test.ts`
- Then run the project’s relevant lint/typecheck command(s) after I confirm the repo’s standard validation entry points.
- If any test or lint step fails, stop and fix before continuing to the next phase per the workflow.

## Risks / Decisions

- `readJsonlFile()` should stay intentionally small and silent on malformed lines because several current callers depend on “best effort” parsing instead of hard failure.
- `fetchPrReviews()` should not retain the existing `--jq`-specific payload trimming; the shared helper should fetch one normalized array shape and let each caller project from that result.
- `outcome-collectors.ts` currently imports `resolveOwnerRepo` from `intervention-detector.ts`; moving that function to `github-utils.ts` removes an avoidable cross-module dependency.
- I plan to leave broader cleanup of the remaining `errorMessage` duplicates outside the requested hotspot files unless the new utility can be adopted without expanding scope materially.

## Expected Files To Change

- `shared/lib/eval-persistence.ts`
- `shared/lib/model-router.ts`
- `shared/lib/session-adapters.ts`
- `shared/lib/outcome-collectors.ts`
- `shared/lib/intervention-detector.ts`
- `shared/lib/eval-schema.ts` (import-only consumer impact, no schema change expected)
- `shared/lib/github-utils.ts` (new)
- one new generic utility module for JSONL/error helpers
- `tools/deduplicate-evals.ts`
- `tools/backfill-pricing-snapshot.ts`
- likely `tools/backfill-workflow-cost-status.ts`
- affected tests for the modules above

## Phase 3 Reminder

- After implementation and validation, run:
  `npx tsx /Users/timothyogilvie/Dropbox/wavemill/tools/review-changes.ts main --json`
  with a 600s timeout from this worktree, iterate on blocker findings up to 3 times, then create and link the PR for `HOK-984`.
