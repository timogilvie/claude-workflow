"""CLI runner for GEPA evaluators.

Runs one or all evaluators against the aggregated eval dataset.

Usage:
    # Run all evaluators (auto-aggregates fresh data first)
    python dspy/evaluators/run_evaluators.py

    # Run specific evaluator
    python dspy/evaluators/run_evaluators.py --evaluator issue-writer

    # Run with custom prompt variant
    python dspy/evaluators/run_evaluators.py --evaluator eval-judge --prompt-file ./my-variant.md

    # Skip aggregation (use existing data)
    python dspy/evaluators/run_evaluators.py --skip-aggregate

    # Dry run (aggregate + show dataset stats, no LLM calls)
    python dspy/evaluators/run_evaluators.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from data_loader import default_evals_path, load_eval_examples, stratified_split
from coder_evaluator import run_evaluation as run_coder
from eval_judge_evaluator import run_evaluation as run_eval_judge
from issue_writer_evaluator import run_evaluation as run_issue_writer
from model_router_evaluator import run_evaluation as run_model_router
from planner_evaluator import run_evaluation as run_planner
from reviewer_evaluator import run_evaluation as run_reviewer

EVALUATORS = {
    "issue-writer": run_issue_writer,
    "eval-judge": run_eval_judge,
    "model-router": run_model_router,
    "planner": run_planner,
    "coder": run_coder,
    "reviewer": run_reviewer,
}


def print_dataset_stats(evals_path: Path, skip_aggregate: bool) -> None:
    """Print dataset statistics."""
    examples = load_eval_examples(evals_path, skip_aggregate=skip_aggregate)
    train, val = stratified_split(examples)

    print(f"Dataset: {evals_path}")
    print(f"  Total records: {len(examples)}")
    print(f"  Train: {len(train)}, Val: {len(val)}")

    # Band distribution
    bands: dict[str, dict[str, int]] = {}
    for split_name, split_data in [("train", train), ("val", val)]:
        for ex in split_data:
            bands.setdefault(ex.score_band, {})
            bands[ex.score_band][split_name] = bands[ex.score_band].get(split_name, 0) + 1

    print("\n  Score band distribution:")
    print(f"  {'Band':<20} {'Train':>6} {'Val':>6} {'Total':>6}")
    print(f"  {'-'*40}")
    for band in sorted(bands.keys()):
        t = bands[band].get("train", 0)
        v = bands[band].get("val", 0)
        print(f"  {band:<20} {t:>6} {v:>6} {t+v:>6}")

    # Repo distribution
    repos: dict[str, int] = {}
    for ex in examples:
        repos[ex.source_repo] = repos.get(ex.source_repo, 0) + 1
    print(f"\n  Source repos: {len(repos)}")
    for repo, count in sorted(repos.items(), key=lambda x: -x[1]):
        print(f"    {repo}: {count}")


def main():
    parser = argparse.ArgumentParser(
        description="Run GEPA evaluators for wavemill tier-1 prompts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_evaluators.py --dry-run              # Show dataset stats only
  python run_evaluators.py --evaluator model-router --skip-aggregate
  python run_evaluators.py --evaluator eval-judge --prompt-file ./my-judge.md
  python run_evaluators.py --use-api              # Use Anthropic API (faster)
        """,
    )
    parser.add_argument(
        "--evaluator",
        choices=list(EVALUATORS.keys()),
        help="Run a specific evaluator (default: all)",
    )
    parser.add_argument(
        "--prompt-file",
        help="Path to candidate prompt file (overrides default for chosen evaluator)",
    )
    parser.add_argument(
        "--evals",
        help="Path to aggregated evals JSONL (default: auto-detect)",
    )
    parser.add_argument(
        "--skip-aggregate",
        action="store_true",
        help="Skip data aggregation step",
    )
    parser.add_argument(
        "--use-api",
        action="store_true",
        help="Use Anthropic API directly (requires ANTHROPIC_API_KEY)",
    )
    parser.add_argument(
        "--model",
        default="claude-sonnet-4-5-20250929",
        help="Model to use for LLM calls (default: claude-sonnet-4-5-20250929)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Load data and show stats without making LLM calls",
    )
    parser.add_argument(
        "--output",
        help="Write JSON results to this file",
    )
    args = parser.parse_args()

    # Validate that --prompt-file requires --evaluator
    if args.prompt_file and not args.evaluator:
        parser.error("--prompt-file requires --evaluator to be specified")

    evals_path = Path(args.evals) if args.evals else default_evals_path()

    print("=" * 60)
    print("GEPA Evaluators — Wavemill Tier-1 Prompts")
    print("=" * 60)
    print()

    # Always show dataset stats
    print_dataset_stats(evals_path, skip_aggregate=args.skip_aggregate)
    print()

    if args.dry_run:
        # Show per-evaluator dry-run stats
        evaluators_to_show = {args.evaluator: EVALUATORS[args.evaluator]} if args.evaluator else EVALUATORS
        for name, run_fn in evaluators_to_show.items():
            print(f"\n{'─' * 40}")
            print(f"  {name}:")
            try:
                run_fn(evals_path=str(evals_path), skip_aggregate=True, dry_run=True)
            except Exception as e:
                print(f"    Error: {e}")
        print("\nDry run complete. No LLM calls made.")
        return

    # Determine which evaluators to run
    if args.evaluator:
        evaluators_to_run = {args.evaluator: EVALUATORS[args.evaluator]}
    else:
        evaluators_to_run = EVALUATORS

    # Run evaluators
    all_results = {}
    for name, run_fn in evaluators_to_run.items():
        print(f"\n{'─' * 60}")
        print(f"Running: {name}")
        print(f"{'─' * 60}\n")

        kwargs = {
            "evals_path": str(evals_path),
            "skip_aggregate": True,  # Already aggregated above
            "use_api": args.use_api,
            "model": args.model,
            "dry_run": False,
        }

        # Pass prompt file only to the targeted evaluator
        if args.prompt_file:
            kwargs["prompt_file"] = args.prompt_file

        try:
            result = run_fn(**kwargs)
            all_results[name] = result
        except Exception as e:
            print(f"  FAILED: {e}")
            all_results[name] = {"error": str(e)}

    # Print summary
    print(f"\n{'=' * 60}")
    print("Summary")
    print(f"{'=' * 60}")
    for name, result in all_results.items():
        if "error" in result:
            print(f"  {name}: ERROR — {result['error']}")
        else:
            n = result.get("n_examples", 0)
            # Each evaluator uses a different primary metric name
            score = result.get("mean_score") or result.get("mean_agreement") or 0
            print(f"  {name}: {score:.3f} (n={n})")

    # Write output
    if args.output:
        output_data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "model": args.model,
            "use_api": args.use_api,
            "evals_path": str(evals_path),
            "results": {
                name: {k: v for k, v in result.items() if k != "results"}
                for name, result in all_results.items()
            },
        }
        Path(args.output).write_text(json.dumps(output_data, indent=2) + "\n")
        print(f"\nResults written to: {args.output}")


if __name__ == "__main__":
    main()
