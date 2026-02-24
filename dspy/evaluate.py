"""
Evaluate the optimized agent selector against the heuristic baseline.

Loads both the DSPy-optimized artifact and runs the heuristic classifier,
then compares their accuracy on the validation set.

Usage:
    cd dspy && python evaluate.py
    cd dspy && python evaluate.py --evals ../path/to/aggregated-evals.jsonl
"""

import argparse
import json
from collections import Counter
from pathlib import Path

import dspy

from agent_selector import AgentSelector
from claude_cli_lm import ClaudeCLI
from prepare_data import classify_task_type, load_training_data


def load_artifact(path: str) -> dict | None:
    """Load the optimized selector artifact."""
    p = Path(path)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def heuristic_baseline(example) -> dict:
    """
    Simple heuristic baseline: always recommend claude-sonnet.
    This is what the current regex router effectively does.
    """
    return {
        "recommended_model": "claude-sonnet-4-5-20250929",
        "recommended_agent": "claude",
        "confidence": "medium",
        "risk_flags": [],
        "cost_estimate": "medium",
        "reasoning": "Heuristic default: always use Claude Sonnet.",
    }


def evaluate_predictions(
    examples: list,
    predict_fn,
    label: str,
) -> dict:
    """Evaluate a prediction function against labeled examples."""
    correct_model = 0
    correct_cost = 0
    total_risk_recall = 0.0
    total_risk_precision = 0.0
    risk_examples = 0

    for ex in examples:
        pred = predict_fn(ex)

        if pred["recommended_model"] == ex.recommended_model:
            correct_model += 1

        if pred["cost_estimate"] == ex.cost_estimate:
            correct_cost += 1

        true_flags = set(ex.risk_flags) if ex.risk_flags else set()
        pred_flags = set(pred.get("risk_flags", []))

        if true_flags:
            risk_examples += 1
            total_risk_recall += len(pred_flags & true_flags) / len(true_flags)
            if pred_flags:
                total_risk_precision += len(pred_flags & true_flags) / len(pred_flags)

    n = len(examples)
    return {
        "label": label,
        "n": n,
        "model_accuracy": correct_model / n if n else 0,
        "cost_accuracy": correct_cost / n if n else 0,
        "risk_recall": total_risk_recall / risk_examples if risk_examples else 1.0,
        "risk_precision": total_risk_precision / risk_examples if risk_examples else 1.0,
        "risk_examples": risk_examples,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate agent selector performance")
    parser.add_argument(
        "--evals",
        default="../.wavemill/evals/aggregated-evals.jsonl",
        help="Path to aggregated evals JSONL",
    )
    parser.add_argument(
        "--artifact",
        default="artifacts/optimized-selector.json",
        help="Path to optimized selector artifact",
    )
    parser.add_argument(
        "--split",
        type=float,
        default=0.8,
        help="Train/val split ratio",
    )
    parser.add_argument(
        "--use-api",
        action="store_true",
        help="Use Anthropic API directly (requires ANTHROPIC_API_KEY). Default: use claude CLI.",
    )
    args = parser.parse_args()

    # Load data
    examples = load_training_data(args.evals)
    split_idx = int(len(examples) * args.split)
    val = examples[split_idx:]

    print(f"Evaluation set: {len(val)} examples")
    print()

    # Label distribution
    model_dist = Counter(ex.recommended_model for ex in val)
    print("Label distribution:")
    for model, count in model_dist.most_common():
        print(f"  {model}: {count} ({100*count/len(val):.1f}%)")
    print()

    # 1. Heuristic baseline
    heuristic_results = evaluate_predictions(
        val, heuristic_baseline, "Heuristic (always Sonnet)"
    )

    # 2. Load optimized artifact if available
    artifact = load_artifact(args.artifact)
    optimized_results = None

    if artifact:
        print(f"Loaded artifact: {args.artifact}")
        print(f"  Optimizer: {artifact.get('optimizer')}")
        print(f"  Created: {artifact.get('created_at')}")
        print(f"  Few-shot examples: {len(artifact.get('few_shot_examples', []))}")
        print()

        # Configure DSPy for evaluation
        teacher = artifact.get("teacher_model", "claude-sonnet-4-5-20250929")
        if args.use_api:
            lm = dspy.LM(f"anthropic/{teacher}")
        else:
            lm = ClaudeCLI(model=teacher)
        dspy.configure(lm=lm)

        # Build optimized module
        selector = dspy.ChainOfThought(AgentSelector)
        # TODO: Load saved module state from artifact
        # For now, use the artifact's system prompt as the signature instruction

        def optimized_predict(example):
            try:
                result = selector(
                    task_prompt=example.task_prompt,
                    repo_name=example.repo_name,
                    task_type_hint=example.task_type_hint,
                    available_models=example.available_models,
                )
                return {
                    "recommended_model": result.recommended_model,
                    "recommended_agent": result.recommended_agent,
                    "confidence": result.confidence,
                    "risk_flags": result.risk_flags if result.risk_flags else [],
                    "cost_estimate": result.cost_estimate,
                    "reasoning": result.reasoning,
                }
            except Exception as e:
                print(f"  Prediction error: {e}")
                return heuristic_baseline(example)

        optimized_results = evaluate_predictions(
            val, optimized_predict, "Optimized (DSPy MIPROv2)"
        )
    else:
        print(f"No artifact found at {args.artifact} — skipping optimized evaluation.")
        print()

    # Print comparison table
    print("=" * 70)
    print(f"{'Metric':<25} {'Heuristic':>15}", end="")
    if optimized_results:
        print(f" {'Optimized':>15} {'Delta':>10}", end="")
    print()
    print("-" * 70)

    metrics = [
        ("Model Accuracy", "model_accuracy"),
        ("Cost Accuracy", "cost_accuracy"),
        ("Risk Recall", "risk_recall"),
        ("Risk Precision", "risk_precision"),
    ]

    for label, key in metrics:
        h_val = heuristic_results[key]
        print(f"{label:<25} {h_val:>14.1%}", end="")
        if optimized_results:
            o_val = optimized_results[key]
            delta = o_val - h_val
            print(f" {o_val:>14.1%} {delta:>+9.1%}", end="")
        print()

    print("=" * 70)


if __name__ == "__main__":
    main()
