"""Model Router evaluator — retrospective accuracy of routing decisions.

Evaluates whether a candidate router prompt recommends the model that
historically performed best for similar tasks. Uses the existing
derive_optimal_routing() labels as ground truth.

Scoring:
  - Model match:  50% weight
  - Risk recall:  30% weight
  - Cost accuracy: 20% weight
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from data_loader import EvalExample, default_evals_path, load_eval_examples, stratified_split
from llm_caller import call_llm
from template_utils import fill_template

# Import routing logic from prepare_data (which requires dspy).
# We lazy-import to avoid hard dependency on dspy for dry-run mode.
_prepare_data = None

AVAILABLE_MODELS = "claude-sonnet-4-5-20250929,gpt-5.3-codex,gpt-5.4"


def _get_prepare_data():
    global _prepare_data
    if _prepare_data is None:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        import prepare_data as pd
        _prepare_data = pd
    return _prepare_data


def _classify_task_type_simple(prompt: str) -> str:
    """Simple task type classifier (no dspy dependency)."""
    prompt_lower = prompt.lower()
    for keyword, task_type in [
        ("fix", "bugfix"), ("bug", "bugfix"), ("broken", "bugfix"),
        ("refactor", "refactor"), ("restructur", "refactor"),
        ("test", "test"), ("spec", "test"),
        ("document", "documentation"), ("readme", "documentation"),
        ("deploy", "infrastructure"), ("docker", "infrastructure"),
        ("add", "feature"), ("implement", "feature"), ("create", "feature"),
    ]:
        if keyword in prompt_lower:
            return task_type
    return "unknown"


def _derive_optimal_routing_simple(record: dict) -> dict:
    """Derive optimal routing without dspy dependency."""
    try:
        pd = _get_prepare_data()
        return pd.derive_optimal_routing(record)
    except ImportError:
        # Fallback: simple heuristic
        score = record.get("score", 0.0)
        model_id = record.get("modelId", "claude-sonnet-4-5-20250929")
        if score >= 0.85:
            recommended = model_id
        else:
            recommended = "claude-sonnet-4-5-20250929"
        return {
            "recommended_model": recommended,
            "risk_flags": [],
            "cost_estimate": "medium",
        }


def _classify_task_type(prompt: str) -> str:
    """Classify task type, using prepare_data if available."""
    try:
        pd = _get_prepare_data()
        return pd.classify_task_type(prompt)
    except ImportError:
        return _classify_task_type_simple(prompt)


# Default router prompt template (used when no candidate prompt file is provided)
DEFAULT_ROUTER_PROMPT = """You are a model router for an autonomous software engineering workflow.

Given a task description, recommend which AI model should handle it based on task complexity, risk, and cost considerations.

## Available Models

{{available_models}}

## Model Selection Guidelines

- **claude-sonnet-4-5-20250929**: Best default for most tasks. Fast, cost-effective, handles features, bugfixes, refactoring, and documentation well. Choose this unless the task clearly requires a more capable model.
- **gpt-5.3-codex**: Consider for complex multi-file refactors or tasks requiring deep architectural reasoning across many files.
- **gpt-5.4**: Reserve for the highest-complexity tasks: large-scale migrations, security-critical changes, or tasks with complex cross-cutting concerns.

## Risk Flag Guidelines

Flag risks that could cause the task to fail or require human intervention:
- "breaking-change" — Changes to public APIs, database schemas, or shared interfaces
- "security" — Authentication, authorization, input validation, or data handling changes
- "data-migration" — Database migrations or data transformations
- "multi-service" — Changes spanning multiple services or repositories
- "complex-state" — Complex state management or concurrency concerns
- "no-tests" — Area lacks test coverage, harder to validate

## Cost Estimation

- "low" — Simple, isolated changes (CSS, docs, config, single-file fixes)
- "medium" — Standard feature work, multi-file changes, typical bugfixes
- "high" — Large features, complex refactors, infrastructure changes, migrations

## Task Information

Task type: {{task_type}}
Repository: {{repo_name}}

Task description:
{{task_prompt}}

## Output

Respond with ONLY a valid JSON object (no markdown fences, no explanation before or after):

{"recommended_model": "<exact model ID from the list above>", "confidence": "high|medium|low", "risk_flags": ["flag1"], "cost_estimate": "low|medium|high", "reasoning": "<1-2 sentence explanation>"}"""


def build_router_input(example: EvalExample) -> dict:
    """Build the input variables for a router prompt from an eval example."""
    return {
        "task_prompt": example.original_prompt[:2000],
        "repo_name": example.source_repo or "unknown",
        "task_type": _classify_task_type(example.original_prompt),
        "available_models": AVAILABLE_MODELS,
    }


def _fix_json_string(s: str) -> str:
    """Attempt to fix common JSON issues (single quotes, trailing commas)."""
    # Replace single quotes with double quotes (but not inside strings)
    # Simple heuristic: replace ' with " when it looks like a JSON delimiter
    s = re.sub(r"'([^']*)'(\s*[:\],}])", r'"\1"\2', s)
    s = re.sub(r"(\{|\[|,)\s*'([^']*)'", r'\1 "\2"', s)
    # Remove trailing commas before } or ]
    s = re.sub(r",\s*([}\]])", r"\1", s)
    return s


def parse_router_output(output: str) -> dict:
    """Parse the router's JSON response, tolerating markdown fences and minor issues."""
    # Strip markdown code fences if present
    cleaned = re.sub(r"^```(?:json)?\s*", "", output.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    # Try direct parse first
    for candidate in [cleaned, _fix_json_string(cleaned)]:
        try:
            data = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    else:
        # Try to find JSON object in the output (greedy to handle nested)
        match = re.search(r"\{[\s\S]*\}", output)
        if match:
            raw = match.group()
            for candidate in [raw, _fix_json_string(raw)]:
                try:
                    data = json.loads(candidate)
                    break
                except json.JSONDecodeError:
                    continue
            else:
                return {
                    "recommended_model": "",
                    "confidence": "",
                    "risk_flags": [],
                    "cost_estimate": "",
                    "reasoning": "Failed to parse output",
                }
        else:
            return {
                "recommended_model": "",
                "confidence": "",
                "risk_flags": [],
                "cost_estimate": "",
                "reasoning": "Failed to parse output",
            }

    return {
        "recommended_model": data.get("recommended_model", ""),
        "confidence": data.get("confidence", ""),
        "risk_flags": data.get("risk_flags", []),
        "cost_estimate": data.get("cost_estimate", ""),
        "reasoning": data.get("reasoning", ""),
    }


def score_routing(prediction: dict, ground_truth: dict) -> dict[str, float]:
    """Score a routing prediction against ground truth labels.

    Returns dict with component scores and overall weighted score.
    """
    # Model selection accuracy (0 or 1)
    model_correct = float(prediction["recommended_model"] == ground_truth["recommended_model"])

    # Risk flag recall
    pred_flags = set(prediction.get("risk_flags") or [])
    true_flags = set(ground_truth.get("risk_flags") or [])
    if true_flags:
        risk_recall = len(pred_flags & true_flags) / len(true_flags)
    else:
        risk_recall = 1.0 if not pred_flags else 0.5

    # Cost estimate accuracy
    cost_correct = float(prediction.get("cost_estimate") == ground_truth.get("cost_estimate"))

    overall = 0.5 * model_correct + 0.3 * risk_recall + 0.2 * cost_correct

    return {
        "model_correct": model_correct,
        "risk_recall": risk_recall,
        "cost_correct": cost_correct,
        "overall": overall,
    }


def evaluate_model_router(
    candidate_prompt: str,
    example: EvalExample,
    model: str = "claude-sonnet-4-5-20250929",
    use_api: bool = False,
) -> dict:
    """Evaluate a candidate router prompt on a single example.

    Args:
        candidate_prompt: The router prompt template to evaluate.
        example: An eval example with ground truth routing labels.
        model: LLM model to use for the candidate prompt.
        use_api: Whether to use the Anthropic API directly.

    Returns:
        Dict with score components and diagnostics.
    """
    # Build ground truth from the eval record
    record = {
        "originalPrompt": example.original_prompt,
        "modelId": example.model_id,
        "score": example.score,
        "interventionCount": example.intervention_count,
        "workflowCost": example.workflow_cost,
    }
    ground_truth = _derive_optimal_routing_simple(record)

    # Fill and call the candidate prompt
    inputs = build_router_input(example)
    filled = fill_template(candidate_prompt, inputs)
    output = call_llm(filled, model=model, use_api=use_api)

    # Parse and score
    prediction = parse_router_output(output)
    scores = score_routing(prediction, ground_truth)

    return {
        **scores,
        "prediction": prediction,
        "ground_truth": {
            "recommended_model": ground_truth["recommended_model"],
            "risk_flags": ground_truth["risk_flags"],
            "cost_estimate": ground_truth["cost_estimate"],
        },
        "example_id": example.id,
    }


def routing_metric(example, prediction, trace=None) -> float:
    """DSPy-compatible metric wrapper for the model router evaluator.

    Compatible with dspy.MIPROv2 optimization.
    """
    pred_dict = {
        "recommended_model": getattr(prediction, "recommended_model", ""),
        "risk_flags": getattr(prediction, "risk_flags", []),
        "cost_estimate": getattr(prediction, "cost_estimate", ""),
    }
    truth_dict = {
        "recommended_model": getattr(example, "recommended_model", ""),
        "risk_flags": getattr(example, "risk_flags", []),
        "cost_estimate": getattr(example, "cost_estimate", ""),
    }
    scores = score_routing(pred_dict, truth_dict)
    return scores["overall"]


def run_evaluation(
    prompt_file: str | None = None,
    evals_path: str | None = None,
    skip_aggregate: bool = False,
    use_api: bool = False,
    model: str = "claude-sonnet-4-5-20250929",
    dry_run: bool = False,
) -> dict:
    """Run the full model router evaluation.

    Args:
        prompt_file: Path to candidate prompt file. Uses default if None.
        evals_path: Path to aggregated evals. Uses default if None.
        skip_aggregate: Skip data aggregation step.
        use_api: Use Anthropic API directly.
        model: Model to use for candidate prompt.
        dry_run: If True, just load data and show stats.

    Returns:
        Evaluation results dict.
    """
    # Load candidate prompt
    if prompt_file:
        candidate_prompt = Path(prompt_file).read_text()
    else:
        candidate_prompt = DEFAULT_ROUTER_PROMPT

    # Load data
    path = Path(evals_path) if evals_path else default_evals_path()
    examples = load_eval_examples(path, skip_aggregate=skip_aggregate)
    train, val = stratified_split(examples)

    print(f"Model Router Evaluator")
    print(f"  Total examples: {len(examples)}")
    print(f"  Train: {len(train)}, Val: {len(val)}")

    if dry_run:
        # Show band distribution
        bands: dict[str, int] = {}
        for ex in val:
            bands[ex.score_band] = bands.get(ex.score_band, 0) + 1
        print(f"  Val bands: {dict(sorted(bands.items()))}")
        return {"dry_run": True, "total": len(examples), "val": len(val)}

    # Evaluate on validation set
    results = []
    for i, ex in enumerate(val):
        print(f"  [{i+1}/{len(val)}] {ex.issue_id or ex.id[:8]}...", end=" ", flush=True)
        try:
            result = evaluate_model_router(candidate_prompt, ex, model=model, use_api=use_api)
            results.append(result)
            print(f"score={result['overall']:.2f} model={'✓' if result['model_correct'] else '✗'}")
        except Exception as e:
            print(f"ERROR: {e}")
            results.append({"overall": 0.0, "error": str(e), "example_id": ex.id})

    # Aggregate
    scores = [r["overall"] for r in results]
    model_acc = sum(r.get("model_correct", 0) for r in results) / len(results) if results else 0

    summary = {
        "evaluator": "model-router",
        "n_examples": len(results),
        "mean_score": sum(scores) / len(scores) if scores else 0,
        "model_accuracy": model_acc,
        "results": results,
    }

    print(f"\n  Mean score: {summary['mean_score']:.3f}")
    print(f"  Model accuracy: {summary['model_accuracy']:.1%}")

    return summary


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate model router prompt")
    parser.add_argument("--prompt-file", help="Path to candidate router prompt")
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
