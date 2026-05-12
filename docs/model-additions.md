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
6. If the model requires a provider-specific launcher path, add the provider gate in `.wavemill-config.json`, `wavemill-config.schema.json`, and the launcher/session-cost/eval attribution paths before exposing the model to routing.
7. Add the model to `DEFAULT_MODEL_POOL` and any role-specific frontier preference lists in `shared/lib/workflow-router.ts`.
8. Update DSPy routing metadata in `dspy/prepare_data.py`, `dspy/evaluators/model_router_evaluator.py`, `dspy/optimize.py`, and the active selector artifact when it carries explicit model candidates.
9. Update tests that assert exact default model lists or ladders.
10. Run focused config, registry, router, and provider-launch tests before merging.

For frontier models, use `class: "frontier"` in the registry and include the model in the planning, coding, and review ladders. Prefer putting same-vendor successors next to the previous model so quota fallback can substitute within the same class cleanly.

## Family Aliases

Family aliases are stable developer-facing names that parse into `ModelSelector` values in `shared/lib/model-registry.ts`. `parseModelSelector` only validates selector syntax and shape; it does not resolve aliases against the active registry.

| Family | Recommended model ID | Notes |
| --- | --- | --- |
| `opus` | `claude-opus-4-7` | Stable Anthropic frontier alias. |
| `sonnet` | `claude-sonnet-4-6` | Stable Anthropic generalist alias. |
| `haiku` | `claude-haiku-4-5-20251001` | Stable Anthropic economy alias. |
| `gpt-5.5` | `gpt-5.5` | Alias lookup wins over pinned-ID parsing for this family name. |
| `gemini-pro` | `gemini-pro` | Declared for selector compatibility; provider/model integration is separate follow-up work when Gemini is not present in the active registry. |

Selector syntax:

- `family` parses as an alias selector.
- `family:channel` parses as an alias selector with the channel captured.
- `inherit` parses as an inherit selector.
- A concrete model ID parses as a pinned selector.

## resolveSelector()

`resolveSelector(selector, context?)` in `shared/lib/model-registry.ts` resolves a `ModelSelector` to a concrete pinned model ID and returns a `ResolvedModel` record with structured provenance.

### Function signature

```typescript
export function resolveSelector(
  selector: ModelSelector,
  context?: ResolutionContext,
): ResolvedModel
```

### ResolvedModel shape

```typescript
export interface ResolvedModel {
  requested: ModelSelector;     // the original selector as supplied
  resolved: string;             // the concrete pinned model ID
  source: ResolutionSource;     // how the model was resolved (see below)
  familyChannel?: string;       // present when selector.kind === 'alias' and a channel was specified
  parentContextId?: string;     // present when source === 'inherited' and context.parentContextId was supplied
}

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
```

### Source values emitted by resolveSelector

| source | When emitted | Example |
|--------|-------------|---------|
| `alias` | Selector is `{ kind: 'alias', family }` and the family matches a `FAMILY_ALIASES` entry | `resolveSelector({ kind: 'alias', family: 'sonnet' })` → `{ resolved: 'claude-sonnet-4-6', source: 'alias' }` |
| `pinned` | Selector is `{ kind: 'pinned', modelId }` and the ID passes `validateModelId` | `resolveSelector({ kind: 'pinned', modelId: 'claude-opus-4-7' })` → `{ resolved: 'claude-opus-4-7', source: 'pinned' }` |
| `inherited` | Selector is `{ kind: 'inherit' }` and `context.parent` is supplied | `resolveSelector({ kind: 'inherit' }, { parent: parentResult })` → `{ resolved: parentResult.resolved, source: 'inherited' }` |
| `fallback` | Reserved for the policy layer (not emitted directly by `resolveSelector`) | — |
| `policy` | Reserved for the policy layer (not emitted directly by `resolveSelector`) | — |

### Error cases

- `alias` selector: throws `ModelResolutionError` if `selector.family` is not in `FAMILY_ALIASES`.
- `pinned` selector: throws `ModelResolutionError` (via `validateModelId`) if the model ID is malformed.
- `inherit` selector: throws `ModelResolutionError` if `context?.parent` is absent.
