---
title: Adding Models
---

Wavemill model support is deliberately global. Consumer repositories cannot add,
hide, remap, or certify models through `.wavemill-config.json` or local overlay
files. When adding a new model, update the Wavemill global catalog and effective
model projection so every repository sees the same model universe.

## Checklist

1. Add the model and metadata to the global registry/projection in Wavemill.
2. Publish or update the global v2 certification catalog entry before exposing
   native launch eligibility.
3. Add pricing to the canonical Wavemill defaults when cost accounting needs it.
4. Add or update launcher/provider code when the model requires a new runtime
   integration. Keep credentials as environment variables.
5. Update DSPy routing metadata and active selector artifacts when they carry
   explicit model candidates.
6. Update tests that assert exact global model lists, ladders, or launchability.
7. Run focused config, registry, router, certification, and provider-launch tests.

For frontier models, use `class: "frontier"` in the registry and include the model in the planning, coding, and review ladders. Prefer putting same-vendor successors next to the previous model so quota fallback can substitute within the same class cleanly.

## Registry Metadata

Every canonical entry in `DEFAULT_MODEL_REGISTRY` must include:

- `contextWindowTokens`
- `toolSupport` as one of `none`, `basic`, or `full`
- `multimodal` with `text` and `image`, plus optional `audio` and `video`
- `latencyTier` as one of `fast`, `standard`, or `slow`
- `reasoningTier` as one of `basic`, `standard`, or `advanced`
- `costPerMillionInputTokensUsd` and `costPerMillionOutputTokensUsd`

Repository-local `modelRegistry.models.<id>` overrides are no longer accepted.
Canonical global registry entries must provide the complete metadata above.

## Retiring a model

Retire a model that can no longer launch (absent from the OpenRouter catalog,
no tool support, etc.) without deleting its registry entry, so historical eval
records and cost attribution still resolve via `getModel()` /
`resolveModelRegistryKey()`.

1. In `shared/lib/model-registry.ts`, set `supportedModel.lifecycle: 'blocked'`
   on the entry and add a dated `limitations` note. `explainModelSupportExclusion`
   returns `'blocked-lifecycle'` for blocked entries, excluding them from every
   effective stage pool.
2. Correct any capability field that was untruthful (e.g. set `toolSupport: 'none'`
   when the provider advertises no tool support).
3. In `shared/fixtures/model_30_launch_priority_models.v1.json`, set the same
   alias to `"status": "deprecated"` so `sync-openrouter-catalog` reports it as
   `deprecated` instead of `not_found_in_openrouter` drift, and
   `normalizeModels()` drops it from the advertised OpenRouter model list.
4. Run `npx tsx tools/audit-openrouter-aliases.ts --offline` to confirm the
   retired alias is flagged but not selectable (exit 0).

## Family Aliases


Family aliases are stable developer-facing names that parse into `ModelSelector` values in `shared/lib/model-registry.ts`. `parseModelSelector` only validates selector syntax and shape; it does not resolve aliases against the active registry.

| Family | Stable model ID | Notes |
| --- | --- | --- |
| `opus` | `claude-opus-4-8` | Stable Anthropic frontier alias. |
| `sonnet` | `claude-sonnet-5` | Stable Anthropic generalist alias. |
| `haiku` | `claude-haiku-4-5-20251001` | Stable Anthropic economy alias. |
| `gpt-5.5` | `gpt-5.5` | Alias lookup wins over pinned-ID parsing for this family name. |
| `gemini-pro` | `gemini-pro` | Declared for selector compatibility; provider/model integration is separate follow-up work when Gemini is not present in the active registry. |

Selector syntax:

- `family` parses as an alias selector and defaults to `channel: "stable"`.
- `family:channel` parses as an alias selector with a validated channel.
- `family-channel` also parses as an alias selector with a validated channel.
- `inherit` parses as an inherit selector.
- A concrete model ID parses as a pinned selector.

## Stability Channels

Family aliases can expose up to three stability channels:

- `stable`: the default production-ready pin. Bare aliases like `opus` resolve as `{ family: "opus", channel: "stable" }`.
- `preview`: an early-adopter opt-in for newer candidates that may change before promotion.
- `experimental`: the bleeding-edge opt-in for work that may break or disappear without deprecation.

Channel promotion is manual. Additions and promotions should update the pinned model ID in `shared/lib/model-registry.ts` after whatever evaluation or operational review you require. Do not build automated channel promotion or eval-driven channel selection into the alias resolver.

To add a channel pin for a family alias, extend the alias entry's `channels` map:

```typescript
opus: Object.freeze({
  channels: Object.freeze({
    stable: 'claude-opus-4-8',
    preview: 'claude-opus-4-8-preview',
  }),
  description: 'Stable Anthropic frontier alias for the Opus family.',
}),
```

If a selector requests a known channel that has no registered pin for that family, `resolveSelector()` throws `ModelResolutionError` with code `channel_unpinned`.

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
  familyChannel?: Channel;      // present when selector.kind === 'alias'; defaults to "stable"
  parentContextId?: string;     // present when source === 'inherited' and context.parentContextId was supplied
  fallbackReason?: FallbackReason; // present when the policy layer had to substitute another model
}

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
export type FallbackReason = 'quota-exhausted' | 'disabled-by-policy' | 'unavailable';
```

### Source values emitted by resolveSelector

| source | When emitted | Example |
|--------|-------------|---------|
| `alias` | Selector is `{ kind: 'alias', family, channel }` and the family/channel pair matches a pinned `FAMILY_ALIASES` entry | `resolveSelector({ kind: 'alias', family: 'sonnet', channel: 'stable' })` → `{ resolved: 'claude-sonnet-5', source: 'alias', familyChannel: 'stable' }` |
| `pinned` | Selector is `{ kind: 'pinned', modelId }` and the ID passes `validateModelId` | `resolveSelector({ kind: 'pinned', modelId: 'claude-opus-4-8' })` → `{ resolved: 'claude-opus-4-8', source: 'pinned' }` |
| `inherited` | Selector is `{ kind: 'inherit' }` and `context.parent` is supplied | `resolveSelector({ kind: 'inherit' }, { parent: parentResult })` → `{ resolved: parentResult.resolved, source: 'inherited' }` |
| `fallback` | Reserved for the policy layer (not emitted directly by `resolveSelector`) | — |
| `policy` | Reserved for the policy layer (not emitted directly by `resolveSelector`) | — |

### Error cases

- `alias` selector: throws `ModelResolutionError` if `selector.family` is not in `FAMILY_ALIASES` or if `selector.channel` is known but not pinned for that family.
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
//   resolved: 'claude-sonnet-5',
//   source: 'fallback',
//   fallbackReason: 'quota-exhausted',
// }
```
