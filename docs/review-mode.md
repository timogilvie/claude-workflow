---
title: Review Mode
---

Wavemill includes an LLM-powered code review system that catches major issues before PRs are created. It runs automatically as part of the feature workflow and can also be invoked standalone on branches or existing PRs.

## What It Does

- Diffs the current branch against the target branch (default: `main`).
- Gathers context: task packet, plan document, and design artifacts.
- Sends the diff and context to an LLM judge for structured review.
- Returns a verdict (`ready` / `not_ready`) with categorized findings.
- In workflow mode, iteratively fixes blockers and re-reviews (up to a configurable limit).

## How It Integrates

Review runs as **Phase 4** of the [Feature Workflow](feature-workflow.md), between implementation and validation:

```
Plan → Implement → Self-Review Loop → Validate → PR
```

After implementation completes, the agent:

1. Runs `review-changes.ts` against `main`.
2. If the verdict is `ready`, proceeds to validation.
3. If `not_ready`, reads the findings, fixes blockers, commits, and re-reviews.
4. Repeats up to `maxIterations` (default: 3).
5. Any remaining issues are surfaced in the validation phase.

## Standalone Usage

### Review current branch

```bash
# Review against main (default)
npx tsx tools/review-changes.ts

# Review against a different branch
npx tsx tools/review-changes.ts develop

# Verbose output with full debug info
npx tsx tools/review-changes.ts main --verbose

# Skip UI review
npx tsx tools/review-changes.ts main --skip-ui

# UI review only
npx tsx tools/review-changes.ts main --ui-only
```

### Review an existing PR

```bash
# Review PR #42 in the current repo
npx tsx tools/review-pr.ts 42

# Review PR in a different repo
npx tsx tools/review-pr.ts 42 --repo owner/repo-name
```

### Gather review context (without running review)

```bash
npx tsx tools/gather-review-context.ts main
```

Outputs JSON with diff, task packet, plan, design context, and metadata.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Review passed (`ready`) |
| `1` | Review failed (`not_ready`) |
| `2` | Error occurred |

## What Gets Reviewed

The review prompt focuses on **major issues only** — not style nits or subjective preferences.

### Code Review Categories

| Category | Examples |
|----------|----------|
| Logical errors | Off-by-one, null handling, race conditions, incorrect conditionals |
| Security | SQL injection, XSS, exposed secrets, missing auth checks |
| Requirements deviation | Missing planned features, wrong implementation approach |
| Error handling | Unhandled network failures, missing validation at system boundaries |
| Architectural consistency | Pattern violations, wrong abstraction layer, breaking changes |

### Plan Compliance (conditional)

When a task packet is available, the review also checks:

- **Acceptance criteria coverage** — are all criteria from the task packet addressed?
- **Unexpected deviations** — does the implementation diverge from the plan?
- **Missing planned items** — are any planned features absent from the diff?

### UI Review (conditional)

When design artifacts are detected (Tailwind config, component library, DESIGN.md, CSS variables), the review additionally checks:

- Visual consistency with design tokens
- Component library compliance
- Console error expectations (missing keys, hook violations)
- Responsive behavior
- Style guide adherence

## Context Gathering

The review tool automatically discovers context from the repository:

| Context | Source |
|---------|--------|
| Task packet | `features/{slug}/task-packet-header.md` + `task-packet-details.md`, or legacy `task-packet.md` |
| Plan | `features/{slug}/plan.md` or `bugs/{slug}/plan.md` |
| Tailwind config | `tailwind.config.{js,ts,mjs,cjs}` theme section |
| Component library | `package.json` dependencies (Radix, Headless UI, MUI, shadcn/ui) |
| Design guide | `DESIGN.md`, `STYLE-GUIDE.md` |
| CSS variables | `:root` blocks from global stylesheets |
| Design tokens | `tokens.json`, `design-tokens.json`, `theme.json` |
| Storybook | `.storybook/` directory or storybook dependency |

The slug is extracted from branch names matching `task/`, `feature/`, `bugfix/`, or `bug/` prefixes.

## Configuration

Review settings live in `.wavemill-config.json`:

```json
{
  "review": {
    "enabled": true,
    "maxIterations": 3
  },
  "eval": {
    "judge": {
      "model": "claude-sonnet-4-5-20250929",
      "provider": "anthropic"
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `review.enabled` | `true` | Enable/disable self-review in the workflow |
| `review.maxIterations` | `3` | Max review-fix cycles before proceeding |
| `eval.judge.model` | `claude-sonnet-4-5-20250929` | LLM model used for review |
| `eval.judge.provider` | `claude-cli` | Provider (`claude-cli` or `anthropic`) |

## Key Files

| File | Purpose |
|------|---------|
| `tools/review-changes.ts` | CLI tool — review current branch against target |
| `tools/review-pr.ts` | CLI tool — review a GitHub pull request |
| `tools/gather-review-context.ts` | CLI tool — output review context as JSON |
| `shared/lib/review-runner.ts` | Core review orchestration (context → prompt → LLM → parse) |
| `shared/lib/review-context-gatherer.ts` | Gathers diff, task packet, plan, and design context |
| `tools/prompts/review.md` | Review prompt template with evaluation criteria |

## See Also

- [Feature Workflow](feature-workflow.md) — the full workflow where self-review runs as Phase 4
- [Mill Mode](mill-mode.md) — autonomous backlog processing (uses review in each agent's workflow)
