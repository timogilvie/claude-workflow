"""Planner evaluator — planning quality proxy scoring.

Evaluates planning effectiveness using proxy signals since only 6 records
have direct plan stageScores. Uses overall workflow success + intervention
patterns as indicators of plan quality.

Proxy signal: Tasks that succeeded without interventions likely had good plans.
Tasks that required significant rework likely had poor plans.

Scoring:
  - Primary: Correlation between predicted plan quality and actual outcome
  - Success signal: high score + low interventions = good plan
  - Failure signal: low score OR many interventions = poor plan
  - Bonus: +0.1 if predicted band matches derived band
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from data_loader import EvalExample, default_evals_path, load_eval_examples, stratified_split
from llm_caller import call_llm
from template_utils import fill_template


# Plan quality bands (derived from workflow outcome)
PLAN_BANDS = {
    "excellent": (0.9, 1.0),
    "good": (0.7, 0.9),
    "weak": (0.4, 0.7),
    "poor": (0.0, 0.4),
}


def score_to_plan_band(score: float) -> str:
    """Map a derived plan quality score to its band."""
    for band, (low, high) in PLAN_BANDS.items():
        if low <= score <= high:
            return band
    return "unknown"


def derive_plan_quality(example: EvalExample) -> dict:
    """Derive plan quality from workflow outcome signals.

    Uses a composite of:
    - Overall workflow score (primary signal)
    - Intervention count (plans that needed rework are weaker)
    - Whether implementation score exceeded overall score (plan was good but
      execution had issues = OK plan; plan was weak leading to poor execution = bad plan)
    """
    # Check for direct plan stageScore first
    stages = example.metadata.get("stageScores", {})
    if "plan" in stages and isinstance(stages["plan"], dict):
        plan_data = stages["plan"]
        if isinstance(plan_data.get("score"), (int, float)):
            return {
                "score": plan_data["score"],
                "rationale": plan_data.get("rationale", "Direct judge score"),
                "band": score_to_plan_band(plan_data["score"]),
                "source": "direct",
            }

    # Derive from proxy signals
    base_score = example.score

    # Intervention penalty: each intervention suggests plan gaps
    intervention_penalty = min(0.3, example.intervention_count * 0.1)

    # Implementation vs overall: if impl was high but overall was low,
    # the plan was likely fine (issue was elsewhere)
    impl_data = stages.get("implementation", {})
    impl_score = impl_data.get("score") if isinstance(impl_data, dict) else None

    impl_bonus = 0.0
    if impl_score is not None and isinstance(impl_score, (int, float)):
        if impl_score > base_score + 0.1:
            # Implementation exceeded overall — plan probably wasn't the bottleneck
            impl_bonus = 0.1
        elif impl_score < base_score - 0.1:
            # Implementation underperformed — plan may have been overambitious
            impl_bonus = -0.05

    derived = max(0.0, min(1.0, base_score - intervention_penalty + impl_bonus))

    return {
        "score": derived,
        "rationale": f"Derived: base={base_score:.2f}, interventions=-{intervention_penalty:.2f}, impl_adj={impl_bonus:+.2f}",
        "band": score_to_plan_band(derived),
        "source": "derived",
    }


# Default planner evaluation prompt
DEFAULT_PLANNER_EVAL_PROMPT = """You are evaluating the quality of an AI planning agent's work.

Given a task description and context about the workflow outcome, assess how well the planning phase was executed.

## Task Description

{{TASK_PROMPT}}

## Workflow Outcome

Repository: {{REPO_NAME}}
Overall workflow score: {{OVERALL_SCORE}} ({{SCORE_BAND}})
Intervention count: {{INTERVENTION_COUNT}}
Intervention details: {{INTERVENTION_DETAILS}}

Judge rationale: {{JUDGE_RATIONALE}}

## What Makes a Good Plan

A good plan:
- Correctly identifies the scope and key files to modify
- Breaks work into logical, ordered phases
- Anticipates edge cases and constraints
- Doesn't overscope or underscope the work
- Leads to smooth implementation without rework

A poor plan:
- Misses critical requirements or files
- Has incorrect dependencies or ordering
- Overscopes (leads to unnecessary work)
- Underscopes (misses requirements, causing rework)
- Leads to interventions during implementation

## Scoring Guidelines

- **0.9-1.0 (Excellent)**: Plan was comprehensive and accurate. Implementation flowed smoothly.
- **0.7-0.9 (Good)**: Plan was mostly correct. Minor gaps but didn't cause significant issues.
- **0.4-0.7 (Weak)**: Plan had gaps that required rework or interventions.
- **0.0-0.4 (Poor)**: Plan was inadequate. Major rework, wrong approach, or missed requirements.

## Output

Respond with ONLY a valid JSON object (no markdown fences):

{"plan_score": <float 0.0-1.0>, "quality_band": "excellent|good|weak|poor", "reasoning": "<1-2 sentence explanation>"}"""


def build_planner_input(example: EvalExample) -> dict[str, str]:
    """Build template variables for the planner evaluation prompt."""
    return {
        "TASK_PROMPT": example.original_prompt[:2000],
        "REPO_NAME": example.source_repo or "unknown",
        "OVERALL_SCORE": f"{example.score:.2f}",
        "SCORE_BAND": example.score_band,
        "INTERVENTION_COUNT": str(example.intervention_count),
        "INTERVENTION_DETAILS": json.dumps(example.intervention_details[:5], indent=2),
        "JUDGE_RATIONALE": example.rationale[:1000] if example.rationale else "Not available",
    }


def parse_planner_output(output: str) -> dict:
    """Parse the planner evaluator's JSON response."""
    cleaned = re.sub(r"^```(?:json)?\s*", "", output.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    for candidate in [cleaned]:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{[\s\S]*\}", output)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return {"plan_score": -1, "quality_band": "unknown", "reasoning": "Parse failed"}


def score_plan_agreement(predicted: float, ground_truth: float) -> dict[str, float]:
    """Score agreement between predicted and derived plan quality."""
    if predicted < 0:
        return {"score_diff": 1.0, "band_match": 0.0, "overall": 0.0}

    score_diff = abs(predicted - ground_truth)
    base_score = 1.0 - score_diff

    pred_band = score_to_plan_band(predicted)
    truth_band = score_to_plan_band(ground_truth)
    band_match = float(pred_band == truth_band)

    overall = min(1.0, max(0.0, base_score + (0.1 * band_match)))

    return {
        "score_diff": score_diff,
        "band_match": band_match,
        "predicted_band": pred_band,
        "truth_band": truth_band,
        "overall": overall,
    }


def evaluate_planner(
    candidate_prompt: str,
    example: EvalExample,
    model: str = "claude-sonnet-4-5-20250929",
    use_api: bool = False,
) -> dict:
    """Evaluate a candidate planner evaluation prompt on a single example."""
    ground_truth = derive_plan_quality(example)

    inputs = build_planner_input(example)
    filled = fill_template(candidate_prompt, inputs)
    output = call_llm(filled, model=model, use_api=use_api)

    result = parse_planner_output(output)
    predicted_score = result.get("plan_score", -1)

    agreement = score_plan_agreement(
        predicted=predicted_score,
        ground_truth=ground_truth["score"],
    )

    return {
        **agreement,
        "predicted_score": predicted_score,
        "ground_truth_score": ground_truth["score"],
        "ground_truth_band": ground_truth["band"],
        "ground_truth_source": ground_truth["source"],
        "example_id": example.id,
        "parse_error": predicted_score < 0,
    }


def planner_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the planner evaluator."""
    try:
        predicted = float(prediction.plan_score)
    except (AttributeError, ValueError, TypeError):
        return 0.0

    ground_truth = float(example.ground_truth_plan_score)
    return 1.0 - abs(predicted - ground_truth)


def run_evaluation(
    prompt_file: str | None = None,
    evals_path: str | None = None,
    skip_aggregate: bool = False,
    use_api: bool = False,
    model: str = "claude-sonnet-4-5-20250929",
    dry_run: bool = False,
) -> dict:
    """Run the full planner evaluation."""
    if prompt_file:
        candidate_prompt = Path(prompt_file).read_text()
    else:
        candidate_prompt = DEFAULT_PLANNER_EVAL_PROMPT

    path = Path(evals_path) if evals_path else default_evals_path()
    examples = load_eval_examples(path, skip_aggregate=skip_aggregate)
    _, val = stratified_split(examples)

    # Use all val examples (derive plan quality for each)
    print(f"Planner Evaluator")
    print(f"  Total examples: {len(examples)}")
    print(f"  Val set: {len(val)}")

    # Count direct vs derived ground truth
    direct_count = sum(1 for ex in val if derive_plan_quality(ex)["source"] == "direct")
    print(f"  Direct plan stageScores: {direct_count}")
    print(f"  Derived plan quality: {len(val) - direct_count}")

    if dry_run:
        bands: dict[str, int] = {}
        for ex in val:
            gt = derive_plan_quality(ex)
            bands[gt["band"]] = bands.get(gt["band"], 0) + 1
        print(f"  Plan quality bands: {dict(sorted(bands.items()))}")
        return {"dry_run": True, "total": len(examples), "val": len(val), "direct": direct_count}

    # Evaluate on validation set
    results = []
    for i, ex in enumerate(val):
        gt = derive_plan_quality(ex)
        print(f"  [{i+1}/{len(val)}] {ex.issue_id or ex.id[:8]}... (gt={gt['score']:.2f} [{gt['source']}])", end=" ", flush=True)
        try:
            result = evaluate_planner(candidate_prompt, ex, model=model, use_api=use_api)
            results.append(result)
            pred = result["predicted_score"]
            print(f"pred={pred:.2f} diff={result['score_diff']:.2f} agree={result['overall']:.2f}")
        except Exception as e:
            print(f"ERROR: {e}")
            results.append({"overall": 0.0, "error": str(e), "example_id": ex.id})

    scores = [r["overall"] for r in results]
    diffs = [r.get("score_diff", 1.0) for r in results]
    band_matches = sum(r.get("band_match", 0) for r in results)
    parse_errors = sum(1 for r in results if r.get("parse_error"))

    summary = {
        "evaluator": "planner",
        "n_examples": len(results),
        "mean_agreement": sum(scores) / len(scores) if scores else 0,
        "mean_score_diff": sum(diffs) / len(diffs) if diffs else 1.0,
        "band_match_rate": band_matches / len(results) if results else 0,
        "parse_error_rate": parse_errors / len(results) if results else 0,
        "direct_ground_truth": direct_count,
        "derived_ground_truth": len(val) - direct_count,
    }

    print(f"\n  Mean agreement: {summary['mean_agreement']:.3f}")
    print(f"  Mean score diff: {summary['mean_score_diff']:.3f}")
    print(f"  Band match rate: {summary['band_match_rate']:.1%}")
    if parse_errors:
        print(f"  Parse errors: {parse_errors}/{len(results)}")

    return summary


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate planner prompt")
    parser.add_argument("--prompt-file", help="Path to candidate planner eval prompt")
    parser.add_argument("--evals", help="Path to aggregated evals JSONL")
    parser.add_argument("--skip-aggregate", action="store_true")
    parser.add_argument("--use-api", action="store_true")
    parser.add_argument("--model", default="claude-sonnet-4-5-20250929")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    result = run_evaluation(
        prompt_file=args.prompt_file,
        evals_path=args.evals,
        skip_aggregate=args.skip_aggregate,
        use_api=args.use_api,
        model=args.model,
        dry_run=args.dry_run,
    )

    if not args.dry_run:
        import json as _json
        print(f"\n{_json.dumps({k: v for k, v in result.items() if k != 'results'}, indent=2)}")
