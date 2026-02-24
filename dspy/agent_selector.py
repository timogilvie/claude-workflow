"""
DSPy Signature for the wavemill agent selector.

Defines the input/output contract for routing software engineering tasks
to the best AI agent and model.
"""

import dspy


class AgentSelector(dspy.Signature):
    """Route a software engineering task to the best AI agent and model.

    Consider task complexity, whether it modifies existing code or creates
    new code, the target repository's technology stack, and historical
    performance patterns. Prefer cheaper models when both options have
    similar expected outcomes."""

    # Inputs
    task_prompt: str = dspy.InputField(
        desc="The full task description or ticket packet (may be long)"
    )
    repo_name: str = dspy.InputField(
        desc="Target repository name, e.g. 'hokusai-site' or 'wavemill'"
    )
    task_type_hint: str = dspy.InputField(
        desc="Task category hint: feature, bugfix, refactor, test, documentation, infrastructure, or unknown"
    )
    available_models: str = dspy.InputField(
        desc="Comma-separated list of available model IDs to choose from"
    )

    # Outputs
    recommended_model: str = dspy.OutputField(
        desc="Model ID to use (must be from available_models list)"
    )
    recommended_agent: str = dspy.OutputField(
        desc="Agent CLI to use: 'claude' or 'codex'"
    )
    confidence: str = dspy.OutputField(
        desc="Routing confidence: 'high', 'medium', or 'low'"
    )
    risk_flags: list[str] = dspy.OutputField(
        desc="Risk signals, e.g. ['modifies-existing-runtime', 'large-scope-refactor', 'schema-migration']. Empty list if none."
    )
    cost_estimate: str = dspy.OutputField(
        desc="Expected cost band: 'low' (<$10), 'medium' ($10-25), or 'high' (>$25)"
    )
    reasoning: str = dspy.OutputField(
        desc="Brief 1-2 sentence explanation of routing decision"
    )
