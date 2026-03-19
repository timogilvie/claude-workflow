"""Load eval records with stratified train/val splitting by scoreBand."""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class EvalExample:
    """A single eval record parsed into a typed structure."""

    id: str
    original_prompt: str
    score: float
    score_band: str
    issue_id: str = ""
    pr_url: str = ""
    model_id: str = ""
    rationale: str = ""
    intervention_count: int = 0
    intervention_details: list = field(default_factory=list)
    source_repo: str = ""
    workflow_cost: float | None = None
    time_seconds: int = 0
    metadata: dict = field(default_factory=dict)

    @classmethod
    def from_record(cls, record: dict) -> "EvalExample":
        return cls(
            id=record.get("id", ""),
            original_prompt=record.get("originalPrompt", ""),
            score=record.get("score", 0.0),
            score_band=record.get("scoreBand", ""),
            issue_id=record.get("issueId", ""),
            pr_url=record.get("prUrl", ""),
            model_id=record.get("modelId", ""),
            rationale=record.get("rationale", ""),
            intervention_count=record.get("interventionCount", 0),
            intervention_details=record.get("interventionDetails", []),
            source_repo=record.get("sourceRepo", ""),
            workflow_cost=record.get("workflowCost"),
            time_seconds=record.get("timeSeconds", 0),
            metadata=record.get("metadata", {}),
        )


def maybe_aggregate(
    evals_path: Path,
    discover_dir: str = "~/Dropbox",
    max_age_seconds: int = 3600,
) -> None:
    """Re-aggregate eval data if the file is stale or missing.

    Calls `npx tsx tools/aggregate-evals.ts --discover <dir>` unless
    the aggregated file was modified within max_age_seconds.
    """
    if evals_path.exists():
        age = time.time() - evals_path.stat().st_mtime
        if age < max_age_seconds:
            return

    discover_expanded = os.path.expanduser(discover_dir)

    # Find the wavemill repo root (where tools/ lives)
    repo_root = _find_repo_root()
    if not repo_root:
        print("  Warning: Could not find wavemill repo root, skipping aggregation")
        return

    cmd = ["npx", "tsx", "tools/aggregate-evals.ts", "--discover", discover_expanded]
    print(f"  Aggregating eval data from {discover_expanded}...")
    try:
        subprocess.run(cmd, cwd=repo_root, timeout=60, capture_output=True, text=True)
    except Exception as e:
        print(f"  Warning: Aggregation failed ({e}), using existing data")


def _find_repo_root() -> str | None:
    """Walk up from this file to find the wavemill repo root (has tools/ dir)."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "tools" / "aggregate-evals.ts").exists():
            return str(parent)
    return None


def load_eval_examples(
    evals_path: str | Path,
    skip_aggregate: bool = False,
    max_prompt_length: int = 8000,
) -> list[EvalExample]:
    """Load eval records from aggregated JSONL file.

    Args:
        evals_path: Path to aggregated-evals.jsonl
        skip_aggregate: If True, skip the aggregation step
        max_prompt_length: Truncate originalPrompt to this length

    Returns:
        List of EvalExample instances
    """
    evals_path = Path(evals_path)

    if not skip_aggregate:
        maybe_aggregate(evals_path)

    if not evals_path.exists():
        raise FileNotFoundError(f"Evals file not found: {evals_path}")

    examples = []
    for line in evals_path.read_text().strip().split("\n"):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not record.get("originalPrompt"):
            continue

        # Truncate long prompts
        if len(record.get("originalPrompt", "")) > max_prompt_length:
            record["originalPrompt"] = record["originalPrompt"][:max_prompt_length]

        examples.append(EvalExample.from_record(record))

    return examples


def stratified_split(
    examples: list[EvalExample],
    train_ratio: float = 0.8,
    seed: int = 42,
) -> tuple[list[EvalExample], list[EvalExample]]:
    """Split examples into train/val sets, stratified by scoreBand.

    Ensures each scoreBand is represented proportionally in both sets.

    Args:
        examples: Full list of examples
        train_ratio: Fraction to use for training (default 0.8)
        seed: Random seed for reproducibility

    Returns:
        (train_examples, val_examples) tuple
    """
    import random
    rng = random.Random(seed)

    # Group by scoreBand
    by_band: dict[str, list[EvalExample]] = {}
    for ex in examples:
        band = ex.score_band or "unknown"
        by_band.setdefault(band, []).append(ex)

    train, val = [], []
    for band, band_examples in by_band.items():
        rng.shuffle(band_examples)
        split_idx = max(1, int(len(band_examples) * train_ratio))
        # Ensure at least 1 in val if we have >= 2 examples
        if len(band_examples) >= 2 and split_idx == len(band_examples):
            split_idx = len(band_examples) - 1
        train.extend(band_examples[:split_idx])
        val.extend(band_examples[split_idx:])

    # Shuffle the combined sets
    rng.shuffle(train)
    rng.shuffle(val)

    return train, val


def default_evals_path() -> Path:
    """Return the default path to aggregated-evals.jsonl.

    Checks the current repo root first, then falls back to the main wavemill
    repo (useful when running from a git worktree where .wavemill/ doesn't exist).
    """
    repo_root = _find_repo_root()
    if repo_root:
        candidate = Path(repo_root) / ".wavemill" / "evals" / "aggregated-evals.jsonl"
        if candidate.exists():
            return candidate

    # Fallback: main wavemill repo at ~/Dropbox/wavemill
    fallback = Path.home() / "Dropbox" / "wavemill" / ".wavemill" / "evals" / "aggregated-evals.jsonl"
    if fallback.exists():
        return fallback

    # Return the repo-root path even if it doesn't exist (for error messages)
    if repo_root:
        return Path(repo_root) / ".wavemill" / "evals" / "aggregated-evals.jsonl"
    return fallback


if __name__ == "__main__":
    path = default_evals_path()
    print(f"Loading from: {path}")
    examples = load_eval_examples(path, skip_aggregate=True)
    print(f"Loaded {len(examples)} examples")

    train, val = stratified_split(examples)
    print(f"Split: {len(train)} train, {len(val)} val")

    # Band distribution
    print("\nBand distribution:")
    for split_name, split_data in [("train", train), ("val", val)]:
        bands: dict[str, int] = {}
        for ex in split_data:
            bands[ex.score_band] = bands.get(ex.score_band, 0) + 1
        print(f"  {split_name}: {dict(sorted(bands.items()))}")
