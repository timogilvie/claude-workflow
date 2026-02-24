"""
DSPy optimization script for the wavemill agent selector.

Runs MIPROv2 to optimize the system prompt and few-shot examples,
then exports the result as a JSON artifact for the TypeScript runtime.

Usage:
    cd dspy && python optimize.py
    cd dspy && python optimize.py --evals ../path/to/aggregated-evals.jsonl
    cd dspy && python optimize.py --teacher claude-sonnet-4-5-20250929
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import dspy

from agent_selector import AgentSelector
from claude_cli_lm import ClaudeCLI
from prepare_data import load_training_data


# ── Metric ────────────────────────────────────────────────────────────────────


def routing_metric(example, prediction, trace=None) -> float:
    """
    Weighted scoring metric for the agent selector.

    Components:
    - Model selection accuracy (50%): did we pick the right model?
    - Risk flag recall (30%): did we catch the important risk signals?
    - Cost estimate accuracy (20%): did we predict the right cost band?
    """
    # Model selection accuracy (0 or 1)
    model_correct = float(
        prediction.recommended_model == example.recommended_model
    )

    # Risk flag recall
    pred_flags = set(prediction.risk_flags) if prediction.risk_flags else set()
    true_flags = set(example.risk_flags) if example.risk_flags else set()
    if len(true_flags) > 0:
        risk_recall = len(pred_flags & true_flags) / len(true_flags)
    else:
        # No true flags: penalize false positives lightly
        risk_recall = 1.0 if len(pred_flags) == 0 else 0.5

    # Cost estimate accuracy
    cost_correct = float(
        prediction.cost_estimate == example.cost_estimate
    )

    return 0.5 * model_correct + 0.3 * risk_recall + 0.2 * cost_correct


# ── Artifact Export ───────────────────────────────────────────────────────────


def extract_few_shot_examples(optimized_module) -> list[dict]:
    """Extract few-shot demonstrations from the optimized DSPy module."""
    examples = []

    # DSPy stores demos in the predict module
    predict = getattr(optimized_module, "predict", optimized_module)
    demos = getattr(predict, "demos", [])

    for demo in demos:
        example = {
            "task_prompt": getattr(demo, "task_prompt", ""),
            "repo_name": getattr(demo, "repo_name", ""),
            "task_type_hint": getattr(demo, "task_type_hint", ""),
            "available_models": getattr(demo, "available_models", ""),
            "recommended_model": getattr(demo, "recommended_model", ""),
            "recommended_agent": getattr(demo, "recommended_agent", ""),
            "confidence": getattr(demo, "confidence", ""),
            "risk_flags": getattr(demo, "risk_flags", []),
            "cost_estimate": getattr(demo, "cost_estimate", ""),
            "reasoning": getattr(demo, "reasoning", ""),
        }
        examples.append(example)

    return examples


def extract_system_prompt(optimized_module) -> str:
    """Extract the optimized system prompt/instruction from the DSPy module."""
    predict = getattr(optimized_module, "predict", optimized_module)

    # MIPROv2 stores optimized instructions in the signature's instructions field
    sig = getattr(predict, "signature", None)
    if sig and hasattr(sig, "instructions"):
        return sig.instructions

    # Fallback: check for extended_signature
    ext_sig = getattr(predict, "extended_signature", None)
    if ext_sig and hasattr(ext_sig, "instructions"):
        return ext_sig.instructions

    return AgentSelector.__doc__ or ""


def export_artifact(
    optimized_module,
    val_examples: list,
    val_score: float,
    teacher_model: str,
    runtime_model: str,
    data_path: str,
    training_count: int,
    val_count: int,
) -> dict:
    """Build the JSON artifact for the TypeScript runtime."""
    system_prompt = extract_system_prompt(optimized_module)
    few_shot_examples = extract_few_shot_examples(optimized_module)

    # Compute data hash for provenance
    data_hash = hashlib.sha256(Path(data_path).read_bytes()).hexdigest()[:16]

    return {
        "version": "1.0.0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "optimizer": "MIPROv2",
        "teacher_model": teacher_model,
        "runtime_model": runtime_model,
        "system_prompt": system_prompt,
        "few_shot_examples": few_shot_examples,
        "model_candidates": [
            "claude-sonnet-4-5-20250929",
            "gpt-5.3-codex",
            "claude-opus-4-6",
            "claude-haiku-4-5-20251001",
        ],
        "metadata": {
            "training_records": training_count,
            "validation_records": val_count,
            "val_score": round(val_score, 4),
            "data_source": str(data_path),
            "data_hash": f"sha256:{data_hash}",
        },
    }


# ── Main ──────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Optimize the wavemill agent selector with DSPy")
    parser.add_argument(
        "--evals",
        default="../.wavemill/evals/aggregated-evals.jsonl",
        help="Path to aggregated evals JSONL file",
    )
    parser.add_argument(
        "--teacher",
        default="claude-sonnet-4-5-20250929",
        help="Teacher model for optimization (default: sonnet)",
    )
    parser.add_argument(
        "--runtime",
        default="claude-haiku-4-5-20251001",
        help="Runtime model for inference (default: haiku)",
    )
    parser.add_argument(
        "--output",
        default="artifacts/optimized-selector.json",
        help="Output artifact path",
    )
    parser.add_argument(
        "--split",
        type=float,
        default=0.8,
        help="Train/val split ratio (default: 0.8)",
    )
    parser.add_argument(
        "--max-demos",
        type=int,
        default=4,
        help="Maximum few-shot demonstrations (default: 4)",
    )
    parser.add_argument(
        "--num-candidates",
        type=int,
        default=7,
        help="Number of instruction candidates to try (default: 7)",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=4,
        help="Number of parallel threads (default: 4)",
    )
    parser.add_argument(
        "--use-api",
        action="store_true",
        help="Use Anthropic API directly (requires ANTHROPIC_API_KEY). Default: use claude CLI.",
    )
    args = parser.parse_args()

    # 1. Configure DSPy
    print(f"Configuring DSPy with teacher model: {args.teacher}")
    if args.use_api:
        print("  Using Anthropic API directly (ANTHROPIC_API_KEY)")
        lm = dspy.LM(f"anthropic/{args.teacher}")
    else:
        print("  Using claude CLI (subscription)")
        lm = ClaudeCLI(model=args.teacher)
    dspy.configure(lm=lm)

    # 2. Load data
    evals_path = Path(args.evals).resolve()
    print(f"Loading training data from: {evals_path}")
    examples = load_training_data(evals_path)
    print(f"  Loaded {len(examples)} examples")

    if len(examples) < 10:
        print("ERROR: Need at least 10 examples for optimization.", file=sys.stderr)
        sys.exit(1)

    # 3. Split
    split_idx = int(len(examples) * args.split)
    train = examples[:split_idx]
    val = examples[split_idx:]
    print(f"  Split: {len(train)} train, {len(val)} val")

    # 4. Build module
    selector = dspy.ChainOfThought(AgentSelector)

    # 5. Evaluate baseline
    print("\nEvaluating baseline (unoptimized)...")
    baseline_evaluator = dspy.Evaluate(
        devset=val,
        metric=routing_metric,
        num_threads=args.threads,
        display_progress=True,
    )
    baseline_score = float(baseline_evaluator(selector))
    print(f"  Baseline val score: {baseline_score:.4f}")

    # 6. Optimize with MIPROv2
    print(f"\nRunning MIPROv2 optimization...")
    print(f"  Max demos: {args.max_demos}")
    print(f"  Instruction candidates: {args.num_candidates}")
    print(f"  Threads: {args.threads}")

    optimizer = dspy.MIPROv2(
        metric=routing_metric,
        num_threads=args.threads,
        max_bootstrapped_demos=args.max_demos,
        max_labeled_demos=args.max_demos,
        num_candidates=args.num_candidates,
        auto=None,
    )
    optimized = optimizer.compile(
        selector,
        trainset=train,
        valset=val,
        num_trials=args.num_candidates * 2,
        minibatch=False,
    )

    # 7. Evaluate optimized
    print("\nEvaluating optimized selector...")
    optimized_score = float(baseline_evaluator(optimized))
    print(f"  Optimized val score: {optimized_score:.4f}")
    print(f"  Improvement: {optimized_score - baseline_score:+.4f}")

    # 8. Export artifact
    artifact = export_artifact(
        optimized_module=optimized,
        val_examples=val,
        val_score=optimized_score,
        teacher_model=args.teacher,
        runtime_model=args.runtime,
        data_path=str(evals_path),
        training_count=len(train),
        val_count=len(val),
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, indent=2) + "\n")

    print(f"\nArtifact written to: {output_path}")
    print(f"  System prompt length: {len(artifact['system_prompt'])} chars")
    print(f"  Few-shot examples: {len(artifact['few_shot_examples'])}")
    print(f"  Val score: {artifact['metadata']['val_score']}")
    print(f"  Baseline: {baseline_score:.4f} -> Optimized: {optimized_score:.4f}")
    print(f"\nDone.")


if __name__ == "__main__":
    main()
