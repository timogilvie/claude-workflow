You are updating a subsystem specification document for AI agent consumption.

**Subsystem ID:** {SUBSYSTEM_ID}
**Task:** Generate an updated version of the subsystem spec based on current source files.

## Current Spec

```markdown
{CURRENT_SPEC}
```

## Current Source Files

```
{SOURCE_FILES}
```

## Recent Git Changes

{RECENT_CHANGES}

---

## Instructions

1. **Preserve structure**: Keep the exact section headings and table formats from the current spec
2. **Update timestamp**: Set "Last updated" to: {TIMESTAMP}
3. **Review source code**: Analyze the provided source files to understand current implementation
4. **Update Architectural Constraints**:
   - DO section: Add rules based on patterns you see in the code
   - DON'T section: Add anti-patterns or things to avoid
   - Keep each item concrete and actionable
5. **Update Known Failure Modes**: If you see error handling or edge cases in the code, document them
6. **Update Recent Changes**: Add a new entry summarizing the manual update at {TIMESTAMP}
7. **Preserve manual edits**: If the current spec has non-templated content (detailed notes, examples), keep it
8. **Keep it machine-readable**: Prefer tables and bullet lists over prose paragraphs

## Output Format

Output ONLY the updated markdown specification. No preamble, no explanation, no meta-commentary.

Start directly with:
```
# Subsystem: {subsystem name}
```

Maintain all sections from the template:
- Purpose
- Key Files
- Architectural Constraints (DO/DON'T)
- Known Failure Modes
- Testing Patterns
- Dependencies
- Recent Changes
