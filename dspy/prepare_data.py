"""
Convert aggregated eval records to DSPy training examples.

Reads aggregated-evals.jsonl and derives optimal routing labels
from historical outcomes.
"""

import json
import re
from pathlib import Path

import dspy

from agent_selector import AgentSelector


# ── Risk Flag Detection ───────────────────────────────────────────────────────

RISK_PATTERNS: dict[str, list[re.Pattern]] = {
    "modifies-existing-runtime": [
        re.compile(r"\b(fix|update|modify|change|patch|refactor)\b", re.I),
        re.compile(r"\b(existing|current|legacy)\b", re.I),
        re.compile(r"\bquery\b.*\b(prisma|sql)\b", re.I),
    ],
    "schema-migration": [
        re.compile(r"\bprisma\b", re.I),
        re.compile(r"\bmigration\b", re.I),
        re.compile(r"\bbackward.?compat", re.I),
        re.compile(r"\bschema\b.*\b(change|update|add)\b", re.I),
    ],
    "large-scope-refactor": [
        re.compile(r"\bmodulariz", re.I),
        re.compile(r"\brestructur", re.I),
        re.compile(r"\brefactor\b", re.I),
    ],
    "cross-service": [
        re.compile(r"\bcross[- ]?repo\b", re.I),
        re.compile(r"\bmulti[- ]?service\b", re.I),
        re.compile(r"\bauth[- ]?service\b.*\bsite\b", re.I),
    ],
    "rsc-serialization": [
        re.compile(r"\bserver.?component", re.I),
        re.compile(r"\bRSC\b"),
        re.compile(r"\bserialization\b", re.I),
    ],
    "test-infrastructure": [
        re.compile(r"\bfix.*test", re.I),
        re.compile(r"\bpytest\b", re.I),
        re.compile(r"\bCI\b.*\b(fix|broken|fail)", re.I),
    ],
}


def detect_risk_flags(prompt: str) -> list[str]:
    """Detect risk flags from prompt text using keyword patterns.

    Uses strict thresholds to keep flags discriminative — a flag that fires
    on 80% of tasks provides no routing signal.
    """
    flags = []

    # Strict thresholds per flag type
    THRESHOLDS = {
        "modifies-existing-runtime": 3,   # Need strong signal: fix + existing + query
        "schema-migration": 2,            # Prisma + migration or backward compat
        "large-scope-refactor": 2,        # Need explicit refactor/restructure keywords
        "cross-service": 2,               # Rare, keep sensitive
        "rsc-serialization": 1,           # Very specific technical flag
        "test-infrastructure": 2,         # Fix + test or pytest + CI
    }

    for flag_name, patterns in RISK_PATTERNS.items():
        matches = sum(1 for p in patterns if p.search(prompt))
        threshold = THRESHOLDS.get(flag_name, 2)
        if matches >= threshold:
            flags.append(flag_name)

    return flags


# ── Task Type Classification ──────────────────────────────────────────────────

TASK_TYPE_PATTERNS: list[tuple[str, list[re.Pattern]]] = [
    ("bugfix", [re.compile(r"\bfix\b", re.I), re.compile(r"\bbug\b", re.I),
                re.compile(r"\bbroken\b", re.I), re.compile(r"\berror\b", re.I)]),
    ("refactor", [re.compile(r"\brefactor\b", re.I), re.compile(r"\brestructur", re.I),
                  re.compile(r"\bclean\s*up\b", re.I)]),
    ("test", [re.compile(r"\btests?\b", re.I), re.compile(r"\bspec\b", re.I),
              re.compile(r"\bcoverage\b", re.I)]),
    ("documentation", [re.compile(r"\bdocument", re.I), re.compile(r"\breadme\b", re.I)]),
    ("infrastructure", [re.compile(r"\bdeploy", re.I), re.compile(r"\bdocker", re.I),
                        re.compile(r"\bmigration\b", re.I)]),
    ("feature", [re.compile(r"\badd\b", re.I), re.compile(r"\bimplement", re.I),
                 re.compile(r"\bcreate\b", re.I), re.compile(r"\bnew\b", re.I)]),
]


def classify_task_type(prompt: str) -> str:
    """Classify prompt into a task type using keyword matching."""
    for task_type, patterns in TASK_TYPE_PATTERNS:
        for pattern in patterns:
            if pattern.search(prompt):
                return task_type
    return "unknown"


# ── Greenfield Detection ─────────────────────────────────────────────────────

GREENFIELD_PATTERNS = [
    re.compile(r"\bnew\s+(page|component|endpoint|service)\b", re.I),
    re.compile(r"\bcreate\s+(a|the|new)\b", re.I),
    re.compile(r"\badd\s+(a|the|new)\b", re.I),
    re.compile(r"\bbuild\s+(a|the|new)\b", re.I),
]

MODIFICATION_PATTERNS = [
    re.compile(r"\bfix\b", re.I),
    re.compile(r"\bupdate\b", re.I),
    re.compile(r"\bmodify\b", re.I),
    re.compile(r"\brefactor\b", re.I),
    re.compile(r"\bchange\b", re.I),
    re.compile(r"\bremove\b", re.I),
    re.compile(r"\bexisting\b", re.I),
]


def is_greenfield(prompt: str) -> bool:
    """Estimate whether a task is greenfield (new code) vs modification."""
    greenfield_score = sum(1 for p in GREENFIELD_PATTERNS if p.search(prompt))
    modification_score = sum(1 for p in MODIFICATION_PATTERNS if p.search(prompt))
    return greenfield_score > modification_score


# ── Label Derivation ─────────────────────────────────────────────────────────

# Agent resolution: model prefix -> agent CLI
AGENT_MAP = {
    "claude-opus-4-6": "claude",
    "claude-sonnet-4-5-20250929": "claude",
    "claude-haiku-4-5-20251001": "claude",
    "gpt-5.3-codex": "codex",
}

DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
AVAILABLE_MODELS = "claude-sonnet-4-5-20250929,gpt-5.3-codex"


def resolve_agent(model_id: str) -> str:
    """Map model ID to agent CLI."""
    if model_id in AGENT_MAP:
        return AGENT_MAP[model_id]
    if model_id.startswith("claude-"):
        return "claude"
    if model_id.startswith("gpt-") or re.match(r"^o\d", model_id):
        return "codex"
    return "claude"


def derive_cost_band(cost: float | None) -> str:
    """Derive cost band from workflow cost."""
    if cost is None:
        return "medium"
    if cost < 10:
        return "low"
    if cost <= 25:
        return "medium"
    return "high"


def derive_confidence(score: float, intervention_count: int) -> str:
    """Derive confidence from outcome quality."""
    if score >= 0.95 and intervention_count == 0:
        return "high"
    if score >= 0.80:
        return "medium"
    return "low"


def derive_optimal_routing(record: dict) -> dict:
    """
    Given a historical eval record, derive what the OPTIMAL routing
    decision would have been.

    Logic:
    1. If score >= 0.85 and interventions <= 1: the model used was correct.
    2. If codex + low score + existing-code task: should have been claude.
    3. If claude + high score + greenfield: codex would have been cheaper.
    4. Otherwise: default to claude-sonnet (safest).
    """
    prompt = record.get("originalPrompt", "")
    model_id = record.get("modelId", DEFAULT_MODEL)
    score = record.get("score", 0.0)
    intervention_count = record.get("interventionCount", 0)
    workflow_cost = record.get("workflowCost")
    greenfield = is_greenfield(prompt)

    # Determine the right model
    if model_id == "gpt-5.3-codex" and score < 0.85:
        # Codex failed — should have been Claude (especially if not greenfield)
        recommended_model = DEFAULT_MODEL
    elif greenfield and score >= 0.90 and intervention_count == 0:
        # Successful greenfield task — codex would be equally effective and cheaper
        recommended_model = "gpt-5.3-codex"
    elif score >= 0.85 and intervention_count <= 1:
        # This model worked well — keep it
        recommended_model = model_id
    else:
        # Default to safest option
        recommended_model = DEFAULT_MODEL

    risk_flags = detect_risk_flags(prompt)
    cost_band = derive_cost_band(workflow_cost)
    confidence = derive_confidence(score, intervention_count)

    return {
        "recommended_model": recommended_model,
        "recommended_agent": resolve_agent(recommended_model),
        "confidence": confidence,
        "risk_flags": risk_flags,
        "cost_estimate": cost_band,
        "reasoning": _build_reasoning(recommended_model, risk_flags, greenfield, score),
    }


def _build_reasoning(model: str, risk_flags: list[str], greenfield: bool, score: float) -> str:
    """Build a brief reasoning string."""
    parts = []
    agent = resolve_agent(model)

    if greenfield and model == "gpt-5.3-codex":
        parts.append("Greenfield task suitable for Codex at lower cost.")
    elif risk_flags:
        parts.append(f"Risk flags [{', '.join(risk_flags)}] suggest using {agent}.")
    elif score >= 0.95:
        parts.append(f"High-confidence routing to {agent} based on historical success.")
    else:
        parts.append(f"Default routing to {agent}.")

    return " ".join(parts)


# ── Data Loading ──────────────────────────────────────────────────────────────


def load_training_data(
    evals_path: str | Path,
    max_prompt_length: int = 2000,
) -> list[dspy.Example]:
    """
    Load aggregated eval records and convert to labeled DSPy examples.

    Args:
        evals_path: Path to aggregated-evals.jsonl
        max_prompt_length: Truncate task prompts to this length

    Returns:
        List of DSPy Examples with inputs and labels
    """
    evals_path = Path(evals_path)
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

        prompt = record.get("originalPrompt", "")
        if not prompt:
            continue

        repo_name = record.get("sourceRepo", "unknown")
        task_type = classify_task_type(prompt)
        labels = derive_optimal_routing(record)

        example = dspy.Example(
            task_prompt=prompt[:max_prompt_length],
            repo_name=repo_name,
            task_type_hint=task_type,
            available_models=AVAILABLE_MODELS,
            recommended_model=labels["recommended_model"],
            recommended_agent=labels["recommended_agent"],
            confidence=labels["confidence"],
            risk_flags=labels["risk_flags"],
            cost_estimate=labels["cost_estimate"],
            reasoning=labels["reasoning"],
        ).with_inputs("task_prompt", "repo_name", "task_type_hint", "available_models")

        examples.append(example)

    return examples


if __name__ == "__main__":
    import sys

    evals_path = sys.argv[1] if len(sys.argv) > 1 else "../.wavemill/evals/aggregated-evals.jsonl"
    examples = load_training_data(evals_path)

    print(f"Loaded {len(examples)} training examples")
    print()

    # Summary
    model_counts: dict[str, int] = {}
    risk_counts: dict[str, int] = {}
    cost_counts: dict[str, int] = {}

    for ex in examples:
        model = ex.recommended_model
        model_counts[model] = model_counts.get(model, 0) + 1

        cost = ex.cost_estimate
        cost_counts[cost] = cost_counts.get(cost, 0) + 1

        for flag in ex.risk_flags:
            risk_counts[flag] = risk_counts.get(flag, 0) + 1

    print("Model distribution:")
    for model, count in sorted(model_counts.items(), key=lambda x: -x[1]):
        print(f"  {model}: {count}")

    print("\nCost distribution:")
    for cost, count in sorted(cost_counts.items(), key=lambda x: -x[1]):
        print(f"  {cost}: {count}")

    print("\nRisk flag frequency:")
    for flag, count in sorted(risk_counts.items(), key=lambda x: -x[1]):
        print(f"  {flag}: {count}")
