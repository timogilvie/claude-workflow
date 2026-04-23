# Plan Critique — Evaluating Implementation Plan Quality

You are an expert evaluator assessing the quality of an implementation plan for a software engineering task. You will be given the original task prompt, the implementation plan, and optionally the PR diff showing what was actually implemented.

Evaluate the plan across **four dimensions**, each scored on a scale of **0.0 to 1.0**.

---

## Scoring Dimensions

### 1. Component Boundaries (component_boundaries)

Did the plan correctly identify which components, modules, or files needed to be modified?

**Scoring guidelines:**
- **1.0**: Plan identified exactly the right components with no false positives or missed areas
- **0.7-0.9**: Plan identified most key components but missed 1-2 secondary areas or included unnecessary targets
- **0.4-0.6**: Plan had significant gaps (missed major components) or false positives (targeted wrong areas)
- **0.0-0.3**: Plan fundamentally misidentified the component boundary or targeted the wrong subsystems

**When PR_DIFF is available:** Compare planned file changes to actual file changes. Perfect match = 1.0, missing files or extra files reduce the score.

**When PR_DIFF is NOT available:** Evaluate based on whether the plan's component analysis is sound given the task requirements.

---

### 2. Invariant Coverage (invariant_coverage)

Did the plan identify critical constraints, edge cases, and invariants that the implementation must respect?

**Scoring guidelines:**
- **1.0**: Plan documented all critical constraints and invariants; no surprises in implementation
- **0.7-0.9**: Plan captured most key constraints but missed 1-2 non-obvious edge cases
- **0.4-0.6**: Plan missed several important constraints or edge cases that would impact correctness
- **0.0-0.3**: Plan failed to identify major invariants, leading to incorrect or risky implementation

**Examples of invariants:**
- Data format constraints (nullable fields, type safety)
- Ordering dependencies (X must happen before Y)
- Concurrency constraints (locks, race conditions)
- Backward compatibility requirements
- Performance requirements

**When PR_DIFF is available:** Check if the implementation had to add defensive checks, validation, or error handling not mentioned in the plan — these indicate missed invariants.

---

### 3. Approach Soundness (approach_soundness)

Was the proposed implementation approach technically viable and correct?

**Scoring guidelines:**
- **1.0**: Approach is optimal or near-optimal; implementation could follow the plan directly
- **0.7-0.9**: Approach is sound but suboptimal; minor adjustments needed during implementation
- **0.4-0.6**: Approach has notable issues (inefficient, brittle, or partially incorrect) requiring rework
- **0.0-0.3**: Approach is fundamentally flawed or infeasible; implementation had to take a different path

**Consider:**
- Algorithmic correctness
- Architectural alignment with existing codebase patterns
- Scalability and performance implications
- Maintainability and clarity

**When PR_DIFF is available:** Check if the implementation followed the planned approach or had to deviate significantly.

---

### 4. Missed Patches (missed_patches)

Did the implementation have to work around gaps or errors in the plan?

**Scoring guidelines:**
- **1.0**: Implementation followed the plan directly with no patches or workarounds
- **0.7-0.9**: Implementation needed 1-2 minor additions not covered by the plan (small helpers, utilities)
- **0.4-0.6**: Implementation had to patch around multiple plan gaps or fix plan errors
- **0.0-0.3**: Implementation largely diverged from the plan due to plan inadequacy

**Indicators of missed patches:**
- Bug fixes in commits following initial implementation
- Additional files or functions not mentioned in the plan
- Error handling or validation added ad-hoc during implementation
- Refactoring commits that restructure what the plan described

**When PR_DIFF is available:** Analyze commit messages and diff hunks for signs of unplanned work.

**When PR_DIFF is NOT available:** Score based on completeness of the plan — does it feel like a complete blueprint, or are there obvious gaps?

---

## Overall Score

In addition to the four dimension scores, provide an **overall plan quality score** that aggregates the dimensions. The overall score is NOT a simple average — weight it based on which dimensions matter most for autonomous execution success.

**Suggested weighting:**
- High `component_boundaries` + high `invariant_coverage` → strong foundation, weight these heavily
- Low `missed_patches` → plan was actionable, reward this
- `approach_soundness` gates correctness — low soundness caps overall score regardless of other dimensions

---

## Input

### Original Task Prompt

{{TASK_PROMPT}}

### Implementation Plan

{{PLAN_CONTENT}}

### PR Diff (optional)

{{PR_DIFF}}

---

## Output Format

Respond with **only** a JSON object (no markdown fences, no preamble):

```
{
  "planCritique": {
    "component_boundaries": {
      "score": <0.0-1.0>,
      "rationale": "<1-2 sentences explaining the score>"
    },
    "invariant_coverage": {
      "score": <0.0-1.0>,
      "rationale": "<1-2 sentences explaining the score>"
    },
    "approach_soundness": {
      "score": <0.0-1.0>,
      "rationale": "<1-2 sentences explaining the score>"
    },
    "missed_patches": {
      "score": <0.0-1.0>,
      "rationale": "<1-2 sentences explaining the score>"
    },
    "overall": {
      "score": <0.0-1.0>,
      "rationale": "<2-3 sentences summarizing overall plan quality>"
    }
  }
}
```

Output ONLY the JSON object. No other text.
