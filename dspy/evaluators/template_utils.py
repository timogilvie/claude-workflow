"""Template filling utility — mirrors the TypeScript fillPromptTemplate."""

from __future__ import annotations

import re


def fill_template(template: str, variables: dict[str, str]) -> str:
    """Replace {{PLACEHOLDER}} patterns in template with variable values.

    Args:
        template: Template string with {{VAR}} placeholders.
        variables: Mapping of variable names to replacement values.
                   Keys should be uppercase without braces (e.g. "ISSUE_CONTEXT").

    Returns:
        Filled template string. Unmatched placeholders are left as-is.
    """
    result = template
    for key, value in variables.items():
        result = result.replace(f"{{{{{key}}}}}", value)
    return result


def extract_placeholders(template: str) -> list[str]:
    """Extract all {{PLACEHOLDER}} names from a template."""
    return re.findall(r"\{\{([A-Z_]+)\}\}", template)
