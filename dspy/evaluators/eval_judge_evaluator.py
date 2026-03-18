"""Eval Judge evaluator — inter-rater agreement with ground truth scores.

Evaluates how well a candidate eval-judge prompt agrees with established
scores from the eval dataset. Uses the existing scores as pseudo-ground-truth.

Scoring:
  - Primary: 1.0 - abs(predicted_score - ground_truth_score)
  - Bonus: +0.1 if scoreBand matches (capped at 1.0)
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from data_loader import EvalExample, default_evals_path, load_eval_examples, stratified_split
from llm_caller import call_llm
from template_utils import fill_template


# Score band mapping for comparing predicted vs ground truth bands
SCORE_BAND_MAP = {
    "Full Success": (0.95, 1.0),
    "Minor Feedback": (0.8, 0.94),
    "Assisted Success": (0.5, 0.79),
    "Partial": (0.2, 0.49),
    "Failure": (0.0, 0.19),
}


def score_to_band(score: float) -> str:
    """Map a numeric score to its scoreBand label."""
    for band, (low, high) in SCORE_BAND_MAP.items():
        if low <= score <= high:
            return band
    return "Unknown"


def build_judge_inputs(example: EvalExample) -> dict[str, str]:
    """Build the template variables for the eval judge prompt.

    Since we don't have separate PR review output or self-review summaries
    stored in the eval records, we reconstruct what we can from available fields.
    """
    # Build intervention metadata from the structured data
    intervention_metadata = json.dumps({
        "interventionRequired": example.intervention_count > 0,
        "interventionCount": example.intervention_count,
        "interventionDetails": example.intervention_details,
    }, indent=2)

    # The originalPrompt IS the task packet (output of issue-writer)
    task_prompt = example.original_prompt[:3000]

    # We don't have separate PR review output, but rationale contains
    # the judge's analysis which references PR details
    pr_review = f"[PR: {example.pr_url}]\n\nPrevious judge rationale (for reference, not as ground truth):\n{example.rationale}" if example.pr_url else "Not available"

    return {
        "TASK_PROMPT": task_prompt,
        "PR_REVIEW_OUTPUT": pr_review,
        "INTERVENTION_METADATA": intervention_metadata,
        "TASK_PACKET": task_prompt,  # Same as task prompt for our records
        "PLAN_CONTENT": "Not available",
        "SELF_REVIEW_SUMMARY": "Not available",
    }


def parse_judge_output(output: str) -> dict:
    """Parse the judge's JSON output, tolerating markdown fences and preamble."""
    # Strip markdown code fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", output.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        data = json.loads(cleaned)
        return data
    except json.JSONDecodeError:
        pass

    # Try to find JSON object in the output (greedy match for nested objects)
    match = re.search(r"\{[\s\S]*\}", output)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return {"score": -1, "rationale": "Failed to parse judge output", "parse_error": True}


def score_agreement(predicted_score: float, ground_truth_score: float, ground_truth_band: str) -> dict[str, float]:
    """Score the agreement between predicted and ground truth scores.

    Returns dict with component scores and overall agreement.
    """
    if predicted_score < 0:
        # Parse failure
        return {"score_diff": 1.0, "band_match": 0.0, "overall": 0.0}

    score_diff = abs(predicted_score - ground_truth_score)
    base_score = 1.0 - score_diff

    # Band match bonus
    predicted_band = score_to_band(predicted_score)
    band_match = float(predicted_band == ground_truth_band)

    overall = min(1.0, base_score + (0.1 * band_match))

    return {
        "score_diff": score_diff,
        "band_match": band_match,
        "predicted_band": predicted_band,
        "overall": overall,
    }


def evaluate_eval_judge(
    candidate_prompt: str,
    example: EvalExample,
    model: str = "claude-sonnet-4-5-20250929",
    use_api: bool = False,
) -> dict:
    """Evaluate a candidate eval-judge prompt on a single example.

    Args:
        candidate_prompt: The eval judge prompt template to evaluate.
        example: An eval example with a known score (ground truth).
        model: LLM model to use for the candidate prompt.
        use_api: Whether to use the Anthropic API directly.

    Returns:
        Dict with agreement scores and diagnostics.
    """
    # Fill the candidate prompt with example data
    inputs = build_judge_inputs(example)
    filled = fill_template(candidate_prompt, inputs)

    # Call LLM with the filled prompt
    output = call_llm(filled, model=model, use_api=use_api)

    # Parse the judge's response
    judge_result = parse_judge_output(output)
    predicted_score = judge_result.get("score", -1)

    # Score agreement with ground truth
    agreement = score_agreement(
        predicted_score=predicted_score,
        ground_truth_score=example.score,
        ground_truth_band=example.score_band,
    )

    return {
        **agreement,
        "predicted_score": predicted_score,
        "ground_truth_score": example.score,
        "ground_truth_band": example.score_band,
        "judge_rationale": judge_result.get("rationale", ""),
        "example_id": example.id,
        "parse_error": judge_result.get("parse_error", False),
    }


def eval_judge_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the eval judge evaluator."""
    try:
        predicted = float(prediction.score)
    except (AttributeError, ValueError, TypeError):
        return 0.0

    ground_truth = float(example.ground_truth_score)
    return 1.0 - abs(predicted - ground_truth)


def select_golden_set(
    examples: list[EvalExample],
    target_size: int = 20,
    seed: int = 42,
) -> list[EvalExample]:
    """Select a stratified golden set for evaluation.

    Ensures coverage across all scoreBands, favoring records
    with richer intervention metadata.
    """
    import random
    rng = random.Random(seed)

    # Group by band
    by_band: dict[str, list[EvalExample]] = {}
    for ex in examples:
        by_band.setdefault(ex.score_band, []).append(ex)

    # Allocate slots proportionally, minimum 1 per band
    total = len(examples)
    golden = []
    remaining_slots = target_size

    for band, band_examples in sorted(by_band.items()):
        # Proportional allocation with minimum of 1
        n_slots = max(1, round(len(band_examples) / total * target_size))
        n_slots = min(n_slots, remaining_slots, len(band_examples))

        # Prefer examples with intervention details (richer signal)
        band_examples.sort(key=lambda x: len(x.intervention_details), reverse=True)

        # Take top N with some randomness
        candidates = band_examples[:n_slots * 2] if len(band_examples) > n_slots else band_examples
        rng.shuffle(candidates)
        golden.extend(candidates[:n_slots])
        remaining_slots -= n_slots

    return golden


def run_evaluation(
    prompt_file: str | None = None,
    evals_path: str | None = None,
    skip_aggregate: bool = False,
    use_api: bool = False,
    model: str = "claude-sonnet-4-5-20250929",
    dry_run: bool = False,
    golden_size: int = 20,
) -> dict:
    """Run the full eval judge evaluation.

    Args:
        prompt_file: Path to candidate eval-judge prompt. Uses default if None.
        evals_path: Path to aggregated evals. Uses default if None.
        skip_aggregate: Skip data aggregation step.
        use_api: Use Anthropic API directly.
        model: Model to use for candidate prompt.
        dry_run: If True, just load data and show stats.
        golden_size: Target size for the golden evaluation set.

    Returns:
        Evaluation results dict.
    """
    # Load candidate prompt
    if prompt_file:
        candidate_prompt = Path(prompt_file).read_text()
    else:
        # Use the existing eval-judge.md prompt
        repo_root = Path(__file__).resolve().parent.parent.parent
        default_prompt_path = repo_root / "tools" / "prompts" / "eval-judge.md"
        if default_prompt_path.exists():
            candidate_prompt = default_prompt_path.read_text()
        else:
            raise FileNotFoundError(f"Default eval-judge prompt not found at {default_prompt_path}")

    # Load data
    path = Path(evals_path) if evals_path else default_evals_path()
    examples = load_eval_examples(path, skip_aggregate=skip_aggregate)

    # Select golden set from validation split
    _, val = stratified_split(examples)
    golden = select_golden_set(val, target_size=golden_size)

    print(f"Eval Judge Evaluator")
    print(f"  Total examples: {len(examples)}")
    print(f"  Val set: {len(val)}")
    print(f"  Golden set: {len(golden)}")

    if dry_run:
        bands: dict[str, int] = {}
        for ex in golden:
            bands[ex.score_band] = bands.get(ex.score_band, 0) + 1
        print(f"  Golden bands: {dict(sorted(bands.items()))}")
        return {"dry_run": True, "total": len(examples), "golden": len(golden)}

    # Evaluate on golden set
    results = []
    for i, ex in enumerate(golden):
        print(f"  [{i+1}/{len(golden)}] {ex.issue_id or ex.id[:8]}... (gt={ex.score:.2f})", end=" ", flush=True)
        try:
            result = evaluate_eval_judge(candidate_prompt, ex, model=model, use_api=use_api)
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
        "evaluator": "eval-judge",
        "n_examples": len(results),
        "mean_agreement": sum(scores) / len(scores) if scores else 0,
        "mean_score_diff": sum(diffs) / len(diffs) if diffs else 1.0,
        "band_match_rate": band_matches / len(results) if results else 0,
        "parse_error_rate": parse_errors / len(results) if results else 0,
        "results": results,
    }

    print(f"\n  Mean agreement: {summary['mean_agreement']:.3f}")
    print(f"  Mean score diff: {summary['mean_score_diff']:.3f}")
    print(f"  Band match rate: {summary['band_match_rate']:.1%}")
    if parse_errors:
        print(f"  Parse errors: {parse_errors}/{len(results)}")

    return summary


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate eval judge prompt")
    parser.add_argument("--prompt-file", help="Path to candidate eval-judge prompt")
    parser.add_argument("--evals", help="Path to aggregated evals JSONL")
    parser.add_argument("--skip-aggregate", action="store_true")
    parser.add_argument("--use-api", action="store_true")
    parser.add_argument("--model", default="claude-sonnet-4-5-20250929")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--golden-size", type=int, default=20)
    args = parser.parse_args()

    result = run_evaluation(
        prompt_file=args.prompt_file,
        evals_path=args.evals,
        skip_aggregate=args.skip_aggregate,
        use_api=args.use_api,
        model=args.model,
        dry_run=args.dry_run,
        golden_size=args.golden_size,
    )

    if not args.dry_run:
        import json as _json
        print(f"\n{_json.dumps({k: v for k, v in result.items() if k != 'results'}, indent=2)}")
