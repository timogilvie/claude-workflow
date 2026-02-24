# Feature Workflow

Use this mode when you want explicit planning, implementation checkpoints, and reviewable outputs for each Linear issue.

## Recommended Path

1. Select task from backlog and capture context in `features/<feature-name>/selected-task.json`.
2. Create implementation plan in `features/<feature-name>/plan.md`.
3. Get plan approval before coding.
4. Implement phase by phase.
5. Run tests/lint between phases.
6. Validate against plan and success criteria.
7. Create PR and link back to Linear issue.

## Why This Works for LLM Teams

- Linear remains the source of truth for priorities.
- Plan files provide durable handoff context.
- Validation gates reduce agent drift and regressions.
- PR body captures what changed, why, and how it was tested.

## Typical Commands

```bash
# start guided workflow (Codex prompt)
/prompts:workflow

# or run workflow helper directly
npm run workflow -w codex
```

If your process separates phases manually, keep these invariants:

- Never skip plan approval.
- Never skip test gates.
- Keep phase artifacts on disk (`selected-task.json`, `plan.md`, validation notes).

## PR Standards

Every PR should include:

- concise summary of intent
- key files/modules changed
- test plan and results
- link to the Linear issue (for example `HOK-779`)
