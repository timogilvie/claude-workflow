---
title: DeepSeek Provider
---

Wavemill supports DeepSeek through the Anthropic-compatible DeepSeek endpoint, but unattended use stays gated until you explicitly opt in.

There are two integration paths:

1. Model-triggered DeepSeek routing through the normal `claude` agent. This requires `providers.deepseek.enabled: true`.
2. The first-class `claude-deepseek` launcher, which always injects DeepSeek credentials and isolated Claude Code state. This does not require `providers.deepseek.enabled: true`.

## Required setup

Set a key in your shell, or point config at a different env var:

```bash
export DEEPSEEK_API_KEY=...
```

Minimal provider config:

```json
{
  "providers": {
    "deepseek": {
      "enabled": true,
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
      "stages": ["coder"],
      "effortLevel": "medium",
      "launcher": {
        "model": "deepseek-v4-flash",
        "subagentModel": "deepseek-v4-flash",
        "secretSource": "DEEPSEEK_API_KEY"
      }
    }
  }
}
```

Primary model IDs:

- `deepseek-v4-pro`
- `deepseek-v4-flash`

Compatibility aliases still accepted by Wavemill:

- `deepseek-chat`
- `deepseek-reasoner`

API key lookup for `claude-deepseek` uses this precedence:

1. `providers.deepseek.launcher.secretSource`
2. `providers.deepseek.apiKeyEnv`
3. `DEEPSEEK_API_KEY`

## State isolation

`claude-deepseek` isolates Claude Code state under:

```text
.wavemill/deepseek-state/<session>-<issue>/
  home/
  xdg/config/
  xdg/data/
  claude-config/
```

The launcher also writes `/tmp/wavemill-<session>-<issue>.deepseek-state` containing only the resolved state path.

This path must not point at the real `~/.claude`. The launcher rejects unsafe `stateDir` overrides.

## Smoke validation

Dry-run is the default and does not require a real key:

```bash
npx tsx tools/smoke-deepseek.ts
```

JSON output:

```bash
npx tsx tools/smoke-deepseek.ts --json
```

Optional live smoke:

```bash
npx tsx tools/smoke-deepseek.ts --live --timeout 30s
```

Behavior:

- Dry-run exits `0` without a real key.
- Dry-run validates env injection, DeepSeek model selection, endpoint resolution, `WAVEMILL_AGENT_KIND=claude-deepseek`, and isolated state paths.
- Dry-run does not make a network call and does not validate model/tool-call quality.
- Live smoke is optional.
- If the configured key env var is missing, `--live` skips cleanly with exit `0`.
- When a key is present, live smoke reuses launcher env construction, runs a tiny Claude prompt, checks for an isolated transcript, and verifies the real `~/.claude` was not mutated.

## Unattended and Challenge Mode

DeepSeek is default-off for unattended challenge selection even if the provider is enabled.

To allow challenge mode to select DeepSeek, you must opt in explicitly:

```json
{
  "challenge": {
    "allowDeepseek": true
  }
}
```

Recommended sequence:

1. Configure `DEEPSEEK_API_KEY` and DeepSeek provider settings.
2. Run the dry-run smoke command.
3. Run the optional live smoke command.
4. Only after that, set `challenge.allowDeepseek: true`.

Provider enablement and challenge enablement are separate:

- `providers.deepseek.enabled` controls whether normal routed stages may use DeepSeek models.
- `challenge.allowDeepseek` controls whether unattended challenge mode may include DeepSeek candidates.

## Limitations

DeepSeek’s Anthropic-compatible endpoint is not a guarantee of full Claude Code parity.

- Model behavior and tool-call reliability may differ from first-party Claude.
- Not every Claude Code feature is guaranteed to work against the DeepSeek-compatible endpoint.
- DeepSeek-documented compatibility gaps around image/document content and some server-side tools should be treated as limitations, not promises of support.

Validate the exact workflow you care about before broad rollout.

## Rollback

To roll back unattended or routed DeepSeek usage:

1. Set `challenge.allowDeepseek` to `false` or remove it.
2. Remove DeepSeek entries from `challenge.models`, `router.models`, or `router.agentMap` if you no longer want them eligible.
3. Set `providers.deepseek.enabled` to `false` or remove the `providers.deepseek` block.
4. Unset `DEEPSEEK_API_KEY` or remove the configured `apiKeyEnv`/`secretSource`.
5. Delete `.wavemill/deepseek-state/` if you want to discard isolated local state.
