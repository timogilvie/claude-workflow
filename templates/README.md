# Shared Templates

The prompt templates in `tools/prompts/` are the single source of truth for both Claude and Codex workflows (PRD, tasks, bug investigation). The Claude commands reference them directly; Codex commands should read from the same files to avoid drift.

Key files:
- `tools/prompts/prd-prompt-template.md`
- `tools/prompts/tasks-prompt-template.md`
- `tools/prompts/bug-investigation-template.md`
- `tools/prompts/bug-hypothesis-template.md`
- `tools/prompts/bug-tasks-template.md`

When adding or updating templates, change them in `tools/prompts/` and consume them from there in both toolchains.
