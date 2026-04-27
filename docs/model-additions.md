---
title: Adding Models
---

Wavemill model support is deliberately explicit. When adding a new model, update each surface that can select, launch, price, or evaluate it.

## Checklist

1. Add pricing to the canonical config template in `shared/lib/config-sync.ts`, the install-time default config in `wavemill`, and the repo config if this repository should use it immediately.
2. Add the model to `challenge.models` so challenge mode can collect comparison data.
3. Map the model to its launcher in `router.agentMap`; OpenAI `gpt-*` models normally map to `codex`.
4. Add planner availability under `router.availableModels.planner` when the model is allowed to plan before there is eval history.
5. Add capabilities and ladder placement in `shared/lib/model-registry.ts`; this is what quota policy and class-aware fallback use.
6. Add the model to `DEFAULT_MODEL_POOL` and any role-specific frontier preference lists in `shared/lib/workflow-router.ts`.
7. Update DSPy routing metadata in `dspy/prepare_data.py`, `dspy/evaluators/model_router_evaluator.py`, `dspy/optimize.py`, and the active selector artifact when it carries explicit model candidates.
8. Update tests that assert exact default model lists or ladders.
9. Run focused config, registry, and router tests before merging.

For frontier models, use `class: "frontier"` in the registry and include the model in the planning, coding, and review ladders. Prefer putting same-vendor successors next to the previous model so quota fallback can substitute within the same class cleanly.
