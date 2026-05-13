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

## Registry Metadata

Every canonical entry in `DEFAULT_MODEL_REGISTRY` must include:

- `contextWindowTokens`
- `toolSupport` as one of `none`, `basic`, or `full`
- `multimodal` with `text` and `image`, plus optional `audio` and `video`
- `latencyTier` as one of `fast`, `standard`, or `slow`
- `reasoningTier` as one of `basic`, `standard`, or `advanced`
- `costPerMillionInputTokensUsd` and `costPerMillionOutputTokensUsd`

Workspace `modelRegistry.models.<id>` overrides may provide any subset of those fields. Canonical registry entries must provide all of them.

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
  fallbackReason?: FallbackReason; // present when the policy layer had to substitute another model
}

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
export type FallbackReason = 'quota-exhausted' | 'disabled-by-policy' | 'unavailable';
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

## resolveSelectorWithPolicy()

`resolveSelectorWithPolicy(selector, context, options)` in `shared/lib/model-resolution-policy.ts` composes selector resolution with quota and routing policy checks. `resolveSelector()` remains unchanged; this wrapper is the policy-aware entry point when callers need explicit downgrade metadata.

### Function signature

```typescript
export function resolveSelectorWithPolicy(
  selector: ModelSelector,
  context: ResolutionContext | undefined,
  options: ResolveSelectorWithPolicyOptions,
): ResolvedModel
```

### Behavior

- Calls `resolveSelector()` first and preserves the original `requested` selector, `familyChannel`, and `parentContextId`.
- Returns the baseline result unchanged when the resolved model is still viable under policy.
- Returns `source: 'fallback'` with `fallbackReason: 'quota-exhausted'` when quota blocks the requested model.
- Returns `source: 'policy'` with `fallbackReason: 'disabled-by-policy'` when non-quota policy rules block the requested model.
- Returns `source: 'fallback'` with `fallbackReason: 'unavailable'` when the requested pinned target is absent from the active registry or filtered out as unavailable.
- Throws a typed `ModelPolicyResolutionError` when no viable substitute exists.

### Canonical example

```typescript
resolveSelectorWithPolicy(
  { kind: 'alias', family: 'opus' },
  undefined,
  {
    taskType: 'review',
    difficulty: 'moderate',
    quotaState: exhaustedOpusSnapshot,
    registryOverride: DEFAULT_MODEL_REGISTRY,
  },
);
// =>
// {
//   requested: { kind: 'alias', family: 'opus' },
//   resolved: 'claude-sonnet-4-6',
//   source: 'fallback',
//   fallbackReason: 'quota-exhausted',
// }
```

## Capability-Aware Routing

Capability-aware routing is an opt-in feature that filters model candidates based on task-specific requirements for context window, tool support, multimodal capabilities, and latency.

### Configuration

Enable in `.wavemill-config.json`:

```json
{
  "router": {
    "capabilityAwareRouting": true
  }
}
```

**Default**: `false` (disabled). When disabled, routing ignores capability constraints.

### How It Works

When enabled, the router applies capability constraints during Layer 3 (policy/availability) filtering:

1. **Layer 1**: Explicit pinned model IDs bypass capability filtering entirely
2. **Layer 2**: Family/role resolution remains unchanged
3. **Layer 3**: Capability filtering applies alongside quota, difficulty, cost tier, and stage allowlists

### Constraint Types

- `minContextWindow` — Excludes models with `contextWindowTokens` below the requirement
- `requiresTools` — Excludes models with `toolSupport: 'none'` (only when `true`)
- `requiresMultimodal` — Excludes models without `multimodal.image` support (only when `true`)
- `maxLatencyTier` — Excludes models exceeding the latency budget (`fast < standard < slow`)

### Fallback Behavior

If all candidates are rejected by capability constraints, the router falls back to the original unfiltered candidate list and emits fallback diagnostics. This prevents capability filtering from blocking workflows when constraints are impossible to satisfy.

### Automatic Constraint Derivation

The workflow router automatically derives conservative per-role constraints:

- **Planner**: Context window from depth/task size
- **Coder**: `requiresTools: true` + context window from depth
- **Reviewer**: `requiresMultimodal: true` for UI tasks + context window

Constraints can also be provided explicitly via `RouteWorkflowOptions.capabilityConstraints`.
