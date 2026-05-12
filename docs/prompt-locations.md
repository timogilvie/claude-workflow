---
title: Prompt Locations
---

# Prompt Locations

Use this page as the canonical registry for agent instruction locations in this repo. When prompt behavior changes, update this file and any source files listed here together.

Prompt templates are also mirrored into the first-class resource registry at `.wavemill/registry/resources.jsonl`. The legacy `.wavemill/evals/prompt-registry.jsonl` log remains for GEPA compatibility.

Planner and reviewer phase prompts now resolve through `tools/resolve-runtime-resource.ts`, which applies governed runtime selection before `shared/lib/agent-adapters.sh` performs placeholder substitution. If runtime selection fails, the shell layer logs a warning and falls back to the static prompt file.
Runtime code should prefer typed lookup through `shared/lib/resource-retrieval.ts` when it needs prompt, memory, or policy assets. The backing files below remain the source of truth in phase one.

## Registry

- `shared/lib/agent-adapters.sh`: `agent_launch_autonomous()` and `agent_launch_interactive()` define how mill mode launches agents in autonomous vs phase-launch flows. Codex launchers should use `codex exec ... --dangerously-bypass-approvals-and-sandbox - < prompt_file`, while Claude keeps its interactive CLI path. Active phase prompts are `build_planning_prompt`, `build_coding_prompt`, and `build_review_prompt`; `build_planning_prompt` and `build_review_prompt` call `tools/resolve-runtime-resource.ts` before loading prompt content while `build_coding_prompt` still reads `tools/prompts/coding-phase.md` directly and appends the `.coding-blocked-completion.json` fallback guidance for coding-phase verification blockers. `build_autonomous_prompt` has been removed; `build_routing_prompt` and `build_interactive_prompt` remain legacy test-only render paths.
- `tools/prompts/planning-phase.md`: Planning phase instructions (loaded by `build_planning_prompt`). GEPA-optimizable.
- `tools/prompts/coding-phase.md`: Coding phase instructions (loaded by `build_coding_prompt`). GEPA-optimizable.
- `tools/prompts/review-phase.md`: Review phase instructions (loaded by `build_review_prompt`). GEPA-optimizable.
- `tools/resolve-runtime-resource.ts`: Shell-safe runtime resolver for planner/reviewer prompt content plus selection metadata.
- `shared/lib/blocked-completion.ts`: Shared validation/read helper for the coding blocked-completion artifact contract.
- `shared/schemas/blocked-completion.schema.json`: JSON Schema mirror for `.coding-blocked-completion.json`.
- `tools/prompts/review-general.md`: Default general-purpose review persona prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `shared/lib/review-engine.ts` in normal operating mode).
- `tools/prompts/review-general-scoped.md`: Degraded-mode scoped review persona prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `shared/lib/review-engine.ts` when operating mode is `constrained` or `survival`).
- `tools/prompts/initiative-planner.md`: Standard initiative decomposition prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `tools/plan-initiative.ts` via `shared/lib/plan-prompt-selector.ts`). Used when operating mode is `normal`. GEPA-optimizable.
- `tools/prompts/initiative-planner-compressed.md`: Compressed initiative decomposition prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `tools/plan-initiative.ts` via `shared/lib/plan-prompt-selector.ts`). Used when operating mode is `constrained` or `survival`. GEPA-optimizable.
- `tools/prompts/issue-writer.md`: Expand-mode task packet generation template. Keep section naming and Key Files semantics aligned with `shared/lib/task-packet-validator.ts`.
- `shared/lib/task-packet-validator.ts`: Expand-mode quality gate for task-packet structure and path semantics. Update in lockstep with `tools/prompts/issue-writer.md` when changing validation-section or Key Files contracts.
- `.wavemill/project-context.md`: Typed `memory` lookup role `project-context`.
- `.wavemill/context/*.md`: Typed `memory` lookup role `subsystem-spec`.
- `.wavemill/context/concepts/*.md`: Typed `memory` lookup role `concept-page`.
- `.wavemill-config.json`: Typed `policy` lookup role `wavemill-config`.
- `commands/workflow.md`: Phase 4 defines the interactive `/workflow` self-review loop.
- `commands/bugfix.md`: Phase 5 defines the bugfix self-review loop.
- `commands/implement-plan.md`: does not define self-review; that behavior is owned by `/workflow`.
- `shared/lib/wavemill-startup-runner.sh`: active startup launch path used by `wavemill-mill.sh` to enter planning.
- `docs/routing-contract.md`: bootstrap, expanded, and authoritative execution route lifecycle for mill-mode routing.
- `shared/lib/wavemill-orchestrator.sh`: deprecated compatibility wrapper that delegates to `wavemill-startup-runner.sh`.
- `codex/prompts/*.md` plus `codex/src/commands/workflow.js`: intentional Codex-native parallel workflow; these prompts are not built through `shared/lib/agent-adapters.sh`.

## Typed Lookup Status

- Migrated runtime callers: `shared/lib/plan-prompt-selector.ts`, `shared/lib/review-engine.ts`.
- Remaining direct path-backed surface: `shared/lib/agent-adapters.sh` phase prompt loading still reads `tools/prompts/*.md` directly.
- Stability and versioning: `resource-retrieval.ts` accepts `stability` and `version` fields, but phase one only supports `stable` and rejects explicit version selection until HOK-1379 lands.

## Update Rule

If you change agent launch instructions, workflow phase ownership, self-review behavior, or degraded-mode scoped review behavior, update this registry and the corresponding Claude/Codex-facing entrypoint docs so future editors can find the full instruction surface quickly.
