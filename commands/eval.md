Evaluate LLM performance on a completed workflow using the shared eval judge.

This command gathers context from a completed workflow and scores it using `evaluateTask()` from `shared/lib/eval.js`.

---

## Usage

### Auto-detect context (after a completed workflow)
```bash
npx tsx tools/eval-workflow.ts
```

### Evaluate a specific issue and PR
```bash
npx tsx tools/eval-workflow.ts --issue HOK-123 --pr 456
```

### Override the judge model
```bash
npx tsx tools/eval-workflow.ts --issue HOK-123 --pr 456 --model claude-opus-4-6
```

## How It Works

1. **Context Gathering** — Detects the most recent workflow from `.wavemill/workflow-state.json`, or uses explicit `--issue` and `--pr` arguments. Falls back to the current branch's open PR.

2. **Input Assembly** — Fetches the original issue description from Linear (task prompt) and the PR diff from GitHub (review output).

3. **LLM Judge** — Calls `evaluateTask()` which sends context to the Anthropic API using the rubric in `tools/prompts/eval-judge.md`. Returns an `EvalRecord` (defined in `shared/lib/eval-schema.ts`).

4. **Formatted Output** — Prints a human-readable score summary with score band, rationale, and intervention details.

## Scoring

Uses the 0–1 rubric from `shared/lib/eval-schema.ts`:
- **1.0** — Full Success (autonomous, production-ready)
- **0.8–0.9** — Minor Feedback (nearly autonomous)
- **0.5–0.7** — Assisted Success (required guidance)
- **0.2–0.4** — Partial (major gaps)
- **0.0–0.1** — Failure (not completed)

## Requirements

- `ANTHROPIC_API_KEY` — Required for the LLM judge
- `LINEAR_API_KEY` — For fetching issue details (optional)
- `gh` CLI — For PR diff fetching
