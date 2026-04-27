"""Shared utilities for DSPy evaluators."""

import json
import re


def coerce_score(value) -> float | None:
    """Coerce a value to a float score, returning None if not possible."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def extract_json_object(output: str) -> dict | None:
    """Extract and parse a JSON object from text output.

    Attempts to parse JSON from markdown code blocks and then from the raw text.
    """
    cleaned = re.sub(r"^```(?:json)?\s*", "", output.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)

    for candidate in [cleaned]:
        try:
            data = json.loads(candidate)
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{[\s\S]*\}", output)
    if match:
        try:
            data = json.loads(match.group())
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            pass

    return None
