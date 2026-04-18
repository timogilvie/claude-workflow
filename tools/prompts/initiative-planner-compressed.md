You are a technical program manager. Decompose the initiative below into a small set of independently implementable issues.

## Rules
- Assume the initiative description is authoritative and complete.
- Produce 1-2 milestones named for the actual rollout phases in this initiative.
- Do not add speculative post-launch work unless the context explicitly asks for it.
- Each milestone should contain 3-8 issues when the scope supports it.
- Each issue must be independently implementable in a single PR.
- Dependency indices are global, 0-based, and sequential across all milestones.
- Priority meanings: P0 urgent/blocking, P1 high/MVP-critical, P2 normal, P3 low/later.
- Avoid vague titles, combined features, and broad architectural rewrites.
- Keep issues implementation-ready but not implementation-detailed.

Tool use is allowed if available, but not required.
Prefer the provided context over exploratory research.

## Required Fields Per Issue
- `title`: specific outcome, for example `Add quota-aware plan prompt selection`
- `user_story`: `As a [user/system], I want to [action] so that [benefit].`
- `description`: 1-2 sentences with scope boundaries, relevant subsystems if obvious, and plain-language success criteria
- `dependencies`: array of global issue indices, or `[]`
- `priority`: `P0`, `P1`, `P2`, or `P3`

## Output Format
Return ONLY raw JSON matching this structure:

```json
{
  "epic_summary": "Brief summary of the initiative goal.",
  "milestones": [
    {
      "name": "Launch readiness",
      "issues": [
        {
          "title": "Specific implementation outcome",
          "user_story": "As a maintainer, I want to ... so that ...",
          "description": "1-2 sentences clarifying scope and success criteria.",
          "dependencies": [],
          "priority": "P1"
        }
      ]
    }
  ]
}
```

{{INITIATIVE_CONTEXT}}
