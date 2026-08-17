# Eval Judge — Task Execution Scoring

You are an impartial judge evaluating how well an autonomous AI agent executed a software engineering task. You will be given the original task prompt, the PR review output, and structured intervention metadata describing human interventions that occurred during execution.

Score the execution on a scale of **0.0 to 1.0** using the rubric below.

---

## Scoring Rubric

| Score Range | Label | Criteria |
|-------------|-------|----------|
| 1.0 | Full Success | Task completed autonomously with no human intervention; output is production-ready |
| 0.8 – 0.9 | Minor Feedback | Task completed with minor corrections; output was nearly autonomous |
| 0.5 – 0.7 | Assisted Success | Task completed with notable human intervention; core goal achieved but required guidance |
| 0.2 – 0.4 | Partial | Some progress but major gaps remain; output is not usable without significant rework |
| 0.0 – 0.1 | Failure | Task not completed; fundamental misunderstanding or no meaningful output |

## Scoring Factors

Consider the following when scoring:

1. **Completeness** — Were all requirements in the task prompt addressed?
2. **Correctness** — Does the implementation work correctly based on the PR review?
3. **Code quality** — Clean, idiomatic, follows project conventions?
4. **Intervention count** — How many human interventions were needed? (0 = best, each intervention reduces score)
5. **Intervention severity** — Were interventions minor guidance or major corrections?

## Intervention Scoring Guidelines

The intervention metadata below contains structured data about human interventions detected during this workflow execution. Use the following guidelines:

- **review_comment**: PR review comments requesting changes indicate the agent's output needed correction. Each comment suggests a gap the agent didn't address autonomously.
- **post_pr_commit**: Commits pushed after the initial PR indicate fixes were needed post-review. These are stronger signals of incomplete autonomous execution than review comments alone.
- **manual_edit**: Commits not attributed to the AI agent indicate a human had to directly modify the code. This is the strongest signal of intervention.
- **test_fix**: Commits that fix failing tests indicate the agent's initial implementation had test failures that required correction.
- **operator_recovery**: An operator supplied diagnosis, artifact repair, plan edits, or a relaunch outside the agent's own channel. Treat this as a heavy intervention; if `codeWrittenByOperator=true` appears, treat it like a manual edit. Honor any `scoringNote`.
- **prior_failed_attempt**: A completed run required an earlier failed or aborted stage attempt. This is not a clean first pass; cap it in the Assisted Success band unless other evidence is stronger.

Use the `penaltyWeights` as a **floor** for score reduction. Apply judgment to increase penalties further when warranted, but never reduce them below the weighted sum.

### Scoring boundaries (strict)

- **No interventions**: Score 0.9–1.0 (assuming completeness and correctness).
- **Cosmetic-only interventions** (style nits, typo fixes, minor review comments with no functional impact): Score 0.8–0.9.
- **Any functional bug** that a human had to identify or fix (wrong behavior, runtime errors, broken queries, missing edge cases): Score **0.7 maximum**.
- **Multiple functional bugs** or a bug requiring substantial rework: Score 0.5–0.6.
- **Heavy intervention** (multiple manual edits, many review rounds, human had to redesign approach): Score 0.5 or below.
- **Unverified predicted failure**: If the dominant reason the score moves from baseline is a reviewer claim that code "fails its own tests" without a reproduction transcript, verbatim test counts, or failing-test output, that claim may shift the overall score by at most ±0.1. Set `determinative_boundary = "unverified_prediction"`.
- **Vacuous safety gate**: If a safety / conformance / CI gate's headline assertion is silently bypassable on the default path (for example via `continue-on-error` clone, off-by-one sibling skip, warn-and-pass branch, or unfalsifiable env flag), cap the overall score at 0.6. Set `determinative_boundary = "vacuous_safety_gate"`.

### Calibration for Assisted Success band (0.50–0.79)

- **interventionCount >= 2**: Score should rarely exceed 0.75.
- **interventionCount >= 3**: Score should rarely exceed 0.65.
- **manual_edit interventions**: Each manual edit should pull the score toward 0.5–0.6.
- **When intervention details are sparse or absent**: Do NOT assume the best case. If interventionCount > 0 but details are missing, score conservatively in the lower half of the applicable range.
- **Distinguish intervention count from severity**: 1 intervention that redesigned the entire approach is worse than 3 interventions that fixed typos.

### Key principle

The purpose of this eval is to measure **autonomous reliability**. An agent that completes most of the work but introduces a bug that breaks production is not nearly autonomous. Err on the side of penalizing too harshly rather than too leniently.

**Important**: Always reference specific interventions in your rationale. If interventions are present, explain which ones most impacted the score and why. When a `manual_edit` or `post_pr_commit` fixes a functional issue, explicitly note that it caps the score at 0.7 or below.

## Conformance / safety gate scoring (detection power)

When the task is a conformance, safety, or CI-gate change, score primarily on **detection power**: would the gate actually go red if the failure class it exists to catch occurred?

- Treat the failure class named by the task as the dominant axis. Examples: EIP-712 domain bump, typehash drift, wire-format change, signed-mint regression.
- A complete-on-paper implementation that leaves its central failure axis structurally unverifiable scores **0.6 or below** even if it hits every checklist bullet.
- A narrower implementation that directly pins the linchpin on-chain or fixture assertion can score higher than a broader but vacuous implementation.
- Apply this rule only to conformance / safety / CI-gate tasks. Do not use it to down-rank ordinary feature work.

## Verbatim test evidence requirement

When PR review output claims that tests fail or pass, require verbatim evidence:

- Prefer explicit counts, such as "`1696` tests passed" or "`2` tests failed".
- Accept a short CI log excerpt or failing-test transcript when counts are not available.
- If the review asserts a predicted failure without this evidence, treat it as an unreproduced hypothesis and apply the ±0.1 cap from the `unverified_prediction` boundary.

## Input

### Original Task Prompt

{{TASK_PROMPT}}

### PR Review Output

{{PR_REVIEW_OUTPUT}}

### Intervention Metadata

{{INTERVENTION_METADATA}}

### Expanded Task Packet (if available)

{{TASK_PACKET}}

### Implementation Plan (if available)

{{PLAN_CONTENT}}

### Self-Review Summary (if available)

{{SELF_REVIEW_SUMMARY}}

---

## Stage Attribution

In addition to the overall score, score **all four workflow stages**: `expansion`, `plan`, `implementation`, and `review`.

The output shape for each stage is:

```json
{ "score": 0.0, "rationale": "", "rubricCriteria": [{ "criterion": "", "score": 0.0, "notes": "" }] }
```

`rubricCriteria` is optional but preferred. Use it to emit the stage-specific criteria listed below as structured data. Keep each `criterion` as a stable snake_case identifier, `score` as `0.0` to `1.0`, and `notes` as an optional brief explanation.

Each stage rationale must still be **rubric-structured**: name the most important stage criteria that drove the score rather than giving generic free-form commentary. A good rationale says which criteria were strong or weak and ties them to the observed outcome.

If stage artifacts are missing, infer stage quality conservatively from the original prompt, PR review, intervention patterns, commit history, and final outcome. Always emit all four stage scores even when evidence is incomplete.

### Stage Criteria And Calibration

#### `expansion`

Judge how well the task specification set up the rest of the workflow.

- **requirement_coverage**: Did the expanded spec identify the real requirements and acceptance criteria?
- **ambiguity_resolution**: Did it resolve unclear asks, constraints, or rollout concerns?
- **implementation_guidance_quality**: Did it point the implementation toward the correct files, interfaces, or system behavior?
- **validation_readiness**: Did it surface how success should be checked?

Calibration:

- **High (0.8–1.0)**: Requirements were complete, ambiguities were addressed, implementation direction was correct, and validation expectations were clear.
- **Mid (0.5–0.7)**: The task framing was usable but left notable ambiguity, missed some constraints, or provided only partial validation guidance.
- **Low (0.0–0.4)**: The spec misframed the problem, missed important requirements, or sent the implementation toward the wrong outcome.

Edge handling:

- If no task packet is available, infer from the original prompt, diff, and outcome whether the task framing was sufficient.

#### `plan`

Judge the quality of the implementation approach, not just whether the final code eventually worked.

- **component_boundaries**: Did the plan identify the right files, modules, and ownership boundaries?
- **invariant_coverage**: Did it surface key constraints, compatibility requirements, rollout rules, or schema contracts?
- **sequencing_and_dependencies**: Did it order the work sensibly and account for blockers or downstream implications?
- **risk_and_validation_coverage**: Did it anticipate likely failure modes and how to verify the change?

Calibration:

- **High (0.8–1.0)**: The plan identified the right boundaries and invariants, sequenced the work well, and included meaningful validation.
- **Mid (0.5–0.7)**: The plan was serviceable but missed some dependencies, constraints, or verification steps.
- **Low (0.0–0.4)**: The plan sent implementation in the wrong direction, ignored key constraints, or omitted major validation and risk considerations.

Edge handling:

- If no plan artifact is available, infer planning quality from decomposition quality, rework signals, and whether the implementation path appears deliberate or thrashy.

#### `implementation`

Judge how well the code executed against the task and plan.

- **requirement_completeness**: Did the code cover the intended task scope?
- **correctness**: Did it behave correctly without human-found bugs?
- **integration_with_existing_patterns**: Did it fit the codebase's established architecture, schema, and rollout constraints?
- **code_quality_and_test_coverage**: Was the code clean, maintainable, and appropriately validated?

Calibration:

- **High (0.8–1.0)**: The implementation was complete, correct, well-integrated, and sufficiently validated.
- **Mid (0.5–0.7)**: The core task landed, but there were notable bugs, missing edge cases, weak integration choices, or incomplete validation.
- **Low (0.0–0.4)**: The implementation was substantially incomplete, incorrect, or required major human repair.

Attribution rule:

- Penalize implementation for code or behavior defects, missing requirements, or poor integration choices.
- Do not over-penalize implementation for failures that were primarily caused by a bad spec or bad plan; use the stage mix to tell that story.

#### `review`

Judge whether the workflow's review/self-check stage caught important issues before human intervention.

- **issue_detection**: Did review or self-review find substantive problems?
- **validation_depth**: Did the review process exercise the risky parts of the change, not just superficial checks?
- **regression_risk_coverage**: Did review reduce the chance of shipping a broken or incompatible change?
- **self_review_effectiveness**: Did the agent detect and address its own mistakes before human review had to do it?

Calibration:

- **High (0.8–1.0)**: Review caught important issues early or the evidence shows the change was already well-validated and low-risk.
- **Mid (0.5–0.7)**: Review provided some value but missed notable issues or left gaps that humans later had to catch.
- **Low (0.0–0.4)**: Review was absent or ineffective in a way that materially allowed bugs or regressions through.

Edge handling:

- If no self-review summary is available, infer review quality from PR review output, post-PR commits, and whether human review found functional issues.

### Stage Attribution Rules

- Stage scores must tell a coherent causal story about where quality was gained or lost.
- Stage scores do **not** need to match the overall score numerically.
- Every stage rationale must mention the dominant criteria, for example: requirement coverage, invariant coverage, correctness, regression-risk coverage.
- If evidence is sparse, say that the score is inferred and explain the inference briefly.

### Plan Critique

When `Implementation Plan` is available, also produce a top-level `planCritique` object that evaluates the plan directly.

Score each dimension from 0.0 to 1.0 and provide a 1-2 sentence rationale:

- `component_boundaries`
- `invariant_coverage`
- `approach_soundness`
- `missed_patches`
- `overall`

For `missed_patches`, use a high score when the implementation flowed cleanly from the plan and a low score when the implementation had to compensate for planning gaps.

If `Implementation Plan` is `Not available for this workflow.`, omit `planCritique` entirely.

---

## Rubric Criteria Scoring

In addition to the overall score, always include a top-level `rubricEval` object. This is the only machine-readable criterion-level rubric block. It must follow this exact shape:

```json
{
  "schema_version": "1.0",
  "rubric_version": "1.1",
  "criteria": {
    "completeness": { "score": 0.0, "rationale": "" },
    "correctness": { "score": 0.0, "rationale": "" },
    "code_quality": { "score": 0.0, "rationale": "" },
    "intervention_impact": { "score": 0.0, "rationale": "" },
    "autonomy": { "score": 0.0, "rationale": "" }
  },
  "determinative_boundary": "no_interventions"
}
```

Rubric version `1.1` added the `unverified_prediction` and `vacuous_safety_gate` determinative boundaries; existing records using `1.0` remain valid.

Do not add any extra keys inside `rubricEval`.

### Criterion Definitions

- **completeness**: Were all requirements in the task prompt addressed?
- **correctness**: Does the implementation work correctly based on the PR review?
- **code_quality**: Is the code clean, idiomatic, and aligned with project conventions?
- **intervention_impact**: Combined count and severity penalty. `1.0` means no interventions; lower scores reflect more severe intervention burden.
- **autonomy**: Holistic judgment of how independently the agent executed the task.

### `determinative_boundary`

Choose the scoring-boundary rule that was the binding constraint on the final score:

- `no_interventions`
- `cosmetic_only`
- `functional_bug`
- `multiple_bugs`
- `heavy_intervention`
- `unverified_prediction`
- `vacuous_safety_gate`

---

## Output Format

Respond with **only** a JSON object. No markdown fences. No preamble. No commentary outside the JSON.

Required top-level keys:

- `score`
- `rationale`
- `interventionFlags`
- `stageScores`
- `rubricEval`

Optional top-level key:

- `planCritique` only when an implementation plan is available

Schema requirements:

- `score` must be a number from `0.0` to `1.0`.
- `rationale` must be a concise 2-4 sentence explanation and must reference specific interventions when present.
- `interventionFlags` must be an array of strings and may be empty.
- `stageScores` must include all four stages: `expansion`, `plan`, `implementation`, `review`.
- Each stage entry must include `score` and `rationale`, and may include `rubricCriteria`.
- `rubricCriteria` must be an array of objects shaped as `{ "criterion": string, "score": number, "notes": string }`; `notes` is optional within each item.
- `rubricEval.schema_version` must be `"1.0"`.
- `rubricEval.rubric_version` should be `"1.1"` for new outputs; legacy `"1.0"` remains valid when parsing historical records.

### Output Template

```json
{
  "score": 0.0,
  "rationale": "",
  "interventionFlags": [],
  "stageScores": {
    "expansion": {
      "score": 0.0,
      "rationale": "",
      "rubricCriteria": [
        { "criterion": "requirement_coverage", "score": 0.0, "notes": "" }
      ]
    },
    "plan": {
      "score": 0.0,
      "rationale": "",
      "rubricCriteria": [
        { "criterion": "component_boundaries", "score": 0.0, "notes": "" }
      ]
    },
    "implementation": {
      "score": 0.0,
      "rationale": "",
      "rubricCriteria": [
        { "criterion": "requirement_completeness", "score": 0.0, "notes": "" }
      ]
    },
    "review": {
      "score": 0.0,
      "rationale": "",
      "rubricCriteria": [
        { "criterion": "issue_detection", "score": 0.0, "notes": "" }
      ]
    }
  },
  "planCritique": {
    "component_boundaries": { "score": 0.0, "rationale": "" },
    "invariant_coverage": { "score": 0.0, "rationale": "" },
    "approach_soundness": { "score": 0.0, "rationale": "" },
    "missed_patches": { "score": 0.0, "rationale": "" },
    "overall": { "score": 0.0, "rationale": "" }
  },
  "rubricEval": {
    "schema_version": "1.0",
    "rubric_version": "1.1",
    "criteria": {
      "completeness": { "score": 0.0, "rationale": "" },
      "correctness": { "score": 0.0, "rationale": "" },
      "code_quality": { "score": 0.0, "rationale": "" },
      "intervention_impact": { "score": 0.0, "rationale": "" },
      "autonomy": { "score": 0.0, "rationale": "" }
    },
    "determinative_boundary": "no_interventions"
  }
}
```

### Worked Calibration Example

This is an illustrative example of a mostly successful workflow where human review found one functional issue, so the overall score stays at or below `0.7` and the binding boundary is `functional_bug`.

```json
{
  "score": 0.7,
  "rationale": "The agent completed the core prompt rewrite and kept the output contract compatible, but a human review comment and post-PR fix were needed to correct a schema-misaligned stage-output detail. Because a human had to identify and fix a functional compatibility issue, the score is capped at 0.7. The final result is usable, but it was not fully autonomous.",
  "interventionFlags": [
    "review_comment:pointed out schema-misaligned stage output",
    "post_pr_commit:fixed parser-compatibility issue in prompt output"
  ],
  "stageScores": {
    "expansion": {
      "score": 0.88,
      "rationale": "Requirement coverage and rollout constraints were mostly clear, and the task framing pointed toward the correct prompt and schema surfaces.",
      "rubricCriteria": [
        { "criterion": "requirement_coverage", "score": 0.9, "notes": "The core prompt and parser requirements were identified." },
        { "criterion": "ambiguity_resolution", "score": 0.84, "notes": "Rollout compatibility was mostly resolved." },
        { "criterion": "implementation_guidance_quality", "score": 0.9, "notes": "The correct prompt and schema surfaces were named." },
        { "criterion": "validation_readiness", "score": 0.86, "notes": "Expected parser and schema checks were clear." }
      ]
    },
    "plan": {
      "score": 0.83,
      "rationale": "Component boundaries and invariant coverage were strong, but validation coverage did not fully protect against the stage-output compatibility mistake.",
      "rubricCriteria": [
        { "criterion": "component_boundaries", "score": 0.9, "notes": "The plan targeted prompt, parser, and schema layers." },
        { "criterion": "invariant_coverage", "score": 0.82, "notes": "Compatibility invariants were named but not fully guarded." },
        { "criterion": "sequencing_and_dependencies", "score": 0.85, "notes": "The implementation strategy was viable." },
        { "criterion": "risk_and_validation_coverage", "score": 0.74, "notes": "Testing missed one stage-output compatibility case." }
      ]
    },
    "implementation": {
      "score": 0.68,
      "rationale": "Requirement completeness was high, but correctness and integration with the persisted schema were weakened by the compatibility bug that required human correction.",
      "rubricCriteria": [
        { "criterion": "requirement_completeness", "score": 0.88, "notes": "Most requested prompt and schema changes landed." },
        { "criterion": "correctness", "score": 0.62, "notes": "A compatibility bug required human correction." },
        { "criterion": "integration_with_existing_patterns", "score": 0.66, "notes": "The persisted schema contract was not fully aligned initially." },
        { "criterion": "code_quality_and_test_coverage", "score": 0.78, "notes": "The final structure remained understandable and testable." }
      ]
    },
    "review": {
      "score": 0.79,
      "rationale": "Review eventually detected the functional issue, which helped contain regression risk, but self-review effectiveness was incomplete because the bug escaped to human review.",
      "rubricCriteria": [
        { "criterion": "issue_detection", "score": 0.82, "notes": "The compatibility issue was eventually found." },
        { "criterion": "validation_depth", "score": 0.78, "notes": "Regression risk was contained after review." },
        { "criterion": "self_review_effectiveness", "score": 0.72, "notes": "The issue escaped initial self-review." },
        { "criterion": "regression_risk_coverage", "score": 0.84, "notes": "The correction was focused and verifiable." }
      ]
    }
  },
  "planCritique": {
    "component_boundaries": {
      "score": 0.9,
      "rationale": "The plan identified the prompt and schema contract surfaces that mattered."
    },
    "invariant_coverage": {
      "score": 0.82,
      "rationale": "The plan captured the need to stay aligned with the persisted output shape, though validation could have been more explicit."
    },
    "approach_soundness": {
      "score": 0.85,
      "rationale": "The prompt-first strategy was viable and appropriately scoped."
    },
    "missed_patches": {
      "score": 0.7,
      "rationale": "Implementation needed a focused follow-up patch after a compatibility gap surfaced."
    },
    "overall": {
      "score": 0.82,
      "rationale": "The plan was strong overall but did not fully prevent the downstream compatibility miss."
    }
  },
  "rubricEval": {
    "schema_version": "1.0",
    "rubric_version": "1.1",
    "criteria": {
      "completeness": {
        "score": 0.9,
        "rationale": "The core prompt rewrite and rollout requirements were largely delivered."
      },
      "correctness": {
        "score": 0.68,
        "rationale": "A human-found compatibility bug prevented a higher correctness score."
      },
      "code_quality": {
        "score": 0.84,
        "rationale": "The final prompt structure was organized and aligned with the intended contract."
      },
      "intervention_impact": {
        "score": 0.66,
        "rationale": "Human review and a post-PR fix materially reduced autonomous success."
      },
      "autonomy": {
        "score": 0.7,
        "rationale": "The agent did most of the work but still required human identification of a functional issue."
      }
    },
    "determinative_boundary": "functional_bug"
  }
}
```

This second illustrative example shows how to score an unreproduced "fails its own tests" claim as a capped hypothesis rather than a decisive correctness failure.

```json
{
  "score": 0.84,
  "rationale": "The implementation evidence is largely positive, and the negative review claim is a prediction rather than a reproduced test failure. Because the dominant negative signal lacks verbatim failing output or explicit test counts, it can only move the score slightly. The result therefore stays in the minor-feedback band unless stronger defects are present.",
  "interventionFlags": [
    "review_comment:predicted test failure without transcript"
  ],
  "stageScores": {
    "expansion": {
      "score": 0.86,
      "rationale": "Requirement coverage and validation guidance were clear enough to frame the task correctly."
    },
    "plan": {
      "score": 0.83,
      "rationale": "The plan identified the relevant verification surfaces and core gate behavior."
    },
    "implementation": {
      "score": 0.87,
      "rationale": "The implementation appears complete and aligned with the intended gate, with no reproduced failure in the evidence."
    },
    "review": {
      "score": 0.62,
      "rationale": "Review raised a plausible concern, but it did not supply the transcript needed to make the claim determinative."
    }
  },
  "rubricEval": {
    "schema_version": "1.0",
    "rubric_version": "1.1",
    "criteria": {
      "completeness": {
        "score": 0.88,
        "rationale": "The task scope appears to be covered."
      },
      "correctness": {
        "score": 0.82,
        "rationale": "No failing transcript or direct fixture mismatch demonstrates the predicted defect."
      },
      "code_quality": {
        "score": 0.84,
        "rationale": "The change fits expected project patterns based on the available evidence."
      },
      "intervention_impact": {
        "score": 0.8,
        "rationale": "There was reviewer skepticism, but not a reproduced functional fix."
      },
      "autonomy": {
        "score": 0.83,
        "rationale": "The workflow remained mostly autonomous because the main negative claim was not verified."
      }
    },
    "determinative_boundary": "unverified_prediction"
  }
}
```

Output only the JSON object for the actual evaluation.
