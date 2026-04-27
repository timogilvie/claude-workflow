---
title: Prompt Locations
---

# Prompt Locations

Use this page as the canonical registry for agent instruction locations in this repo. When prompt behavior changes, update this file and any source files listed here together.

Prompt templates are also mirrored into the first-class resource registry at `.wavemill/registry/resources.jsonl`. The legacy `.wavemill/evals/prompt-registry.jsonl` log remains for GEPA compatibility.

Runtime code should prefer typed lookup through `shared/lib/resource-retrieval.ts` when it needs prompt, memory, or policy assets. The backing files below remain the source of truth in phase one.

## Registry

- `shared/lib/agent-adapters.sh`: `agent_launch_autonomous()` and `agent_launch_interactive()` define how mill mode launches agents in autonomous vs phase-launch flows. Codex launchers should use `codex exec ... --dangerously-bypass-approvals-and-sandbox - < prompt_file`, while Claude keeps its interactive CLI path. Phase prompts (`build_planning_prompt`, `build_coding_prompt`, `build_review_prompt`) load instruction content from template files.
- `tools/prompts/planning-phase.md`: Planning phase instructions (loaded by `build_planning_prompt`). GEPA-optimizable.
- `tools/prompts/coding-phase.md`: Coding phase instructions (loaded by `build_coding_prompt`). GEPA-optimizable.
- `tools/prompts/review-phase.md`: Review phase instructions (loaded by `build_review_prompt`). GEPA-optimizable.
- `tools/prompts/review-general.md`: Default general-purpose review persona prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `shared/lib/review-engine.ts` in normal operating mode).
- `tools/prompts/review-general-scoped.md`: Degraded-mode scoped review persona prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `shared/lib/review-engine.ts` when operating mode is `constrained` or `survival`).
- `tools/prompts/initiative-planner.md`: Standard initiative decomposition prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `tools/plan-initiative.ts` via `shared/lib/plan-prompt-selector.ts`). Used when operating mode is `normal`. GEPA-optimizable.
- `tools/prompts/initiative-planner-compressed.md`: Compressed initiative decomposition prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `tools/plan-initiative.ts` via `shared/lib/plan-prompt-selector.ts`). Used when operating mode is `constrained` or `survival`. GEPA-optimizable.
- `.wavemill/project-context.md`: Typed `memory` lookup role `project-context`.
- `.wavemill/context/*.md`: Typed `memory` lookup role `subsystem-spec`.
- `.wavemill/context/concepts/*.md`: Typed `memory` lookup role `concept-page`.
- `.wavemill-config.json`: Typed `policy` lookup role `wavemill-config`.
- `commands/workflow.md`: Phase 4 defines the interactive `/workflow` self-review loop.
- `commands/bugfix.md`: Phase 5 defines the bugfix self-review loop.
- `commands/implement-plan.md`: does not define self-review; that behavior is owned by `/workflow`.

## Typed Lookup Status

- Migrated runtime callers: `shared/lib/plan-prompt-selector.ts`, `shared/lib/review-engine.ts`.
- Remaining direct path-backed surface: `shared/lib/agent-adapters.sh` phase prompt loading still reads `tools/prompts/*.md` directly.
- Stability and versioning: `resource-retrieval.ts` accepts `stability` and `version` fields, but phase one only supports `stable` and rejects explicit version selection until HOK-1379 lands.

## Update Rule

If you change agent launch instructions, workflow phase ownership, self-review behavior, or degraded-mode scoped review behavior, update this registry and the corresponding Claude/Codex-facing entrypoint docs so future editors can find the full instruction surface quickly.
