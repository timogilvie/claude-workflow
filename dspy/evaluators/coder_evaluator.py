"""Coder evaluator — implementation quality scoring.

Evaluates how well a coding phase prompt leads to correct, complete implementations.
Uses stageScores.implementation from the eval judge as ground truth signal.

Ground truth: 95 records have implementation stageScores from the eval judge.

Scoring:
  - Primary: 1.0 - abs(predicted_impl_score - ground_truth_impl_score)
  - Bonus: +0.1 if both scores are in the same quality band
  - Penalty: -0.15 if predicted score is high but actual had interventions
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from data_loader import EvalExample, default_evals_path, load_eval_examples, stratified_split
from evaluator_utils import coerce_score, extract_json_object
from llm_caller import call_llm
from template_utils import fill_template


# Quality bands for implementation scores
IMPL_BANDS = {
    "excellent": (0.9, 1.0),
    "good": (0.7, 0.9),
    "acceptable": (0.5, 0.7),
    "poor": (0.0, 0.5),
}


def score_to_impl_band(score: float) -> str:
    """Map a numeric score to its implementation quality band."""
    for band, (low, high) in IMPL_BANDS.items():
        if low <= score <= high:
            return band
    return "unknown"


def filter_with_impl_scores(examples: list[EvalExample]) -> list[EvalExample]:
    """Filter to only examples that have implementation stageScores."""
    filtered = []
    for ex in examples:
        stages = ex.metadata.get("stageScores", {})
        if "implementation" in stages and isinstance(stages["implementation"], dict):
            impl = stages["implementation"]
            if isinstance(impl.get("score"), (int, float)):
                filtered.append(ex)
    return filtered


def get_impl_ground_truth(example: EvalExample) -> dict:
    """Extract implementation ground truth from metadata."""
    stages = example.metadata.get("stageScores", {})
    impl = stages.get("implementation", {})
    return {
        "score": impl.get("score", 0.0),
        "rationale": impl.get("rationale", ""),
        "band": score_to_impl_band(impl.get("score", 0.0)),
    }


# Default coder evaluation prompt.
# Source of truth: tools/prompts/eval-judge.md. DSPy parser strategy:
# preserve runner-facing score fields and tolerate extra rubric fields.
DEFAULT_CODER_EVAL_PROMPT = """You are evaluating the quality of an AI coding agent's implementation using the production rubric contract.

Given a task description and context about the implementation outcome, score the implementation quality.

## Task Description

{{TASK_PROMPT}}

## Implementation Context

Repository: {{REPO_NAME}}
Model used: {{MODEL_ID}}
Overall workflow score: {{OVERALL_SCORE}}
Intervention count: {{INTERVENTION_COUNT}}
Intervention details: {{INTERVENTION_DETAILS}}

Production judge rationale: {{JUDGE_RATIONALE}}

## Implementation Rubric

Score the implementation stage specifically, not the overall workflow. Use these production stage criteria:

- **requirement_completeness**: Did the code cover the intended task scope without missing requested behavior?
- **correctness**: Does the implementation behave correctly, handle important edge cases, and avoid regressions?
- **integration_with_existing_patterns**: Does the code fit existing architecture, APIs, conventions, and ownership boundaries?
- **code_quality_and_test_coverage**: Is the solution maintainable, appropriately simple, and validated by relevant tests or checks?

Calibrate against the overall score, interventions, and production judge rationale. Interventions should lower the score when they indicate missing requirements, incorrect code, integration issues, or inadequate validation.

## Score Bands

- **0.9-1.0 (excellent)**: Complete, correct, well-integrated implementation with strong quality and validation.
- **0.7-0.9 (good)**: Mostly correct implementation with minor gaps or limited but acceptable validation.
- **0.5-0.7 (acceptable)**: Partially successful implementation with notable omissions, edge-case gaps, or quality concerns.
- **0.0-0.5 (poor)**: Major correctness, completeness, integration, or validation failures.

## Production Rubric Alignment

The production eval judge also records rubricEval criteria named `completeness`, `correctness`, `code_quality`, `intervention_impact`, and `autonomy`. You may include a compact `rubricEval` object using those names, and you may include `stageScores.implementation`, but the runner-facing fields below are required.

## Output

Respond with ONLY a valid JSON object (no markdown fences):

{"implementation_score": <float 0.0-1.0>, "quality_band": "excellent|good|acceptable|poor", "reasoning": "<1-2 sentence explanation>", "stageScores": {"implementation": {"score": <same float>, "rationale": "<optional rubric rationale>"}}, "rubricEval": {"completeness": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "correctness": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "code_quality": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "intervention_impact": {"score": <float 0.0-1.0>, "rationale": "<optional>"}, "autonomy": {"score": <float 0.0-1.0>, "rationale": "<optional>"}}}

`stageScores` and `rubricEval` are optional extra fields. `implementation_score`, `quality_band`, and `reasoning` are always required."""


def build_coder_input(example: EvalExample) -> dict[str, str]:
    """Build template variables for the coder evaluation prompt."""
    return {
        "TASK_PROMPT": example.original_prompt[:2000],
        "REPO_NAME": example.source_repo or "unknown",
        "MODEL_ID": example.model_id or "unknown",
        "OVERALL_SCORE": f"{example.score:.2f}",
        "INTERVENTION_COUNT": str(example.intervention_count),
        "INTERVENTION_DETAILS": json.dumps(example.intervention_details[:5], indent=2),
        "JUDGE_RATIONALE": example.rationale[:1000] if example.rationale else "Not available",
    }


def _coder_parse_error(reason: str = "Parse failed") -> dict:
    return {"implementation_score": -1, "quality_band": "unknown", "reasoning": reason}


def parse_coder_output(output: str) -> dict:
    """Parse and normalize the coder evaluator's JSON response."""
    data = extract_json_object(output)
    if data is None:
        return _coder_parse_error()

    stage_scores = data.get("stageScores", {})
    if not isinstance(stage_scores, dict):
        stage_scores = {}
    stage_impl = stage_scores.get("implementation", {})
    if not isinstance(stage_impl, dict):
        stage_impl = {}

    score = coerce_score(data.get("implementation_score")) if "implementation_score" in data else None
    if "implementation_score" in data and score is None:
        return _coder_parse_error("Parse failed: missing numeric implementation_score")
    if "implementation_score" not in data:
        score = coerce_score(stage_impl.get("score"))
    if score is None:
        return _coder_parse_error("Parse failed: missing numeric implementation_score")

    data["implementation_score"] = score

    if not data.get("quality_band"):
        data["quality_band"] = score_to_impl_band(score)

    if not data.get("reasoning"):
        rationale = stage_impl.get("rationale")
        data["reasoning"] = rationale if isinstance(rationale, str) and rationale else "No reasoning provided"

    return data


def score_impl_agreement(predicted: float, ground_truth: float, had_interventions: bool) -> dict[str, float]:
    """Score agreement between predicted and ground truth implementation scores."""
    if predicted < 0:
        return {"score_diff": 1.0, "band_match": 0.0, "intervention_penalty": 0.0, "overall": 0.0}

    score_diff = abs(predicted - ground_truth)
    base_score = 1.0 - score_diff

    # Band match bonus
    pred_band = score_to_impl_band(predicted)
    truth_band = score_to_impl_band(ground_truth)
    band_match = float(pred_band == truth_band)

    # Intervention calibration penalty: if predicted high but had interventions
    intervention_penalty = 0.0
    if predicted >= 0.8 and had_interventions and ground_truth < 0.8:
        intervention_penalty = 0.15

    overall = min(1.0, max(0.0, base_score + (0.1 * band_match) - intervention_penalty))

    return {
        "score_diff": score_diff,
        "band_match": band_match,
        "intervention_penalty": intervention_penalty,
        "predicted_band": pred_band,
        "truth_band": truth_band,
        "overall": overall,
    }


def evaluate_coder(
    candidate_prompt: str,
    example: EvalExample,
    model: str = "claude-sonnet-4-5-20250929",
    use_api: bool = False,
) -> dict:
    """Evaluate a candidate coder evaluation prompt on a single example."""
    ground_truth = get_impl_ground_truth(example)

    inputs = build_coder_input(example)
    filled = fill_template(candidate_prompt, inputs)
    output = call_llm(filled, model=model, use_api=use_api)

    result = parse_coder_output(output)
    predicted_score = result.get("implementation_score", -1)

    agreement = score_impl_agreement(
        predicted=predicted_score,
        ground_truth=ground_truth["score"],
        had_interventions=example.intervention_count > 0,
    )

    return {
        **agreement,
        "predicted_score": predicted_score,
        "ground_truth_score": ground_truth["score"],
        "ground_truth_band": ground_truth["band"],
        "example_id": example.id,
        "parse_error": predicted_score < 0,
    }


def coder_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the coder evaluator."""
    try:
        predicted = float(prediction.implementation_score)
    except (AttributeError, ValueError, TypeError):
        return 0.0

    ground_truth = float(example.ground_truth_impl_score)
    return 1.0 - abs(predicted - ground_truth)


def run_evaluation(
    prompt_file: str | None = None,
    evals_path: str | None = None,
    skip_aggregate: bool = False,
    use_api: bool = False,
    model: str = "claude-sonnet-4-5-20250929",
    dry_run: bool = False,
) -> dict:
    """Run the full coder evaluation."""
    # Load candidate prompt
    if prompt_file:
        candidate_prompt = Path(prompt_file).read_text()
    else:
        candidate_prompt = DEFAULT_CODER_EVAL_PROMPT

    # Load data
    path = Path(evals_path) if evals_path else default_evals_path()
    examples = load_eval_examples(path, skip_aggregate=skip_aggregate)

    # Filter to examples with implementation stageScores
    _, val = stratified_split(examples)
    val_with_impl = filter_with_impl_scores(val)

    print(f"Coder Evaluator")
    print(f"  Total examples: {len(examples)}")
    print(f"  Val set: {len(val)}")
    print(f"  Val with impl stageScores: {len(val_with_impl)}")

    if dry_run:
        bands: dict[str, int] = {}
        for ex in val_with_impl:
            gt = get_impl_ground_truth(ex)
            bands[gt["band"]] = bands.get(gt["band"], 0) + 1
        print(f"  Impl quality bands: {dict(sorted(bands.items()))}")
        return {"dry_run": True, "total": len(examples), "val_with_impl": len(val_with_impl)}

    if not val_with_impl:
        print("  No examples with implementation stageScores found!")
        return {"evaluator": "coder", "n_examples": 0, "error": "no_data"}

    # Evaluate
    results = []
    for i, ex in enumerate(val_with_impl):
        gt = get_impl_ground_truth(ex)
        print(f"  [{i+1}/{len(val_with_impl)}] {ex.issue_id or ex.id[:8]}... (gt={gt['score']:.2f})", end=" ", flush=True)
        try:
            result = evaluate_coder(candidate_prompt, ex, model=model, use_api=use_api)
            results.append(result)
            pred = result["predicted_score"]
            print(f"pred={pred:.2f} diff={result['score_diff']:.2f} agree={result['overall']:.2f}")
        except Exception as e:
            print(f"ERROR: {e}")
            results.append({"overall": 0.0, "error": str(e), "example_id": ex.id})

    # Aggregate
    scores = [r["overall"] for r in results]
    diffs = [r.get("score_diff", 1.0) for r in results]
    band_matches = sum(r.get("band_match", 0) for r in results)
    parse_errors = sum(1 for r in results if r.get("parse_error"))

    summary = {
        "evaluator": "coder",
        "n_examples": len(results),
        "mean_agreement": sum(scores) / len(scores) if scores else 0,
        "mean_score_diff": sum(diffs) / len(diffs) if diffs else 1.0,
        "band_match_rate": band_matches / len(results) if results else 0,
        "parse_error_rate": parse_errors / len(results) if results else 0,
    }

    print(f"\n  Mean agreement: {summary['mean_agreement']:.3f}")
    print(f"  Mean score diff: {summary['mean_score_diff']:.3f}")
    print(f"  Band match rate: {summary['band_match_rate']:.1%}")
    if parse_errors:
        print(f"  Parse errors: {parse_errors}/{len(results)}")

    return summary


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate coder prompt")
    parser.add_argument("--prompt-file", help="Path to candidate coder eval prompt")
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
