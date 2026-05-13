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

Each family alias has a `channels` record mapping stability channels to pinned model IDs. The `stable` channel is the default when no channel is specified.

| Family | Stable | Preview | Experimental | Notes |
| --- | --- | --- | --- | --- |
| `opus` | `claude-opus-4-7` | — | — | Stable Anthropic frontier alias. |
| `sonnet` | `claude-sonnet-4-6` | — | — | Stable Anthropic generalist alias. |
| `haiku` | `claude-haiku-4-5-20251001` | — | — | Stable Anthropic economy alias. |
| `gpt-5.5` | `gpt-5.5` | — | — | Alias lookup wins over pinned-ID parsing for this family name. |
| `gemini-pro` | `gemini-pro` | — | — | Declared for selector compatibility; provider/model integration is separate follow-up work when Gemini is not present in the active registry. |

Selector syntax:

- `family` parses as an alias selector with implicit `stable` channel (applied at resolution time, not parsing).
- `family:channel` or `family-channel` parses as an alias selector with the channel captured.
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
  channel: Channel;             // the stability channel; 'stable' for pinned/inherited, specified channel for alias
  familyChannel?: string;       // present when selector.kind === 'alias' and a channel was specified
  parentContextId?: string;     // present when source === 'inherited' and context.parentContextId was supplied
  fallbackReason?: FallbackReason; // present when the policy layer had to substitute another model
}

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
export type Channel = 'stable' | 'preview' | 'experimental';
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

## Stability Channels

Family aliases support **stability channels** to allow early adopters to opt into newer models without abandoning the alias UX. Three channels are defined:

| Channel | Purpose | Opt-in |
| --- | --- | --- |
| `stable` | Production-ready models pinned by the team. Recommended default. | Implicit (no suffix required) |
| `preview` | Early-adopter opt-in for newer models. May change version or break in the next milestone. | Use `opus-preview`, `opus:preview`, or `{ family: 'opus', channel: 'preview' }` |
| `experimental` | Bleeding edge, evaluation-stage models. Highest risk; only for power users. | Use `opus-experimental`, `opus:experimental`, or `{ family: 'opus', channel: 'experimental' }` |

### Adding a channel pin

To add a preview or experimental model for a family, extend the family's `channels` record in `FAMILY_ALIASES` (in `shared/lib/model-registry.ts`):

```typescript
opus: Object.freeze({
  channels: Object.freeze({
    stable: 'claude-opus-4-7',
    preview: 'claude-opus-4-8-preview',  // add this line
  }),
  description: 'Stable Anthropic frontier alias for the Opus family.',
}),
```

### Promotion policy (manual)

Channel pins are **promoted manually** — the team decides when a model graduates from preview to stable. Promotion is not automated or eval-driven; it is a deliberate policy decision captured in a PR.

To promote a model:
1. Update `FAMILY_ALIASES[family].channels.stable` to the new model ID.
2. Optionally add a newer preview model.
3. Update the "Stability Channels" table in this document.
4. Create a PR with a clear title like "Promote opus to claude-opus-4-8".

### Parser and resolver behavior

**Parser** (`parseModelSelector`):
- `opus-preview` → `{ kind: 'alias', family: 'opus', channel: 'preview' }` (suffix form)
- `opus:preview` → `{ kind: 'alias', family: 'opus', channel: 'preview' }` (colon form)
- `opus:bogus` → parse error `unknown_channel` (invalid channel in colon form)
- `unicorn-preview` → parse error `unknown_family` (valid channel suffix, but family not recognized)

**Resolver** (`resolveSelector`):
- `{ kind: 'alias', family: 'opus' }` → resolves with default channel `stable`
- `{ kind: 'alias', family: 'opus', channel: 'preview' }` → resolves to the pinned preview model or throws `ModelResolutionError` with code `unpinned_channel` if not pinned
- `{ kind: 'pinned', modelId: 'gpt-5.5' }` → resolves with channel `stable` (pinned IDs are not channel-aware)
- `{ kind: 'inherit' }` → propagates the parent resolution's channel

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
