---
title: Native Read-Only Runtime
---

# Native Read-Only Runtime

Wavemill can opt into the native runtime for read-only phases only:

- task expansion
- planning
- review

Coding is not part of this opt-in. Even when native read-only phases are enabled, coding continues to use the existing non-native path unless the separate patch-coding alpha gate is enabled and certified.

## Required Config

Add a `nativeAgent` block to `.wavemill-config.json`:

```json
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["task-expansion", "planning", "review"],
    "providers": {
      "openai": {
        "apiKeyEnv": "OPENAI_API_KEY",
        "models": ["gpt-4o"]
      }
    }
  }
}
```

Required pieces:

- `nativeAgent.enabled: true`
- `nativeAgent.allowedPhases`: include only the read-only phases you want to enable
- `nativeAgent.providers.<provider>.apiKeyEnv`: environment variable that holds the provider API key
- `nativeAgent.providers.<provider>.models`: one or more certified model IDs for that provider

Optional expansion-only behavior:

```json
{
  "nativeAgent": {
    "expansion": {
      "fallbackOnUnavailable": true
    }
  }
}
```

When `fallbackOnUnavailable` is `true`, task expansion falls back to the legacy path if native prerequisites are unavailable. Planning and review remain explicit opt-in native runs and do not use that fallback.

## Patch-Coding Alpha Gate

Native patch coding stays disabled by default. The config gate is separate from the read-only phase opt-in:

```json
{
  "nativeAgent": {
    "patchCoding": {
      "enabled": true
    }
  }
}
```

This flag is necessary but not sufficient. Wavemill only enables native patch coding when both of these are true:

- `nativeAgent.patchCoding.enabled` is `true`
- `.wavemill/native-agent/patch-coding-certification.json` exists and matches the current smoke-suite revision

The runtime gate is exported from `shared/lib/native-agent/coding-gate.ts` as `isPatchCodingEnabled()` and `evaluatePatchCodingGate()`. That is the handoff seam for the follow-up command/test/git runtime work.

## Supported Providers

The schema currently allows:

- `openai`
- `openrouter`

Provider credentials should stay in environment variables, not in the config file itself.

## Certification Requirement

Native routing is fail-closed. A model must be registered as certified for native read-only use before Wavemill will select it for:

- task expansion
- planning
- review

If a model is configured but not certified, the native eligibility checks reject it instead of silently routing it.

Patch-coding alpha uses its own certification artifact. Run:

```bash
npx tsx tools/certify-patch-coding.ts --provider openai:gpt-4o --provider openrouter:openai/gpt-4o-mini
```

Certification requirements:

- at least two distinct provider/model pairs must pass the coding smoke suite
- the artifact records the exact provider/model pairs that passed
- the artifact records the exact smoke-suite revision
- stale revisions fail closed until recertified

The artifact path is `.wavemill/native-agent/patch-coding-certification.json`. The current coding smoke-suite revision constant lives in `shared/lib/native-agent/smoke.ts` as `PATCH_CODING_SMOKE_SUITE_REVISION`.

## Phase Examples

Enable only native review:

```json
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["review"],
    "providers": {
      "openai": {
        "apiKeyEnv": "OPENAI_API_KEY",
        "models": ["gpt-4o"]
      }
    }
  }
}
```

Enable expansion and planning, but leave review on the legacy path:

```json
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["task-expansion", "planning"],
    "providers": {
      "openrouter": {
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "models": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

## What To Expect

When a native read-only phase runs successfully:

- transcript artifacts are written under `.wavemill/runs/*/native-sessions/`
- provider/model/api metadata is available to downstream session, cost, and eval consumers
- read-only mutation attempts are denied and recorded as denial events
- normal success hook state is preserved for correctly denied mutation attempts

For prompt and runtime wiring details, see [Prompt Locations](./prompt-locations.md).
