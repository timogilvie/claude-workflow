"""Issue Writer evaluator — task packet quality scoring.

Evaluates candidate issue-writer prompts by:
  1. Extracting issue context from eval records
  2. Filling the candidate prompt with that context
  3. Calling LLM to generate a task packet
  4. Scoring with task-packet-reviewer prompt
  5. Correlating with downstream workflow success

Scoring:
  - Base: 1.0 if reviewer PASS, 0.5 if FAIL
  - Deductions: -0.1 per issue found by reviewer
  - Floor: 0.0
  - Bonus: +0.1 if downstream workflow score >= 0.9
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from data_loader import EvalExample, default_evals_path, load_eval_examples, stratified_split
from llm_caller import call_llm
from template_utils import fill_template


def extract_issue_context(example: EvalExample) -> str:
    """Extract a synthetic issue context from an eval record.

    Since eval records contain the expanded task packet (output of issue-writer),
    not the raw issue, we extract the issue title and objective section as a
    proxy for the original issue description.
    """
    prompt = example.original_prompt
    lines = prompt.strip().split("\n")

    # Extract title (usually first non-empty line starting with #)
    title = ""
    for line in lines[:10]:
        if line.strip().startswith("# "):
            title = line.strip().lstrip("# ").strip()
            break

    # Extract objective section (usually Section 1)
    objective = ""
    in_objective = False
    for line in lines:
        if re.match(r"^##?\s*1[\.\)]\s*Objective", line, re.I) or \
           re.match(r"^##\s*Objective", line, re.I):
            in_objective = True
            continue
        if in_objective:
            if line.strip().startswith("## ") and "Objective" not in line:
                break
            objective += line + "\n"

    # Build a synthetic issue context
    context_parts = []
    if example.issue_id:
        context_parts.append(f"Issue: {example.issue_id}")
    if title:
        context_parts.append(f"Title: {title}")
    if objective.strip():
        context_parts.append(f"Description:\n{objective.strip()[:1000]}")
    if example.source_repo:
        context_parts.append(f"Repository: {example.source_repo}")

    return "\n\n".join(context_parts) if context_parts else prompt[:500]


def build_codebase_context_stub(example: EvalExample) -> str:
    """Build a minimal codebase context stub from available data."""
    parts = [f"Repository: {example.source_repo or 'unknown'}"]

    # Extract file references from the task packet
    files = re.findall(r"`([a-zA-Z0-9_/\-]+\.[a-z]{1,5})`", example.original_prompt)
    if files:
        unique_files = list(dict.fromkeys(files))[:20]
        parts.append("Key files mentioned:\n" + "\n".join(f"  - {f}" for f in unique_files))

    return "\n\n".join(parts)


def parse_reviewer_output(output: str) -> dict:
    """Parse the task-packet-reviewer JSON output."""
    # Strip markdown fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", output.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", output)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return {"status": "FAIL", "issues": [], "parse_error": True}


def score_task_packet(reviewer_result: dict, downstream_score: float) -> dict[str, float]:
    """Score a task packet based on reviewer results and downstream success.

    Args:
        reviewer_result: Parsed output from task-packet-reviewer
        downstream_score: The eval record's workflow score (0.0-1.0)

    Returns:
        Dict with component scores and overall score.
    """
    status = reviewer_result.get("status", "FAIL")
    issues = reviewer_result.get("issues", [])
    parse_error = reviewer_result.get("parse_error", False)

    if parse_error:
        # Reviewer output couldn't be parsed — fallback to heuristic
        base = 0.3
    elif status == "PASS":
        base = 1.0
    else:
        base = 0.5

    # Deductions for issues
    deduction = len(issues) * 0.1
    quality_score = max(0.0, base - deduction)

    # Bonus for downstream success
    downstream_bonus = 0.1 if downstream_score >= 0.9 else 0.0
    overall = min(1.0, quality_score + downstream_bonus)

    return {
        "base_score": base,
        "n_issues": len(issues),
        "deduction": deduction,
        "quality_score": quality_score,
        "downstream_bonus": downstream_bonus,
        "overall": overall,
    }


def evaluate_issue_writer(
    candidate_prompt: str,
    reviewer_prompt: str,
    example: EvalExample,
    model: str = "claude-sonnet-4-5-20250929",
    use_api: bool = False,
) -> dict:
    """Evaluate a candidate issue-writer prompt on a single example.

    Steps:
      1. Extract issue context from the eval record
      2. Fill candidate prompt with issue context
      3. Call LLM to generate a task packet
      4. Score the generated task packet with the reviewer
      5. Factor in downstream workflow success

    Args:
        candidate_prompt: The issue-writer prompt template to evaluate.
        reviewer_prompt: The task-packet-reviewer prompt template.
        example: An eval example with a known downstream score.
        model: LLM model to use.
        use_api: Whether to use the Anthropic API directly.

    Returns:
        Dict with scores and diagnostics.
    """
    # Step 1: Extract issue context
    issue_context = extract_issue_context(example)
    codebase_context = build_codebase_context_stub(example)

    # Step 2: Fill candidate prompt
    filled_writer = fill_template(candidate_prompt, {
        "ISSUE_CONTEXT": issue_context,
        "CODEBASE_CONTEXT": codebase_context,
    })

    # Step 3: Generate task packet
    task_packet = call_llm(filled_writer, model=model, use_api=use_api)

    # Step 4: Score with reviewer
    filled_reviewer = fill_template(reviewer_prompt, {
        "TASK_PACKET": task_packet[:6000],  # Truncate to avoid token limits
    })
    reviewer_output = call_llm(filled_reviewer, model=model, use_api=use_api)
    reviewer_result = parse_reviewer_output(reviewer_output)

    # Step 5: Score
    scores = score_task_packet(reviewer_result, downstream_score=example.score)

    return {
        **scores,
        "reviewer_status": reviewer_result.get("status", "UNKNOWN"),
        "reviewer_issues": reviewer_result.get("issues", []),
        "parse_error": reviewer_result.get("parse_error", False),
        "downstream_score": example.score,
        "example_id": example.id,
        "task_packet_length": len(task_packet),
    }


def issue_writer_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the issue writer evaluator.

    This is a simplified version that scores task packet quality directly
    using heuristic checks (no LLM call), suitable for DSPy optimization loops.
    """
    task_packet = getattr(prediction, "task_packet", "")
    if not task_packet:
        return 0.0

    score = 0.0

    # Check for key sections
    sections = [
        r"##?\s*1[\.\)]\s*Objective",
        r"##?\s*Success\s*Criteria",
        r"##?\s*Implementation",
        r"##?\s*Validation",
    ]
    for pattern in sections:
        if re.search(pattern, task_packet, re.I):
            score += 0.2

    # Length check (too short = bad, reasonable = good)
    if len(task_packet) > 500:
        score += 0.1
    if len(task_packet) > 2000:
        score += 0.1

    return min(1.0, score)


def run_evaluation(
    prompt_file: str | None = None,
    evals_path: str | None = None,
    skip_aggregate: bool = False,
    use_api: bool = False,
    model: str = "claude-sonnet-4-5-20250929",
    dry_run: bool = False,
) -> dict:
    """Run the full issue writer evaluation.

    Args:
        prompt_file: Path to candidate issue-writer prompt. Uses default if None.
        evals_path: Path to aggregated evals. Uses default if None.
        skip_aggregate: Skip data aggregation step.
        use_api: Use Anthropic API directly.
        model: Model to use for candidate prompt.
        dry_run: If True, just load data and show stats.

    Returns:
        Evaluation results dict.
    """
    repo_root = Path(__file__).resolve().parent.parent.parent

    # Load candidate prompt
    if prompt_file:
        candidate_prompt = Path(prompt_file).read_text()
    else:
        default_path = repo_root / "tools" / "prompts" / "issue-writer.md"
        if default_path.exists():
            candidate_prompt = default_path.read_text()
        else:
            raise FileNotFoundError(f"Default issue-writer prompt not found at {default_path}")

    # Load reviewer prompt
    reviewer_path = repo_root / "tools" / "prompts" / "task-packet-reviewer.md"
    if not reviewer_path.exists():
        raise FileNotFoundError(f"Task packet reviewer prompt not found at {reviewer_path}")
    reviewer_prompt = reviewer_path.read_text()

    # Load data
    path = Path(evals_path) if evals_path else default_evals_path()
    examples = load_eval_examples(path, skip_aggregate=skip_aggregate)
    train, val = stratified_split(examples)

    print(f"Issue Writer Evaluator")
    print(f"  Total examples: {len(examples)}")
    print(f"  Train: {len(train)}, Val: {len(val)}")

    if dry_run:
        bands: dict[str, int] = {}
        for ex in val:
            bands[ex.score_band] = bands.get(ex.score_band, 0) + 1
        print(f"  Val bands: {dict(sorted(bands.items()))}")
        return {"dry_run": True, "total": len(examples), "val": len(val)}

    # Evaluate on validation set
    # Note: This evaluator makes 2 LLM calls per example (generate + review),
    # so it's slower than the others.
    results = []
    for i, ex in enumerate(val):
        print(f"  [{i+1}/{len(val)}] {ex.issue_id or ex.id[:8]}...", end=" ", flush=True)
        try:
            result = evaluate_issue_writer(
                candidate_prompt, reviewer_prompt, ex,
                model=model, use_api=use_api,
            )
            results.append(result)
            print(f"score={result['overall']:.2f} reviewer={result['reviewer_status']} issues={result['n_issues']}")
        except Exception as e:
            print(f"ERROR: {e}")
            results.append({"overall": 0.0, "error": str(e), "example_id": ex.id})

    # Aggregate
    scores = [r["overall"] for r in results]
    pass_rate = sum(1 for r in results if r.get("reviewer_status") == "PASS") / len(results) if results else 0

    summary = {
        "evaluator": "issue-writer",
        "n_examples": len(results),
        "mean_score": sum(scores) / len(scores) if scores else 0,
        "reviewer_pass_rate": pass_rate,
        "results": results,
    }

    print(f"\n  Mean score: {summary['mean_score']:.3f}")
    print(f"  Reviewer pass rate: {summary['reviewer_pass_rate']:.1%}")

    return summary


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate issue writer prompt")
    parser.add_argument("--prompt-file", help="Path to candidate issue-writer prompt")
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
