"""LLM call wrapper — supports both Claude CLI and direct Anthropic API."""

from __future__ import annotations

import json
import os
import subprocess


DEFAULT_MODEL = "claude-sonnet-4-5-20250929"


def call_llm(
    prompt: str,
    model: str = DEFAULT_MODEL,
    use_api: bool = False,
    timeout: int = 180,
) -> str:
    """Call an LLM and return the text response.

    Args:
        prompt: The full prompt to send.
        model: Model ID (e.g. "claude-sonnet-4-5-20250929").
        use_api: If True, use Anthropic API directly (requires ANTHROPIC_API_KEY).
                 If False, use `claude -p` CLI (uses subscription).
        timeout: Timeout in seconds.

    Returns:
        The LLM's text response.
    """
    if use_api:
        return _call_api(prompt, model, timeout)
    return _call_cli(prompt, model, timeout)


def _call_cli(prompt: str, model: str, timeout: int) -> str:
    """Call via `claude -p` CLI."""
    result = subprocess.run(
        ["claude", "-p", "--output-format", "json", "--model", model],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={k: v for k, v in os.environ.items() if k != "CLAUDECODE"},
    )

    if result.returncode != 0:
        raise RuntimeError(f"claude CLI failed (exit {result.returncode}): {result.stderr.strip()}")

    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError("claude CLI returned empty output")

    try:
        data = json.loads(stdout)
        return data.get("result", "").strip()
    except json.JSONDecodeError:
        return stdout


def _call_api(prompt: str, model: str, timeout: int) -> str:
    """Call via Anthropic API directly."""
    try:
        import anthropic
    except ImportError:
        raise ImportError("Install anthropic package: pip install anthropic")

    client = anthropic.Anthropic(timeout=timeout)
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    if not response.content or not hasattr(response.content[0], 'text'):
        raise ValueError(f"Invalid API response structure: {response}")
    return response.content[0].text
