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

try:
    import dspy

    class PlannerEvaluatorSignature(dspy.Signature):
        """Assess the quality of an AI planning agent's work against the production rubric.

        Score the plan stage using production rubric criteria from eval-judge.md:
        - component_boundaries: Did the plan identify the right files, modules, and ownership boundaries?
        - invariant_coverage: Did it surface key constraints, compatibility requirements, rollout rules, or schema contracts?
        - sequencing_and_dependencies: Did it order the work sensibly and account for blockers or downstream implications?
        - risk_and_validation_coverage: Did it anticipate likely failure modes and how to verify the change?

        calibration: excellent=0.9-1.0, good=0.7-0.9, weak=0.4-0.7, poor=0.0-0.4"""

        task_prompt: str = dspy.InputField(desc="The task description/ticket")
        repo_name: str = dspy.InputField(desc="Target repository name")
        overall_score: str = dspy.InputField(desc="Workflow outcome score (0-1)")
        intervention_count: str = dspy.InputField(desc="Number of human interventions needed")
        judge_rationale: str = dspy.InputField(desc="Eval judge's rationale for the overall score")

        plan_score: float = dspy.OutputField(desc="Plan quality score (0.0-1.0)")
        quality_band: str = dspy.OutputField(desc="Quality band: excellent, good, weak, or poor")
        reasoning: str = dspy.OutputField(desc="1-2 sentence explanation citing the strongest rubric criteria drivers")
        component_boundaries: float = dspy.OutputField(
            desc="Score 0.0-1.0: did the plan identify the right files, modules, and ownership boundaries?"
        )
        invariant_coverage: float = dspy.OutputField(
            desc="Score 0.0-1.0: did it surface key constraints, compatibility requirements, rollout rules, or schema contracts?"
        )
        sequencing_and_dependencies: float = dspy.OutputField(
            desc="Score 0.0-1.0: did it order the work sensibly and account for blockers or downstream implications?"
        )
        risk_and_validation_coverage: float = dspy.OutputField(
            desc="Score 0.0-1.0: did it anticipate likely failure modes and how to verify the change?"
        )

except ImportError:
    PlannerEvaluatorSignature = None


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


# Default planner evaluation prompt.
# Source of truth: tools/prompts/eval-judge.md. DSPy parser strategy:
# preserve runner-facing score fields and tolerate extra rubric fields.
DEFAULT_PLANNER_EVAL_PROMPT = """You are evaluating the quality of an AI planning agent's work using the production rubric contract.

Given a task description and context about the workflow outcome, assess how well the planning phase was executed.

## Task Description

{{TASK_PROMPT}}

## Workflow Outcome

Repository: {{REPO_NAME}}
Overall workflow score: {{OVERALL_SCORE}} ({{SCORE_BAND}})
Intervention count: {{INTERVENTION_COUNT}}
Intervention details: {{INTERVENTION_DETAILS}}

Production judge rationale: {{JUDGE_RATIONALE}}

## Planning Rubric

Score only the planning stage. Use these production stage criteria:

- **component_boundaries**: Did the plan identify the right files, modules, ownership boundaries, and integration points?
- **invariant_coverage**: Did the plan preserve important behavioral, data, API, and compatibility constraints?
- **sequencing_and_dependencies**: Did the plan order the work coherently and account for dependencies between steps?
- **risk_and_validation_coverage**: Did the plan call out meaningful risks, edge cases, tests, and validation steps?

Calibrate against the workflow outcome and intervention details, but do not score implementation quality directly. Strong plans make the correct scope and validation strategy clear enough that implementation can proceed with minimal rework. Weak plans miss key requirements, rely on incorrect sequencing, ignore constraints, or cause later interventions.

## Score Bands

- **0.9-1.0 (excellent)**: Comprehensive, well-scoped, correctly sequenced plan with strong invariant and validation coverage.
- **0.7-0.9 (good)**: Mostly correct plan with minor gaps that would not materially derail implementation.
- **0.4-0.7 (weak)**: Meaningful gaps in scope, ordering, constraints, or validation that plausibly caused rework.
- **0.0-0.4 (poor)**: Missing or misleading plan, wrong approach, or major omissions that would require substantial intervention.

## Production Rubric Alignment

The production eval judge also records rubricEval criteria named `completeness`, `correctness`, `code_quality`, `intervention_impact`, and `autonomy`. You may include a compact `rubricEval` object using those names, and you may include `stageScores.plan`, but the runner-facing fields below are required.

## Output

Respond with ONLY a valid JSON object (no markdown fences):

{"plan_score": <float 0.0-1.0>, "quality_band": "excellent|good|weak|poor", "reasoning": "<1-2 sentence explanation>", "component_boundaries": <float 0.0-1.0>, "invariant_coverage": <float 0.0-1.0>, "sequencing_and_dependencies": <float 0.0-1.0>, "risk_and_validation_coverage": <float 0.0-1.0>, "stageScores": {"plan": {"score": <same float>, "rationale": "<optional rubric rationale>", "rubricCriteria": [{"criterion": "component_boundaries", "score": <float 0.0-1.0>, "rationale": "<optional>"}, {"criterion": "invariant_coverage", "score": <float 0.0-1.0>, "rationale": "<optional>"}, {"criterion": "sequencing_and_dependencies", "score": <float 0.0-1.0>, "rationale": "<optional>"}, {"criterion": "risk_and_validation_coverage", "score": <float 0.0-1.0>, "rationale": "<optional>"}]}}, "rubricEval": {"completeness": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "correctness": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "code_quality": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "intervention_impact": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "autonomy": {"score": <float 0.0-1.0>, "rationale": "<optional>"}}}

`stageScores` and `rubricEval` are optional extra fields. `plan_score`, `quality_band`, `reasoning`, and the four planning criterion scores are always required."""


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


def _planner_parse_error(reason: str = "Parse failed") -> dict:
    return {"plan_score": -1, "quality_band": "unknown", "reasoning": reason}


def _coerce_score(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _extract_json_object(output: str) -> dict | None:
    cleaned = re.sub(r"^```(?:json)?\s*", "", output.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    for candidate in [cleaned]:
        try:
            data = json.loads(candidate)
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{[\s\S]*\}", output)
    if match:
        try:
            data = json.loads(match.group())
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            pass

    return None


def parse_planner_output(output: str) -> dict:
    """Parse and normalize the planner evaluator's JSON response."""
    data = _extract_json_object(output)
    if data is None:
        return _planner_parse_error()

    stage_scores = data.get("stageScores", {})
    if not isinstance(stage_scores, dict):
        stage_scores = {}
    stage_plan = stage_scores.get("plan", {})
    if not isinstance(stage_plan, dict):
        stage_plan = {}

    score = _coerce_score(data.get("plan_score")) if "plan_score" in data else None
    if "plan_score" in data and score is None:
        return _planner_parse_error("Parse failed: missing numeric plan_score")
    if "plan_score" not in data:
        score = _coerce_score(stage_plan.get("score"))
    if score is None:
        return _planner_parse_error("Parse failed: missing numeric plan_score")

    data["plan_score"] = score

    if not data.get("quality_band"):
        data["quality_band"] = score_to_plan_band(score)

    if not data.get("reasoning"):
        rationale = stage_plan.get("rationale")
        data["reasoning"] = rationale if isinstance(rationale, str) and rationale else "No reasoning provided"

    return data


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


PLANNER_RUBRIC_FIELDS = [
    "component_boundaries",
    "invariant_coverage",
    "sequencing_and_dependencies",
    "risk_and_validation_coverage",
]


def planner_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the planner evaluator."""
    try:
        predicted = float(prediction.plan_score)
    except (AttributeError, ValueError, TypeError):
        return 0.0

    ground_truth = float(example.ground_truth_plan_score)
    score_agreement = 1.0 - abs(predicted - ground_truth)

    rubric_agreements = []
    for field in PLANNER_RUBRIC_FIELDS:
        gt_val = getattr(example, field, None)
        pred_val = getattr(prediction, field, None)
        if gt_val is not None and pred_val is not None:
            try:
                rubric_agreements.append(1.0 - abs(float(pred_val) - float(gt_val)))
            except (TypeError, ValueError):
                pass

    if rubric_agreements:
        rubric_score = sum(rubric_agreements) / len(rubric_agreements)
        return 0.6 * score_agreement + 0.4 * rubric_score

    return score_agreement


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
