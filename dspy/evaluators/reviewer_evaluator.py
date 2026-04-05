"""Reviewer evaluator — self-review effectiveness scoring.

Evaluates review phase quality using proxy signals since only 1 record has
a direct review stageScore. Uses post-PR intervention patterns as the primary
signal: good reviews catch issues before merge, bad reviews let issues through.

Proxy signal:
  - No post-PR commits + high score = review was effective (caught or no issues)
  - Post-PR commits = review missed something
  - Review comments that led to fixes = review worked

Scoring:
  - Primary: Agreement with derived review quality score
  - Bonus: +0.1 if predicted band matches
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from data_loader import EvalExample, default_evals_path, load_eval_examples, stratified_split
from llm_caller import call_llm
from template_utils import fill_template


REVIEW_BANDS = {
    "excellent": (0.9, 1.0),
    "good": (0.7, 0.9),
    "weak": (0.4, 0.7),
    "poor": (0.0, 0.4),
}


def score_to_review_band(score: float) -> str:
    """Map a numeric score to its review quality band."""
    for band, (low, high) in REVIEW_BANDS.items():
        if low <= score <= high:
            return band
    return "unknown"


def derive_review_quality(example: EvalExample) -> dict:
    """Derive review quality from post-PR intervention signals.

    Logic:
    - Start with the overall score as base
    - Post-PR commits are the strongest signal of review failure
    - Review comments that led to fixes are a positive signal
    - No interventions + high score = review was fine
    """
    # Check for direct review stageScore first
    stages = example.metadata.get("stageScores", {})
    if "review" in stages and isinstance(stages["review"], dict):
        review_data = stages["review"]
        if isinstance(review_data.get("score"), (int, float)):
            return {
                "score": review_data["score"],
                "rationale": review_data.get("rationale", "Direct judge score"),
                "band": score_to_review_band(review_data["score"]),
                "source": "direct",
            }

    # Analyze intervention types
    intervention_summary = example.metadata.get("interventionSummary", {})
    interventions = intervention_summary.get("interventions", [])

    post_pr_commits = 0
    review_comments = 0
    manual_edits = 0

    for intervention in interventions:
        itype = intervention.get("type", "")
        count = intervention.get("count", 0)
        if itype == "post_pr_commit":
            post_pr_commits = count
        elif itype == "review_comment":
            review_comments = count
        elif itype == "manual_edit":
            manual_edits = count

    # Derive review quality
    if example.score >= 0.95 and post_pr_commits == 0 and manual_edits == 0:
        # Perfect outcome, no post-PR fixes needed — review was effective
        derived = 0.95
    elif example.score >= 0.8 and post_pr_commits == 0:
        # Good outcome, no post-PR fixes
        derived = 0.85
    elif post_pr_commits == 0 and review_comments == 0:
        # No review activity but also no post-PR fixes
        # Review may have been skipped or was unnecessary
        derived = max(0.6, example.score - 0.1)
    elif post_pr_commits > 0:
        # Post-PR commits = review missed something
        penalty = min(0.4, post_pr_commits * 0.15)
        derived = max(0.1, example.score - penalty)
    else:
        # Review comments but no post-PR commits = review caught issues
        derived = min(0.9, example.score + 0.05)

    return {
        "score": derived,
        "rationale": f"Derived: base={example.score:.2f}, post_pr={post_pr_commits}, review_comments={review_comments}, manual_edits={manual_edits}",
        "band": score_to_review_band(derived),
        "source": "derived",
    }


DEFAULT_REVIEWER_EVAL_PROMPT = """You are evaluating the quality of an AI agent's self-review phase.

Given a task description and workflow outcome, assess how effective the review phase was.

## Task Description

{{TASK_PROMPT}}

## Workflow Outcome

Repository: {{REPO_NAME}}
Overall workflow score: {{OVERALL_SCORE}} ({{SCORE_BAND}})
Intervention count: {{INTERVENTION_COUNT}}

## Post-PR Intervention Details

{{INTERVENTION_DETAILS}}

## Intervention Summary

Post-PR commits: {{POST_PR_COMMITS}}
Review comments: {{REVIEW_COMMENTS}}
Manual edits: {{MANUAL_EDITS}}

Judge rationale: {{JUDGE_RATIONALE}}

## What Makes a Good Review

A good self-review:
- Catches bugs and issues before PR merge
- Identifies missing test coverage
- Spots architectural problems early
- Results in clean PRs with no post-merge fixes

A poor self-review:
- Misses bugs that are caught by human reviewers
- Fails to identify missing requirements
- Lets through code that needs post-PR commits to fix
- Either too permissive (misses real issues) or too aggressive (false positives)

## Scoring Guidelines

- **0.9-1.0 (Excellent)**: No post-PR fixes needed. Review was thorough and caught any issues.
- **0.7-0.9 (Good)**: Minimal post-PR activity. Review caught most issues.
- **0.4-0.7 (Weak)**: Some post-PR fixes needed. Review missed notable issues.
- **0.0-0.4 (Poor)**: Significant post-PR rework. Review was ineffective.

## Output

Respond with ONLY a valid JSON object (no markdown fences):

{"review_score": <float 0.0-1.0>, "quality_band": "excellent|good|weak|poor", "reasoning": "<1-2 sentence explanation>"}"""


def build_reviewer_input(example: EvalExample) -> dict[str, str]:
    """Build template variables for the reviewer evaluation prompt."""
    intervention_summary = example.metadata.get("interventionSummary", {})
    interventions = intervention_summary.get("interventions", [])

    post_pr = 0
    review_comments = 0
    manual_edits = 0
    for intervention in interventions:
        itype = intervention.get("type", "")
        count = intervention.get("count", 0)
        if itype == "post_pr_commit":
            post_pr = count
        elif itype == "review_comment":
            review_comments = count
        elif itype == "manual_edit":
            manual_edits = count

    return {
        "TASK_PROMPT": example.original_prompt[:2000],
        "REPO_NAME": example.source_repo or "unknown",
        "OVERALL_SCORE": f"{example.score:.2f}",
        "SCORE_BAND": example.score_band,
        "INTERVENTION_COUNT": str(example.intervention_count),
        "INTERVENTION_DETAILS": json.dumps(example.intervention_details[:5], indent=2),
        "POST_PR_COMMITS": str(post_pr),
        "REVIEW_COMMENTS": str(review_comments),
        "MANUAL_EDITS": str(manual_edits),
        "JUDGE_RATIONALE": example.rationale[:1000] if example.rationale else "Not available",
    }


def parse_reviewer_output(output: str) -> dict:
    """Parse the reviewer evaluator's JSON response."""
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

    return {"review_score": -1, "quality_band": "unknown", "reasoning": "Parse failed"}


def score_review_agreement(predicted: float, ground_truth: float) -> dict[str, float]:
    """Score agreement between predicted and derived review quality."""
    if predicted < 0:
        return {"score_diff": 1.0, "band_match": 0.0, "overall": 0.0}

    score_diff = abs(predicted - ground_truth)
    base_score = 1.0 - score_diff

    pred_band = score_to_review_band(predicted)
    truth_band = score_to_review_band(ground_truth)
    band_match = float(pred_band == truth_band)

    overall = min(1.0, max(0.0, base_score + (0.1 * band_match)))

    return {
        "score_diff": score_diff,
        "band_match": band_match,
        "predicted_band": pred_band,
        "truth_band": truth_band,
        "overall": overall,
    }


def evaluate_reviewer(
    candidate_prompt: str,
    example: EvalExample,
    model: str = "claude-sonnet-4-5-20250929",
    use_api: bool = False,
) -> dict:
    """Evaluate a candidate reviewer evaluation prompt on a single example."""
    ground_truth = derive_review_quality(example)

    inputs = build_reviewer_input(example)
    filled = fill_template(candidate_prompt, inputs)
    output = call_llm(filled, model=model, use_api=use_api)

    result = parse_reviewer_output(output)
    predicted_score = result.get("review_score", -1)

    agreement = score_review_agreement(
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


def reviewer_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the reviewer evaluator."""
    try:
        predicted = float(prediction.review_score)
    except (AttributeError, ValueError, TypeError):
        return 0.0

    ground_truth = float(example.ground_truth_review_score)
    return 1.0 - abs(predicted - ground_truth)


def run_evaluation(
    prompt_file: str | None = None,
    evals_path: str | None = None,
    skip_aggregate: bool = False,
    use_api: bool = False,
    model: str = "claude-sonnet-4-5-20250929",
    dry_run: bool = False,
) -> dict:
    """Run the full reviewer evaluation."""
    if prompt_file:
        candidate_prompt = Path(prompt_file).read_text()
    else:
        candidate_prompt = DEFAULT_REVIEWER_EVAL_PROMPT

    path = Path(evals_path) if evals_path else default_evals_path()
    examples = load_eval_examples(path, skip_aggregate=skip_aggregate)
    _, val = stratified_split(examples)

    print(f"Reviewer Evaluator")
    print(f"  Total examples: {len(examples)}")
    print(f"  Val set: {len(val)}")

    direct_count = sum(1 for ex in val if derive_review_quality(ex)["source"] == "direct")
    print(f"  Direct review stageScores: {direct_count}")
    print(f"  Derived review quality: {len(val) - direct_count}")

    if dry_run:
        bands: dict[str, int] = {}
        for ex in val:
            gt = derive_review_quality(ex)
            bands[gt["band"]] = bands.get(gt["band"], 0) + 1
        print(f"  Review quality bands: {dict(sorted(bands.items()))}")
        return {"dry_run": True, "total": len(examples), "val": len(val), "direct": direct_count}

    results = []
    for i, ex in enumerate(val):
        gt = derive_review_quality(ex)
        print(f"  [{i+1}/{len(val)}] {ex.issue_id or ex.id[:8]}... (gt={gt['score']:.2f} [{gt['source']}])", end=" ", flush=True)
        try:
            result = evaluate_reviewer(candidate_prompt, ex, model=model, use_api=use_api)
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
        "evaluator": "reviewer",
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

    parser = argparse.ArgumentParser(description="Evaluate reviewer prompt")
    parser.add_argument("--prompt-file", help="Path to candidate reviewer eval prompt")
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
