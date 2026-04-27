---
title: Prompt Locations
---

# Prompt Locations

Use this page as the canonical registry for agent instruction locations in this repo. When prompt behavior changes, update this file and any source files listed here together.

Prompt templates are also mirrored into the first-class resource registry at `.wavemill/registry/resources.jsonl`. The legacy `.wavemill/evals/prompt-registry.jsonl` log remains for GEPA compatibility.

## Typed Retrieval API

The canonical way to load prompts in TypeScript is via `shared/lib/resource-retrieval.ts`. Instead of constructing file paths, callers describe what capability they need and the API resolves to the correct backing file:

```typescript
import { resolvePromptResource } from './resource-retrieval.ts';

// Stable reviewer prompt for constrained mode
const scoped = await resolvePromptResource({
  class: 'prompt',
  stage: 'review',
  role: 'reviewer',
  operatingMode: 'constrained',
  persona: 'general',
});
// → resolves to tools/prompts/review-general-scoped.md

// Planning phase prompt (normal mode)
const planning = await resolvePromptResource({
  class: 'prompt',
  stage: 'planning',
  role: 'phase',
});
// → resolves to tools/prompts/planning-phase.md
```

Path-based helpers remain available for compatibility but typed retrieval is preferred for new code.

## Backing Files

Backing storage stays in `tools/prompts/`. The `PROMPT_CATALOG` in `shared/lib/resource-retrieval.ts` maps contract fields to file names.

## Registry

- `shared/lib/agent-adapters.sh`: `agent_launch_autonomous()` and `agent_launch_interactive()` define how mill mode launches agents in autonomous vs phase-launch flows. Codex launchers should use `codex exec ... --dangerously-bypass-approvals-and-sandbox - < prompt_file`, while Claude keeps its interactive CLI path. Phase prompts (`build_planning_prompt`, `build_coding_prompt`, `build_review_prompt`) load instruction content from template files.
- `tools/prompts/planning-phase.md`: Planning phase instructions (loaded by `build_planning_prompt`). Typed key: `stage='planning', role='phase'`. GEPA-optimizable.
- `tools/prompts/coding-phase.md`: Coding phase instructions (loaded by `build_coding_prompt`). Typed key: `stage='coding', role='phase'`. GEPA-optimizable.
- `tools/prompts/review-phase.md`: Review phase instructions (loaded by `build_review_prompt`). Typed key: `stage='review', role='phase'`. GEPA-optimizable.
- `tools/prompts/review-general.md`: Default general-purpose review persona prompt. Typed key: `stage='review', role='reviewer', operatingMode='normal', persona='general'`.
- `tools/prompts/review-general-scoped.md`: Degraded-mode scoped review persona prompt. Typed key: `stage='review', role='reviewer', operatingMode='constrained'|'survival', persona='general'`.
- `tools/prompts/initiative-planner.md`: Standard initiative decomposition prompt. Typed key: `stage='initiative-planning', role='planner', operatingMode='normal'`. GEPA-optimizable.
- `tools/prompts/initiative-planner-compressed.md`: Compressed initiative decomposition prompt. Typed key: `stage='initiative-planning', role='planner', operatingMode='constrained'|'survival'`. GEPA-optimizable.
- `tools/prompts/eval-judge.md`: Eval judge prompt. Typed key: `stage='eval', role='judge'`.
- `tools/prompts/issue-writer.md`: Issue expansion prompt. Typed key: `stage='issue-expansion', role='writer'`.
- `tools/prompts/context-update-template.md`: Context update prompt. Typed key: `stage='context-update', role='context-updater'`.
- `commands/workflow.md`: Phase 4 defines the interactive `/workflow` self-review loop.
- `commands/bugfix.md`: Phase 5 defines the bugfix self-review loop.
- `commands/implement-plan.md`: does not define self-review; that behavior is owned by `/workflow`.

## Update Rule

If you change agent launch instructions, workflow phase ownership, self-review behavior, or degraded-mode scoped review behavior, update this registry and the corresponding Claude/Codex-facing entrypoint docs so future editors can find the full instruction surface quickly.
