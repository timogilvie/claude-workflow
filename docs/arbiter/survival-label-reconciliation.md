# Survival Label Reconciliation

Status: HOK-2792 reconciliation for Arbiter R5.

## Sources

- `/Users/timothyogilvie/Dropbox/wavemill/docs/hokusai-second-model-data-plan.md` §3.1. The tracked `docs/hokusai-second-model-data-plan.md` file is absent from this worktree and `auto/integration`; the available local copy is the source for the existing definitions.
- Linear plan of record §10.4 Tier 2/Tier 2b and §11.3.
- Canceled Linear issue HOK-2078, which previously scoped the offline undo/survival labeler.
- Linear issues HOK-2076, HOK-2803, and HOK-2805.
- `shared/lib/cross-pr-revert-detector.ts`.
- `shared/lib/intervention-detector.ts`.
- `shared/lib/eval-schema.ts`.

## 1. Section 3.1 Definitions And Granularity

The second-model data plan defines undo/survival as derived labels, not runtime-captured fields. The hook captures mutating-step substrate, specifically `edit_hunks`; a versioned offline labeler computes `reverted`, `survival_ratio`, and `undone_by` after the task.

The existing granularity is per mutating step or artifact edit hunk:

- `reverted`: exact, high-precision evidence that a later action in the same lineage restored the pre-edit content of lines changed by the step.
- `survival_ratio`: terminal-anchored, graded fraction of the step's edited lines present in the final accepted artifact. It is meaningful only for successful tasks.
- `undone_by`: attributable undoer, `human | agent`. Human undo is weighted heavily; agent self-undo is weighted lightly.

The precision rules carry over: label only mutating edits, normalize before matching, strip formatting/whitespace noise, follow renames, do not count formatter/linter passes as undoers, condition `survival_ratio` on accepted work, and favor precision over recall.

Arbiter changes the unit from "one mutating step/artifact hunk" to "one merged PR at one elapsed horizon." The PR label aggregates over normalized line ranges touched by that PR on the integration branch. It does not treat a later same-file touch as enough evidence. The label must be emitted once per eligible merged PR per horizon, and missing/ineligible labels are explicit rather than imputed.

## 2. Current Cross-PR Detector Vs Labeller Needs

`shared/lib/cross-pr-revert-detector.ts` is a pre-merge guard. It walks recent integration merge commits with `git log --first-parent --merges`, parses PR numbers from merge subjects, compares `git diff --name-status` results and blob IDs, and emits file-level findings when the current branch deletes a file introduced by a recent PR or restores a changed file to that PR parent's blob.

`detectSurvivingChangeWarnings` is also file-level: for history-only PRs it flags added files that are absent from the promoted tree. The module filters acknowledged reverts from PR text, and it avoids blocking on reverts already present at the integration tip.

The survival labeller needs a different job with some reusable plumbing:

- hunk/line-range granularity rather than whole-file blob equality;
- a forward 14/30/60 day window after the merged PR;
- line-weighted `survival_ratio` at the horizon terminal tree;
- exact reverted evidence over affected PR ranges, not same-file churn;
- qualifying follow-up evidence from intersecting line-range amendments, linked issue/PR references, or same-task redispatch;
- PR identity and provenance fields such as `prUrl`, PR head/merge SHAs, `line_ranges`, `integration_branch`, and `label_provenance`;
- no `main` blame in squash-promotion repos.

So `collectRecentPrCommits` and name-status parsing can inform the implementation, but the current detector is not the label definition and is not precise enough for training labels.

## 3. Naming And Collision Check

`ReworkOutcome` is already used in `shared/lib/eval-schema.ts` for within-branch implementation rework: agent iterations and optional tool failures. Do not reuse it for the PR survival label.

The Arbiter label name is `survival`, with `followup` as the PR-level signal that the change required later amendment or linked redispatch. Existing `survival` uses in wavemill are operating-mode concepts (`OperatingMode = "normal" | "constrained" | "survival"`), not training-label objects. Existing `followup` text is generic and not a typed outcome object. Existing coarse `reverted?: boolean | null` feature-state fields are not the new PR/horizon contract.

To avoid ambiguity in docs and code, refer to the new object as the "survival label" and use concrete fields such as `survived`, `survival_ratio`, `reverted`, and `followup`.

## 4. Human Pre-Merge Edits

`shared/lib/intervention-detector.ts` should remain a separate intervention feature and provenance source. It detects review comments, post-PR commits, manual edits, test fixes, session redirects, operator recovery, failed attempts, self-review findings, and unknown attribution. Manual edits are classified with agent activity windows and operator-handoff intervals on wavemill-managed/native branches; unknown attribution is emitted loudly rather than treated as no intervention.

For the survival label, human pre-merge edits fold in only when they materially undo or replace the candidate PR line ranges before merge. In that case:

- `followup = true`;
- `undone_by = "human"` when the human undoer is attributable;
- `reason` should include `pre_merge_human_edit`.

Human review or manual intervention that does not undo/replace the labelled PR line ranges remains an intervention feature/provenance input, not a survival failure. This keeps "human touched the PR" distinct from "the PR's candidate lines failed to survive."

## 5. Noise Cases And Normalization

Known noise cases do not become negative labels by themselves:

- unrelated churn in the same file;
- a more thorough patch touching more surface area;
- pure refactors that preserve behavior and do not restore/replace the PR ranges;
- formatter/linter-only changes;
- rename-only or move-only changes.

The existing §3.1 prescription already covers the core normalization: normalize before matching, strip whitespace/formatting noise, follow renames, ignore formatter/linter passes as undoers, and favor precision over recall. Arbiter adds PR-scale normalization by using line-range denominators. Larger patches are normalized by touched-line volume, so the label reports a line-weighted ratio instead of penalizing broad patches just because they touch more lines.

Same-file churn may set `followup` only when it intersects normalized PR ranges or has explicit provenance through a linked issue/PR/task redispatch. Ambiguous refactors or unrelated feature work should be excluded or marked missing/ambiguous in `reason`, not counted as `survived = false`.

## 6. Horizon Alignment

The second-model data plan §3.1 assumes no fixed horizon: it scans any later action in the same lineage and anchors `survival_ratio` to the final accepted artifact.

The 14/30/60 day horizons are new Arbiter constraints from the plan of record §10.4 and §11.3. They are compatible with §3.1 only after translating the terminal anchor:

- per-step final accepted artifact becomes the repository state at the end of each elapsed horizon;
- each merged PR can yield up to three labels, one for each elapsed horizon;
- labels for unelapsed horizons are missing, not false;
- inaccessible history or insufficient line-range substrate also yields a missing label.

## What Carries Over, What Changes, What Is New

Carries over verbatim from §3.1:

- offline/versioned derivation from captured substrate;
- raw mutating edit/change substrate as the durable input;
- exact/high-precision `reverted`;
- terminal-anchored, graded `survival_ratio`;
- `undone_by: human | agent` when attributable;
- mutating changes only, normalization before matching, rename tracking, formatter/linter exclusion, precision over recall.

Changes for PR granularity:

- unit becomes one merged PR at one horizon;
- matching operates over normalized PR line ranges;
- terminal anchor becomes the horizon terminal tree;
- `survival_ratio` is line-weighted across touched PR ranges;
- `reverted` requires exact revert evidence over PR ranges;
- `undone_by` is the attributable dominant undoer for the undo event affecting those ranges;
- `followup` captures later amendment/reference/redispatch evidence distinct from exact revert;
- missing labels are explicit and never imputed.

Genuinely new in Arbiter:

- horizons `14 | 30 | 60`;
- `survived`, `followup`, `reason`, `horizon_days`, `label_provenance`, `line_ranges`, `integration_branch`, and `prUrl`;
- `label_provenance = "harvested" | "owner_corrected"` and Tier-2b dispute handling;
- repo-agnostic scanner/labeller inputs;
- integration-branch walk and PR SHA provenance, with no `main` blame.

## Contract Draft

```ts
interface SurvivalLabelV1 {
  prUrl: string;
  survived: boolean | null;
  survival_ratio: number | null;
  reverted: boolean;
  undone_by: 'human' | 'agent' | null;
  followup: boolean;
  reason: string;
  horizon_days: 14 | 30 | 60;
  label_provenance: 'harvested' | 'owner_corrected';
  line_ranges: Array<{ path: string; start: number; end: number }>;
  integration_branch: string;
}
```

Field semantics:

- `prUrl`: stable PR identity and join key.
- `survived`: `true` when no exact revert and no qualifying follow-up affected the normalized PR line ranges inside the horizon; `false` when the ranges were exactly reverted or required qualifying follow-up; `null` for missing/ineligible labels such as unmerged PRs, unelapsed horizons, inaccessible history, or insufficient line-range substrate.
- `survival_ratio`: line-weighted fraction from 0.0 to 1.0 of normalized PR-changed lines still present in the horizon terminal tree; `null` for missing/ineligible labels.
- `reverted`: `true` only for exact pre-change restoration over affected PR ranges.
- `undone_by`: `human | agent` when the undoer is attributable; `null` for no undo, formatter-only churn, or ambiguous/mixed attribution. This preserves the §3.1 enum rather than adding `unknown` silently.
- `followup`: `true` for qualifying line-range amendment, later PR/issue reference, same-task redispatch, or human pre-merge edit that materially changes the candidate before merge.
- `reason`: stable reason token or token list. Initial values should include `exact_revert`, `line_range_followup`, `linked_issue_or_pr`, `pre_merge_human_edit`, `task_redispatch`, `no_evidence`, `missing_horizon`, `insufficient_history`, and `ambiguous_change`.
- `horizon_days`: elapsed forward window, exactly `14`, `30`, or `60`.
- `label_provenance`: `harvested` for automatic labels; `owner_corrected` for Tier-2b corrections. Owner corrections should not silently overwrite the harvested label without preserving correction provenance for downstream invalidation or reweighting.
- `line_ranges`: normalized PR line ranges used as the denominator and matching substrate.
- `integration_branch`: branch walked by the labeller, for example `auto/integration`.

## Program Brief Update

Text added to §4 S2:

```md
**S2 survival label v1.** The survival labeller emits one label per merged PR per elapsed horizon (`14 | 30 | 60` days), aggregated over normalized PR line ranges walked on the integration branch, never by blaming `main`. It adopts `docs/hokusai-second-model-data-plan.md` §3.1: `reverted` is exact/high-precision restoration of pre-change lines; `survival_ratio` is the line-weighted fraction of changed lines still present at the horizon terminal tree and is missing rather than imputed when ineligible; `undone_by` is `human | agent` when an undoer is attributable. Arbiter adds PR-level `survived`, `followup`, `reason`, `horizon_days`, `label_provenance`, `line_ranges`, `integration_branch`, and `prUrl`. Human pre-merge edits remain intervention features except when they materially undo or replace the PR line ranges, in which case they contribute to `followup`/`undone_by`. Labels are precision-biased: normalize whitespace/formatting, follow renames, exclude pure refactors/unrelated features/formatter-only churn, and tag provenance (`harvested`, `owner_corrected`) for downstream weighting.
```

Decision Log entry:

```md
**2026-09-02 · HOK-2792 · wavemill** — S2 adopts the undo/survival definitions from `docs/hokusai-second-model-data-plan.md` §3.1 at PR granularity rather than creating a parallel label. `reverted`, `survival_ratio`, and `undone_by` keep their §3.1 meanings and precision rules; Arbiter adds per-merged-PR, per-horizon aggregation over normalized line ranges plus `survived`, `followup`, `reason`, `horizon_days`, `label_provenance`, `line_ranges`, `integration_branch`, and `prUrl`. Why: this keeps the labeller and training contract compatible with the already specified offline/versioned label substrate while adding only the scanner fields required by §10.4/§11.3. Affects: HOK-2803, HOK-2805, HOK-2076, HOK-2078.
```
