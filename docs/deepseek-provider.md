---
title: DeepSeek Provider
---

Wavemill supports DeepSeek via two distinct paths:

1. **Model-triggered path** (`agent: "claude"`): existing behavior — route a DeepSeek model through the `claude` agent for a specific stage. Requires `providers.deepseek.enabled = true`.
2. **First-class launcher** (`agent: "claude-deepseek"`): new — a dedicated agent kind that always uses DeepSeek credentials and isolated state, regardless of model selection. Does not require `providers.deepseek.enabled`.

Both paths run the `claude` binary with Anthropic-compatible env vars and keep Claude Code state away from the user’s normal `~/.claude`.

## Required setup

Set a DeepSeek API key in your shell:

```bash
export DEEPSEEK_API_KEY=...
```

### Model-triggered path (existing)

Enable the provider explicitly in `.wavemill-config.json`:

```json
{
  "providers": {
    "deepseek": {
      "enabled": true,
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
      "stages": ["coder"],
      "effortLevel": "medium"
    }
  }
}
```

### First-class `claude-deepseek` launcher (new)

Set `agentCmd: "claude-deepseek"` in your wavemill plan or pass `--agent claude-deepseek`:

```json
{
  "providers": {
    "deepseek": {
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "launcher": {
        "model": "deepseek-v4-flash",
        "subagentModel": "deepseek-v4-flash",
        "stateDir": ".wavemill/deepseek-state/my-session"
      }
    }
  }
}
```

All `launcher` fields are optional. Defaults:

| Field | Default |
|-------|---------|
| `model` | `deepseek-v4-flash` |
| `subagentModel` | same as `model` |
| `stateDir` | `.wavemill/deepseek-state/<session>-<issue>` |

To route DeepSeek models to the `claude-deepseek` launcher via the router, add an `agentMap` entry:

```json
{
  "router": {
    "agentMap": {
      "deepseek-v4-pro": "claude-deepseek",
      "deepseek-v4-flash": "claude-deepseek"
    }
  }
}
```

DeepSeek is default-off. Do not enable it for unattended usage until the smoke test below passes.

## Model IDs

Primary current IDs:

- `deepseek-v4-pro`
- `deepseek-v4-flash`

Compatibility aliases kept for existing workflows:

- `deepseek-chat`
- `deepseek-reasoner`

The aliases are retained for compatibility, but DeepSeek currently documents the `deepseek-v4-*` IDs as primary.

## Env var precedence

The following env vars are injected into the `claude` child process for both paths:

| Variable | Source |
|----------|--------|
| `ANTHROPIC_BASE_URL` | `providers.deepseek.baseUrl` or `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | resolved API key (never written to disk) |
| `ANTHROPIC_API_KEY` | same as `ANTHROPIC_AUTH_TOKEN` |
| `ANTHROPIC_MODEL` | configured model |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | same as `ANTHROPIC_MODEL` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | same as `ANTHROPIC_MODEL` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | same as `ANTHROPIC_MODEL` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `launcher.subagentModel` or model |
| `CLAUDE_CODE_EFFORT_LEVEL` | `providers.deepseek.effortLevel` |
| `CLAUDE_CONFIG_DIR` | `<stateDir>/claude-config` (new) |
| `HOME` | `<stateDir>/home` |
| `XDG_CONFIG_HOME` | `<stateDir>/xdg/config` |
| `XDG_DATA_HOME` | `<stateDir>/xdg/data` |
| `WAVEMILL_AGENT_KIND` | `claude-deepseek` (new) |
| `WAVEMILL_DEEPSEEK_STATE_DIR` | resolved state dir path (new) |

API key resolution precedence for `claude-deepseek`:

1. `providers.deepseek.launcher.secretSource` (if set)
2. `providers.deepseek.apiKeyEnv` (if set)
3. `DEEPSEEK_API_KEY`

## State isolation

**`claude-deepseek` launcher** isolates state under:

```
.wavemill/deepseek-state/<session>-<issue>/
  home/              # HOME override (no ~/.claude writes)
  xdg/config/        # XDG_CONFIG_HOME
  xdg/data/          # XDG_DATA_HOME
  claude-config/     # CLAUDE_CONFIG_DIR
```

A state discovery file is written to `/tmp/wavemill-<session>-<issue>.deepseek-state` pointing at the state directory. The file contains only the path — never the API key.

**Model-triggered path** isolates under `.wavemill/runs/<issue>/providers/deepseek/`.

## Missing API key behavior

If the API key is not set, `claude-deepseek` fails **before** touching the tmux pane with a clear error:

```
Error: DEEPSEEK_API_KEY is not set. Set it before launching a claude-deepseek agent.
```

Exit code `2` from `tools/launch-claude-deepseek.ts`.

## Runtime behavior

- Wavemill sets `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`.
- Routing filters DeepSeek models unless the provider is enabled (model-triggered path), the configured key env var is present, and the target stage is allowlisted in `providers.deepseek.stages`.
- `claude-deepseek` does not require `providers.deepseek.enabled`. It requires only `DEEPSEEK_API_KEY` (or configured `apiKeyEnv`/`secretSource`).
- Existing `claude` and `codex` launch paths are unaffected. The `claude-deepseek` case is additive.

## Eval and session compatibility

`claude-deepseek` reuses `ClaudeSessionAdapter` for transcript discovery and cost tracking. Intervention detection treats it as Claude-like (session redirects are detected). Eval records store `agentType: "claude-deepseek"`.

## Limitations

DeepSeek’s Anthropic-compatible endpoint does not fully match native Anthropic Claude Code behavior. DeepSeek currently documents limitations around image/document content and some server-side tools being unsupported or ignored. Treat the provider path as opt-in and validate the exact workflow you need before enabling it broadly.

## Smoke test

Without a key:

```bash
unset DEEPSEEK_API_KEY
npx tsx tools/smoke-deepseek.ts
```

Expected result:

- exit code `2`
- stdout `DEEPSEEK_API_KEY not set; skipping smoke test`

With a real key:

```bash
DEEPSEEK_API_KEY=$REAL_KEY npx tsx tools/smoke-deepseek.ts
```

Expected result:

- exit code `0`
- stdout `OK`
- a workflow transcript is written under the isolated DeepSeek provider home
- no files under the real `~/.claude` are newer than the pre-smoke marker

Testing the `claude-deepseek` launcher directly:

```bash
# Should exit 2 with no key
npx tsx tools/launch-claude-deepseek.ts --session test --issue HOK-000

# Should print env block
DEEPSEEK_API_KEY=$REAL_KEY npx tsx tools/launch-claude-deepseek.ts --session test --issue HOK-000
```

## Manual validation

After a successful smoke run:

1. Route a stage to `deepseek-v4-pro` or `deepseek-v4-flash`.
2. Confirm the eval row records `provider: "deepseek"` and `endpoint: "https://api.deepseek.com/anthropic"`.
3. Confirm transcript discovery, workflow cost, and intervention detection still work for the run.
4. Grep `.wavemill` and `/tmp/wavemill-*` to verify the literal API key was not persisted.
5. For `claude-deepseek`: confirm `WAVEMILL_DEEPSEEK_STATE_DIR` is set in the pane and points at the isolated dir.

## Rollback

Disable the provider by setting `providers.deepseek.enabled` to `false` or removing the `providers.deepseek` block entirely. Unset the DeepSeek API key env var if you no longer want local runs to use it.

To remove `claude-deepseek` from the router, remove its `router.agentMap` entries or set `agentCmd` back to `"claude"` or `"codex"`.
