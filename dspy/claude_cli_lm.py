"""
Custom DSPy LM that shells out to `claude -p` (the Claude CLI).

Uses the user's existing Claude subscription instead of requiring
an ANTHROPIC_API_KEY. This is slower than direct API calls but
free at the subscription tier.

Usage:
    import dspy
    from claude_cli_lm import ClaudeCLI

    lm = ClaudeCLI(model="claude-sonnet-4-5-20250929")
    dspy.configure(lm=lm)
"""

import json
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any

import dspy


# ── Response shim ────────────────────────────────────────────────────────────
# DSPy 3.x expects forward() to return an OpenAI-shaped response object
# with .choices, .usage, and .model attributes.


@dataclass
class _Message:
    content: str
    tool_calls: list | None = None


@dataclass
class _Choice:
    message: _Message
    logprobs: Any = None


@dataclass
class _Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def __iter__(self):
        yield "prompt_tokens", self.prompt_tokens
        yield "completion_tokens", self.completion_tokens
        yield "total_tokens", self.total_tokens


@dataclass
class _Response:
    choices: list[_Choice]
    usage: _Usage
    model: str
    _hidden_params: dict = field(default_factory=dict)


# ── Adapter ──────────────────────────────────────────────────────────────────


class ClaudeCLI(dspy.LM):
    """DSPy LM adapter that calls the `claude` CLI tool.

    Routes all LLM calls through `claude -p --output-format json`,
    which uses the user's Claude subscription (no API key needed).
    """

    def __init__(
        self,
        model: str = "claude-sonnet-4-5-20250929",
        timeout: int = 120,
        **kwargs,
    ):
        # Initialize the base LM with litellm-compatible model string.
        # We override forward() so litellm is never actually called.
        super().__init__(model=f"anthropic/{model}", model_type="chat", **kwargs)
        self.cli_model = model
        self.timeout = timeout

    def forward(
        self,
        prompt: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        **kwargs,
    ) -> _Response:
        """Call claude CLI and return an OpenAI-shaped response object."""

        # Convert messages to a single prompt string
        if messages:
            text = self._messages_to_prompt(messages)
        elif prompt:
            text = prompt
        else:
            raise ValueError("Either prompt or messages must be provided")

        # Call claude CLI
        result_text, usage_data = self._call_claude(text)

        # Build usage from CLI response
        usage = _Usage()
        if usage_data:
            usage = _Usage(
                prompt_tokens=usage_data.get("input_tokens", 0),
                completion_tokens=usage_data.get("output_tokens", 0),
                total_tokens=usage_data.get("input_tokens", 0) + usage_data.get("output_tokens", 0),
            )

        return _Response(
            choices=[_Choice(message=_Message(content=result_text))],
            usage=usage,
            model=self.cli_model,
        )

    def _messages_to_prompt(self, messages: list[dict[str, Any]]) -> str:
        """Convert chat messages to a single prompt string for claude -p."""
        parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # Handle content that's a list of blocks (multimodal)
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(block["text"])
                    elif isinstance(block, str):
                        text_parts.append(block)
                content = "\n".join(text_parts)

            if role == "system":
                parts.append(f"[System]\n{content}")
            elif role == "assistant":
                parts.append(f"[Assistant]\n{content}")
            else:
                parts.append(f"[User]\n{content}")

        return "\n\n".join(parts)

    def _call_claude(self, prompt: str) -> tuple[str, dict | None]:
        """Shell out to `claude -p` and parse the JSON response."""
        raw = subprocess.run(
            [
                "claude", "-p",
                "--output-format", "json",
                "--model", self.cli_model,
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=self.timeout,
            env={k: v for k, v in os.environ.items() if k != "CLAUDECODE"},
        )

        if raw.returncode != 0:
            stderr = raw.stderr.strip()
            raise RuntimeError(f"claude CLI failed (exit {raw.returncode}): {stderr}")

        stdout = raw.stdout.strip()
        if not stdout:
            raise RuntimeError("claude CLI returned empty output")

        # Parse JSON response
        try:
            data = json.loads(stdout)
            text = data.get("result", "").strip()
            usage = data.get("usage")
            return text, usage
        except json.JSONDecodeError:
            # Treat raw output as text
            return stdout, None
