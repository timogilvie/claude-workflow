"""
DSPy optimization for wavemill stage prompts (planner, coder, reviewer).

Uses MIPROv2 to optimize the instruction content of each stage prompt template,
then exports optimized templates that can be loaded by agent-adapters.sh.

Usage:
    cd dspy && python optimize_stages.py --stage planner
    cd dspy && python optimize_stages.py --stage coder
    cd dspy && python optimize_stages.py --stage reviewer
    cd dspy && python optimize_stages.py --stage all
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import dspy

from claude_cli_lm import ClaudeCLI

# Add evaluators to path
sys.path.insert(0, str(Path(__file__).resolve().parent / "evaluators"))
from data_loader import default_evals_path, load_eval_examples, stratified_split
from planner_evaluator import derive_plan_quality, planner_metric
from coder_evaluator import filter_with_impl_scores, get_impl_ground_truth, coder_metric
from reviewer_evaluator import derive_review_quality, reviewer_metric


# ── DSPy Signatures for each stage ──────────────────────────────────────────


class PlannerAssessor(dspy.Signature):
    """Assess the quality of an AI planning agent's work on a software task.

    Consider whether the plan correctly identifies scope, key files, dependencies,
    and potential risks. A good plan leads to smooth implementation without rework."""

    task_prompt: str = dspy.InputField(desc="The task description/ticket")
    repo_name: str = dspy.InputField(desc="Target repository name")
    overall_score: str = dspy.InputField(desc="Workflow outcome score (0-1)")
    intervention_count: str = dspy.InputField(desc="Number of human interventions needed")
    judge_rationale: str = dspy.InputField(desc="Eval judge's rationale for the score")

    plan_score: float = dspy.OutputField(desc="Plan quality score (0.0-1.0)")
    quality_band: str = dspy.OutputField(desc="Quality band: excellent, good, weak, or poor")
    reasoning: str = dspy.OutputField(desc="1-2 sentence explanation")


class CoderAssessor(dspy.Signature):
    """Assess the quality of an AI coding agent's implementation.

    Consider whether the implementation was correct, complete, followed good
    patterns, and required minimal rework or interventions."""

    task_prompt: str = dspy.InputField(desc="The task description/ticket")
    repo_name: str = dspy.InputField(desc="Target repository name")
    model_id: str = dspy.InputField(desc="Model used for implementation")
    overall_score: str = dspy.InputField(desc="Workflow outcome score (0-1)")
    intervention_count: str = dspy.InputField(desc="Number of interventions")
    judge_rationale: str = dspy.InputField(desc="Eval judge's rationale")

    implementation_score: float = dspy.OutputField(desc="Implementation quality score (0.0-1.0)")
    quality_band: str = dspy.OutputField(desc="Quality band: excellent, good, acceptable, or poor")
    reasoning: str = dspy.OutputField(desc="1-2 sentence explanation")


class ReviewerAssessor(dspy.Signature):
    """Assess the effectiveness of an AI agent's self-review phase.

    Consider whether the review caught real issues, whether post-PR fixes
    were needed, and whether the review was thorough without being overly strict."""

    task_prompt: str = dspy.InputField(desc="The task description/ticket")
    repo_name: str = dspy.InputField(desc="Target repository name")
    overall_score: str = dspy.InputField(desc="Workflow outcome score (0-1)")
    post_pr_commits: str = dspy.InputField(desc="Number of post-PR commits")
    review_comments: str = dspy.InputField(desc="Number of review comments")
    judge_rationale: str = dspy.InputField(desc="Eval judge's rationale")

    review_score: float = dspy.OutputField(desc="Review quality score (0.0-1.0)")
    quality_band: str = dspy.OutputField(desc="Quality band: excellent, good, weak, or poor")
    reasoning: str = dspy.OutputField(desc="1-2 sentence explanation")


# ── Data preparation ────────────────────────────────────────────────────────


def prepare_planner_examples(examples: list) -> list:
    """Convert eval examples to DSPy examples for planner optimization."""
    dspy_examples = []
    for ex in examples:
        gt = derive_plan_quality(ex)
        dspy_ex = dspy.Example(
            task_prompt=ex.original_prompt[:2000],
            repo_name=ex.source_repo or "unknown",
            overall_score=f"{ex.score:.2f}",
            intervention_count=str(ex.intervention_count),
            judge_rationale=ex.rationale[:500] if ex.rationale else "",
            # Labels
            ground_truth_plan_score=gt["score"],
            plan_score=gt["score"],
            quality_band=gt["band"],
            reasoning=gt["rationale"],
        ).with_inputs("task_prompt", "repo_name", "overall_score", "intervention_count", "judge_rationale")
        dspy_examples.append(dspy_ex)
    return dspy_examples


def prepare_coder_examples(examples: list) -> list:
    """Convert eval examples with impl stageScores to DSPy examples."""
    filtered = filter_with_impl_scores(examples)
    dspy_examples = []
    for ex in filtered:
        gt = get_impl_ground_truth(ex)
        dspy_ex = dspy.Example(
            task_prompt=ex.original_prompt[:2000],
            repo_name=ex.source_repo or "unknown",
            model_id=ex.model_id or "unknown",
            overall_score=f"{ex.score:.2f}",
            intervention_count=str(ex.intervention_count),
            judge_rationale=ex.rationale[:500] if ex.rationale else "",
            # Labels
            ground_truth_impl_score=gt["score"],
            implementation_score=gt["score"],
            quality_band=gt["band"],
            reasoning=gt["rationale"],
        ).with_inputs("task_prompt", "repo_name", "model_id", "overall_score", "intervention_count", "judge_rationale")
        dspy_examples.append(dspy_ex)
    return dspy_examples


def prepare_reviewer_examples(examples: list) -> list:
    """Convert eval examples to DSPy examples for reviewer optimization."""
    dspy_examples = []
    for ex in examples:
        gt = derive_review_quality(ex)

        # Extract intervention details
        intervention_summary = ex.metadata.get("interventionSummary", {})
        interventions = intervention_summary.get("interventions", [])
        post_pr = 0
        review_comments = 0
        for intervention in interventions:
            itype = intervention.get("type", "")
            count = intervention.get("count", 0)
            if itype == "post_pr_commit":
                post_pr = count
            elif itype == "review_comment":
                review_comments = count

        dspy_ex = dspy.Example(
            task_prompt=ex.original_prompt[:2000],
            repo_name=ex.source_repo or "unknown",
            overall_score=f"{ex.score:.2f}",
            post_pr_commits=str(post_pr),
            review_comments=str(review_comments),
            judge_rationale=ex.rationale[:500] if ex.rationale else "",
            # Labels
            ground_truth_review_score=gt["score"],
            review_score=gt["score"],
            quality_band=gt["band"],
            reasoning=gt["rationale"],
        ).with_inputs("task_prompt", "repo_name", "overall_score", "post_pr_commits", "review_comments", "judge_rationale")
        dspy_examples.append(dspy_ex)
    return dspy_examples


# ── Artifact export ─────────────────────────────────────────────────────────


def export_stage_artifact(
    stage: str,
    optimized_module,
    val_score: float,
    baseline_score: float,
    teacher_model: str,
    data_path: str,
    training_count: int,
    val_count: int,
) -> dict:
    """Export optimized stage prompt as a JSON artifact."""
    # Extract optimized instruction
    predict = getattr(optimized_module, "predict", optimized_module)
    sig = getattr(predict, "signature", None)
    instruction = ""
    if sig and hasattr(sig, "instructions"):
        instruction = sig.instructions
    if not instruction:
        ext_sig = getattr(predict, "extended_signature", None)
        if ext_sig and hasattr(ext_sig, "instructions"):
            instruction = ext_sig.instructions

    # Extract few-shot demos
    demos = getattr(predict, "demos", [])
    few_shots = []
    for demo in demos:
        few_shots.append({k: str(getattr(demo, k, "")) for k in dir(demo) if not k.startswith("_")})

    data_hash = hashlib.sha256(Path(data_path).read_bytes()).hexdigest()[:16]

    return {
        "version": "1.0.0",
        "stage": stage,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "optimizer": "MIPROv2",
        "teacher_model": teacher_model,
        "optimized_instruction": instruction,
        "few_shot_examples": few_shots,
        "metadata": {
            "training_records": training_count,
            "validation_records": val_count,
            "baseline_score": round(baseline_score, 4),
            "optimized_score": round(val_score, 4),
            "improvement": round(val_score - baseline_score, 4),
            "data_source": str(data_path),
            "data_hash": f"sha256:{data_hash}",
        },
    }


# ── Stage configurations ────────────────────────────────────────────────────


STAGES = {
    "planner": {
        "signature": PlannerAssessor,
        "metric": planner_metric,
        "prepare_data": prepare_planner_examples,
        "output_artifact": "artifacts/optimized-planner.json",
    },
    "coder": {
        "signature": CoderAssessor,
        "metric": coder_metric,
        "prepare_data": prepare_coder_examples,
        "output_artifact": "artifacts/optimized-coder.json",
    },
    "reviewer": {
        "signature": ReviewerAssessor,
        "metric": reviewer_metric,
        "prepare_data": prepare_reviewer_examples,
        "output_artifact": "artifacts/optimized-reviewer.json",
    },
}


# ── Main ────────────────────────────────────────────────────────────────────


def optimize_stage(
    stage: str,
    evals_path: Path,
    teacher_model: str,
    max_demos: int = 4,
    num_candidates: int = 5,
    threads: int = 4,
    use_api: bool = False,
    output: str | None = None,
) -> dict:
    """Run MIPROv2 optimization for a single stage."""
    config = STAGES[stage]

    print(f"\n{'=' * 60}")
    print(f"Optimizing: {stage}")
    print(f"{'=' * 60}")

    # Load and prepare data
    examples = load_eval_examples(evals_path, skip_aggregate=True)
    train_raw, val_raw = stratified_split(examples)

    train = config["prepare_data"](train_raw)
    val = config["prepare_data"](val_raw)

    print(f"  Data: {len(train)} train, {len(val)} val")

    if len(train) < 5:
        print(f"  SKIP: Not enough training data (need >= 5, have {len(train)})")
        return {"stage": stage, "error": "insufficient_data", "n_train": len(train)}

    # Build module
    module = dspy.ChainOfThought(config["signature"])
    metric = config["metric"]

    # Baseline
    print(f"  Evaluating baseline...")
    evaluator = dspy.Evaluate(devset=val, metric=metric, num_threads=threads, display_progress=True)
    baseline_score = float(evaluator(module))
    print(f"  Baseline score: {baseline_score:.4f}")

    # Optimize
    print(f"  Running MIPROv2 (candidates={num_candidates}, demos={max_demos})...")
    optimizer = dspy.MIPROv2(
        metric=metric,
        num_threads=threads,
        max_bootstrapped_demos=max_demos,
        max_labeled_demos=max_demos,
        num_candidates=num_candidates,
        auto=None,
    )
    optimized = optimizer.compile(
        module,
        trainset=train,
        valset=val,
        num_trials=num_candidates * 2,
        minibatch=False,
    )

    # Evaluate optimized
    print(f"  Evaluating optimized...")
    opt_score = float(evaluator(optimized))
    print(f"  Optimized score: {opt_score:.4f}")
    print(f"  Improvement: {opt_score - baseline_score:+.4f}")

    # Export
    output_path = Path(output or config["output_artifact"])
    artifact = export_stage_artifact(
        stage=stage,
        optimized_module=optimized,
        val_score=opt_score,
        baseline_score=baseline_score,
        teacher_model=teacher_model,
        data_path=str(evals_path),
        training_count=len(train),
        val_count=len(val),
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"  Artifact: {output_path}")

    return {
        "stage": stage,
        "baseline_score": baseline_score,
        "optimized_score": opt_score,
        "improvement": opt_score - baseline_score,
        "n_train": len(train),
        "n_val": len(val),
        "artifact": str(output_path),
    }


def main():
    parser = argparse.ArgumentParser(description="Optimize wavemill stage prompts with DSPy")
    parser.add_argument(
        "--stage",
        choices=["planner", "coder", "reviewer", "all"],
        required=True,
        help="Which stage to optimize",
    )
    parser.add_argument(
        "--evals",
        default="../.wavemill/evals/aggregated-evals.jsonl",
        help="Path to aggregated evals JSONL file",
    )
    parser.add_argument(
        "--teacher",
        default="claude-sonnet-4-5-20250929",
        help="Teacher model for optimization",
    )
    parser.add_argument("--max-demos", type=int, default=4, help="Max few-shot demos")
    parser.add_argument("--num-candidates", type=int, default=5, help="Instruction candidates")
    parser.add_argument("--threads", type=int, default=4, help="Parallel threads")
    parser.add_argument("--use-api", action="store_true", help="Use Anthropic API")
    parser.add_argument("--output-dir", default="artifacts", help="Output directory for artifacts")
    args = parser.parse_args()

    # Configure DSPy
    print(f"Configuring DSPy with teacher: {args.teacher}")
    if args.use_api:
        lm = dspy.LM(f"anthropic/{args.teacher}")
    else:
        lm = ClaudeCLI(model=args.teacher)
    dspy.configure(lm=lm)

    evals_path = Path(args.evals).resolve()

    stages = list(STAGES.keys()) if args.stage == "all" else [args.stage]

    results = {}
    for stage in stages:
        output = str(Path(args.output_dir) / f"optimized-{stage}.json")
        result = optimize_stage(
            stage=stage,
            evals_path=evals_path,
            teacher_model=args.teacher,
            max_demos=args.max_demos,
            num_candidates=args.num_candidates,
            threads=args.threads,
            use_api=args.use_api,
            output=output,
        )
        results[stage] = result

    # Summary
    print(f"\n{'=' * 60}")
    print("Optimization Summary")
    print(f"{'=' * 60}")
    for stage, result in results.items():
        if "error" in result:
            print(f"  {stage}: SKIPPED ({result['error']}, n={result.get('n_train', 0)})")
        else:
            print(f"  {stage}: {result['baseline_score']:.4f} -> {result['optimized_score']:.4f} ({result['improvement']:+.4f})")

    # Save summary
    summary_path = Path(args.output_dir) / "stage-optimization-summary.json"
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "teacher_model": args.teacher,
        "evals_path": str(evals_path),
        "results": results,
    }
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"\nSummary: {summary_path}")


if __name__ == "__main__":
    main()
