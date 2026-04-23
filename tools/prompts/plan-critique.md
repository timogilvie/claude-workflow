# Plan Critique

You are evaluating the quality of a software implementation plan. Judge the plan directly rather than inferring quality only from whether the final implementation succeeded.

You will receive:

- The original task prompt
- The implementation plan
- Optionally, the final PR diff or review summary for evidence about whether the implementation had to patch around planning gaps

Score the plan on the following dimensions from 0.0 to 1.0. For each dimension, provide a concise 1-2 sentence rationale grounded in the provided materials.

## Dimensions

- `component_boundaries`: Did the plan identify the correct files, modules, systems, or ownership boundaries for the work?
- `invariant_coverage`: Did the plan identify important constraints, invariants, edge cases, or compatibility requirements that the implementation needed to respect?
- `approach_soundness`: Was the proposed approach technically viable, correctly scoped, and likely to solve the stated task?
- `missed_patches`: Did the implementation evidence suggest the plan had gaps that later required patching around, extra fixes, or directional corrections?
- `overall`: Aggregate quality of the plan based on the dimensions above.

## Scoring Guidance

- `1.0`: Clear, correct, and actionable. The implementation could proceed with little ambiguity or patch-up work.
- `0.7-0.9`: Mostly strong plan with minor omissions or uncertainty, but still a good guide for implementation.
- `0.4-0.6`: Mixed quality. Some useful direction, but important boundaries, constraints, or approach details were missing or shaky.
- `0.0-0.3`: Poor plan. Misidentified the work, missed critical invariants, or proposed an unsound approach.

For `missed_patches`, assign a high score when the implementation evidence shows the plan held up well. Assign a low score when the implementation had to compensate for plan mistakes or omissions.

## Input

### Original Task Prompt

{{TASK_PROMPT}}

### Implementation Plan

{{PLAN_CONTENT}}

### PR Diff / Review Output (optional)

{{PR_DIFF}}

## Output Format

Respond with only a JSON object:

```json
{
  "planCritique": {
    "component_boundaries": { "score": 0.0, "rationale": "" },
    "invariant_coverage": { "score": 0.0, "rationale": "" },
    "approach_soundness": { "score": 0.0, "rationale": "" },
    "missed_patches": { "score": 0.0, "rationale": "" },
    "overall": { "score": 0.0, "rationale": "" }
  }
}
```

Output only valid JSON. No markdown fences or extra commentary.
