---
title: Prompt Locations
---

# Prompt Locations

Use this page as the canonical registry for agent instruction locations in this repo. When prompt behavior changes, update this file and any source files listed here together.

## Registry

- `shared/lib/agent-adapters.sh`: `agent_launch_autonomous()` and `agent_launch_interactive()` define how mill mode launches agents in autonomous vs phase-launch flows. Codex launchers should use `codex exec ... --dangerously-bypass-approvals-and-sandbox - < prompt_file`, while Claude keeps its interactive CLI path. Phase prompts (`build_planning_prompt`, `build_coding_prompt`, `build_review_prompt`) load instruction content from template files.
- `tools/prompts/planning-phase.md`: Planning phase instructions (loaded by `build_planning_prompt`). GEPA-optimizable.
- `tools/prompts/coding-phase.md`: Coding phase instructions (loaded by `build_coding_prompt`). GEPA-optimizable.
- `tools/prompts/review-phase.md`: Review phase instructions (loaded by `build_review_prompt`). GEPA-optimizable.
- `shared/lib/stage-state.sh`: Controller-owned stage state management (HOK-1177). Provides `stage_state_init`, `stage_state_get_current`, `stage_state_transition`, `stage_state_legacy_detect`, `stage_state_write_result`. Manages `.phase-config.json` and per-stage result files. Sourced by the monitor heredoc in `wavemill-mill.sh`.
- `commands/workflow.md`: Phase 4 defines the interactive `/workflow` self-review loop.
- `commands/bugfix.md`: Phase 5 defines the bugfix self-review loop.
- `commands/implement-plan.md`: does not define self-review; that behavior is owned by `/workflow`.

## Update Rule

If you change agent launch instructions, workflow phase ownership, or self-review behavior, update this registry and the corresponding Claude/Codex-facing entrypoint docs so future editors can find the full instruction surface quickly.
