# Model Field Configuration

The checked-in `model` field lets a workspace declare version-controlled routing intent for agent phases and planner-generated task entries.

Accepted values:
- `"inherit"` defers to the next broader layer.
- Family aliases such as `"opus"`, `"sonnet"`, `"haiku"`, `"gpt-5.5"`, and `"gemini-pro"` resolve to the current stable pin for that family.
- Pinned model IDs such as `"claude-opus-4-7"`, `"claude-sonnet-4-6"`, and `"claude-haiku-4-5-20251001"` resolve exactly as written.

## Agent Definitions

Before:

```json
{
  "router": {
    "availableModels": {
      "planner": ["claude-opus-4-7"],
      "coder": ["gpt-5.5", "claude-sonnet-4-6"],
      "reviewer": ["claude-sonnet-4-6"]
    }
  }
}
```

After:

```json
{
  "router": {
    "availableModels": {
      "planner": ["claude-opus-4-7"],
      "coder": ["gpt-5.5", "claude-sonnet-4-6"],
      "reviewer": ["claude-sonnet-4-6"]
    }
  },
  "agents": {
    "planner": { "model": "opus" },
    "coder": { "model": "gpt-5.5" },
    "reviewer": { "model": "inherit" }
  }
}
```

## Workflow Descriptors

Before:

```json
{
  "mill": {
    "agentCmd": "codex"
  }
}
```

After:

```json
{
  "mill": {
    "agentCmd": "codex"
  },
  "agents": {
    "planner": { "model": "claude-opus-4-7" },
    "coder": { "model": "sonnet" },
    "reviewer": { "model": "haiku" }
  }
}
```

## Planner Output

Before:

```json
{
  "tasks": [
    {
      "issue": "HOK-1635",
      "slug": "document-model-field",
      "branch": "task/document-model-field",
      "taskPacketFile": "features/document-model-field/task-packet.md"
    }
  ]
}
```

After:

```json
{
  "tasks": [
    {
      "issue": "HOK-1635",
      "slug": "document-model-field",
      "branch": "task/document-model-field",
      "taskPacketFile": "features/document-model-field/task-packet.md",
      "model": "sonnet"
    }
  ]
}
```

`model` declarations are never backfilled into existing workspaces automatically. Add them explicitly where you want checked-in routing intent.

Precedence:
- Explicit user CLI selectors still override checked-in selectors.
- `"inherit"` falls through to the next layer, including parent context when present.

Invalid values fail loudly during config or plan validation with an error that names the failing path and explains the accepted forms.

## Cross-Process Inheritance

`"inherit"` is resolved in one place: [`shared/lib/model-resolution.ts`](/Users/timothyogilvie/Dropbox/wavemill/worktrees/preserve-per-subagent-model-declarations-across-parallel-and-nested-execution/shared/lib/model-resolution.ts). Shell launchers only forward context; they do not implement selector logic themselves.

`WAVEMILL_RESOLVED_MODEL` carries the parent agent's concrete resolved model ID across process and worktree boundaries. The launchers set and re-export it before spawning child agents so nested `inherit` selectors stay tied to the parent chain even during parallel execution.

Resolution order for `"inherit"`:
- Use the in-memory parent context when the caller already has one.
- Otherwise use an explicit `parentResolvedModel` value when the batch or launch plan provides one.
- Otherwise use `WAVEMILL_RESOLVED_MODEL` from the environment.
- Otherwise fall back to the normal configured default model for that repo.
