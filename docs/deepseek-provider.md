---
title: DeepSeek Provider
---

DeepSeek support in Wavemill is implemented as a Claude-compatible provider path. Wavemill still launches `claude`, but for DeepSeek models it injects Anthropic-compatible env vars and isolates Claude Code state under the worktree so the user’s normal `~/.claude` is not touched.

## Required setup

Set a DeepSeek API key in your shell, or configure a different env var name through `providers.deepseek.apiKeyEnv`:

```bash
export DEEPSEEK_API_KEY=...
```

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

DeepSeek is default-off. Do not enable it for unattended usage until the smoke test below passes.

## Model IDs

Primary current IDs:

- `deepseek-v4-pro`
- `deepseek-v4-flash`

Compatibility aliases kept for existing workflows:

- `deepseek-chat`
- `deepseek-reasoner`

The aliases are retained for compatibility, but DeepSeek currently documents the `deepseek-v4-*` IDs as primary.

## Runtime behavior

- Wavemill sets `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`.
- Wavemill passes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, the Claude default model aliases, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, and `CLAUDE_CONFIG_DIR` only to the child `claude` process.
- Claude state is isolated under `.wavemill/runs/<issue-or-session>/providers/deepseek/`.
- Wavemill writes a non-secret manifest to `.wavemill/runs/<issue-or-session>/providers/deepseek/state.json` so the isolated state location is discoverable outside the launched process.
- If the configured key env var is unset, empty, or whitespace-only, Wavemill aborts before tmux dispatch with a clear DeepSeek launcher error.
- Routing filters DeepSeek models unless the provider is enabled, the configured key env var is present, and the target stage is allowlisted in `providers.deepseek.stages`.
- The literal API key value is never written to the launcher script or the manifest.

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
- `.wavemill/runs/<issue-or-session>/providers/deepseek/state.json` records the isolated state paths
- no files under the real `~/.claude` are newer than the pre-smoke marker

## Manual validation

After a successful smoke run:

1. Route a stage to `deepseek-v4-pro` or `deepseek-v4-flash`.
2. Confirm the eval row records `provider: "deepseek"` and `endpoint: "https://api.deepseek.com/anthropic"`.
3. Confirm transcript discovery, workflow cost, and intervention detection still work for the run.
4. Grep `.wavemill` and `/tmp/wavemill-*` to verify the literal API key was not persisted.

## Rollback

Disable the provider by setting `providers.deepseek.enabled` to `false` or removing the `providers.deepseek` block entirely. Unset the DeepSeek API key env var if you no longer want local runs to use it.
