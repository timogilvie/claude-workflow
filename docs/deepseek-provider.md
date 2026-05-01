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

DeepSeek is default-off for autonomous routing (mill/challenge mode). Manual launches and smoke tests work immediately when `DEEPSEEK_API_KEY` is set. Autonomous routing requires explicit enablement via `deepseek.unattendedEnabled`.

### Enabling unattended routing (mill/challenge)

To allow DeepSeek models in autonomous mill/challenge routing, set `deepseek.unattendedEnabled` in `.wavemill-config.json`:

```json
{
  "deepseek": {
    "unattendedEnabled": true
  },
  "providers": {
    "deepseek": {
      "enabled": true,
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"]
    }
  }
}
```

**Important:** `deepseek.unattendedEnabled` and `providers.deepseek.enabled` serve different purposes:

- `providers.deepseek.enabled`: Controls whether DeepSeek provider path is available (endpoint, models, stages, launcher config)
- `deepseek.unattendedEnabled`: Additional gate for autonomous mill/challenge routing

Both must be true for DeepSeek to participate in autonomous routing. Manual launches via `claude-deepseek` or explicit stage assignments are unaffected by the unattended gate.

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

DeepSeek’s Anthropic-compatible endpoint does not fully match native Anthropic Claude Code behavior:

- **Model behavior**: DeepSeek models may have different tool-call reliability, reasoning patterns, and output formatting compared to first-party Claude models
- **Feature compatibility**: Not every Claude Code feature is guaranteed to work identically (e.g., image/document content, some server-side tools may be unsupported or ignored)
- **Performance**: Response times and quality may differ from Anthropic’s Claude models for the same task
- **API compatibility**: While the endpoint aims for Anthropic compatibility, edge cases and version mismatches may occur

**Recommendation**: Treat the DeepSeek provider as opt-in and validate your specific workflows with live smoke tests before enabling `deepseek.unattendedEnabled` for autonomous routing. Start with manual launches or limited stages to assess suitability.

## Smoke test

### Dry-run (default)

The default mode shows the command and environment without making a network call:

```bash
npx tsx tools/smoke-deepseek.ts
```

Expected result:

- exit code `0`
- Shows command, working directory, state directory, and environment variable names
- No API key required
- No network calls

### Live smoke test (optional)

To validate the actual DeepSeek integration:

```bash
npx tsx tools/smoke-deepseek.ts --live
```

Without `DEEPSEEK_API_KEY`:

- exit code `0`
- stdout includes `skipping` and `DEEPSEEK_API_KEY`

With a real key:

```bash
DEEPSEEK_API_KEY=$REAL_KEY npx tsx tools/smoke-deepseek.ts --live
```

Expected result:

- exit code `0`
- stdout `OK`
- a workflow transcript is written under the isolated DeepSeek provider home
- no files under the real `~/.claude` are newer than the pre-smoke marker

**Before enabling `deepseek.unattendedEnabled`, run the live smoke test to validate your setup.**

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

To disable DeepSeek support:

### Disable unattended routing only

Set `deepseek.unattendedEnabled` to `false` or remove the `deepseek` section:

```json
{
  "deepseek": {
    "unattendedEnabled": false
  }
}
```

This prevents autonomous mill/challenge selection while keeping manual launches and explicit stage assignments available.

### Disable provider entirely

Set `providers.deepseek.enabled` to `false` or remove the `providers.deepseek` block:

```json
{
  "providers": {
    "deepseek": {
      "enabled": false
    }
  }
}
```

This disables all DeepSeek routing, including manual stage assignments.

### Remove API key

Unset the DeepSeek API key env var if you no longer want local runs to use it:

```bash
unset DEEPSEEK_API_KEY
```

### Remove launcher integration

To remove `claude-deepseek` from the router, remove its `router.agentMap` entries or set `agentCmd` back to `"claude"` or `"codex"`.
