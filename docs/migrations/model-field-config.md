# Migration Guide: `model` Field for Checked-In Agent and Workflow Configs

This guide covers the new optional `model` selector field added to wavemill configuration schemas. The field enables version-controlled routing defaults for agent phases and planner-generated tasks.

## Overview

Three surfaces now accept an optional `model` field:

1. **`.wavemill-config.json`** — `agents` section with per-phase model selectors
2. **`launch-plan.json`** — `model` on individual task entries
3. **Planner output** — `model` on `PlanIssue` objects

### Valid `model` Values

| Form | Example | Meaning |
|------|---------|---------|
| `"inherit"` | `"inherit"` | Use the parent context or runtime default |
| Family alias | `"opus"`, `"sonnet"`, `"haiku"` | Resolved by the model registry |
| Pinned ID | `"claude-opus-4-7"` | Exact model identifier |

Source of truth for valid aliases: `shared/lib/model-registry.ts`

The field is **optional**. Absence is equivalent to `"inherit"` — the runtime routing pipeline determines the model as before.

## Before / After Examples

### 1. Agent Definition (`.wavemill-config.json`)

**Before** — routing is entirely runtime-determined:

```json
{
  "router": {
    "enabled": true,
    "defaultModel": "claude-sonnet-4-6"
  }
}
```

**After** — checked-in per-phase defaults:

```json
{
  "router": {
    "enabled": true,
    "defaultModel": "claude-sonnet-4-6"
  },
  "agents": {
    "planner": { "model": "opus" },
    "coder": { "model": "inherit" },
    "reviewer": { "model": "claude-sonnet-4-6" }
  }
}
```

The `agents` section feeds the layered model-resolution pipeline (`shared/lib/model-resolution-policy.ts`). Phases without an entry fall back to runtime routing.

### 2. Workflow Descriptor (Launch Plan Task Entry)

**Before** — no model selector on tasks:

```json
{
  "session": "wave-42",
  "repoDir": "/home/user/repo",
  "baseBranch": "main",
  "worktreeRoot": "../worktrees",
  "agentCmd": "claude",
  "tasks": [
    {
      "issue": "HOK-1500",
      "slug": "add-auth",
      "branch": "task/add-auth"
    }
  ]
}
```

**After** — per-task model selector:

```json
{
  "session": "wave-42",
  "repoDir": "/home/user/repo",
  "baseBranch": "main",
  "worktreeRoot": "../worktrees",
  "agentCmd": "claude",
  "tasks": [
    {
      "issue": "HOK-1500",
      "slug": "add-auth",
      "branch": "task/add-auth",
      "model": "opus"
    }
  ]
}
```

### 3. Planner Output (`PlanIssue`)

**Before** — plan decomposition issues have no model hint:

```json
{
  "epic_summary": "Authentication overhaul",
  "milestones": [{
    "name": "Foundation",
    "issues": [{
      "title": "Setup auth database",
      "user_story": "As a user...",
      "description": "Create users table...",
      "dependencies": [],
      "priority": "P0"
    }]
  }]
}
```

**After** — issues can carry a model selector:

```json
{
  "epic_summary": "Authentication overhaul",
  "milestones": [{
    "name": "Foundation",
    "issues": [{
      "title": "Setup auth database",
      "user_story": "As a user...",
      "description": "Create users table...",
      "dependencies": [],
      "priority": "P0",
      "model": "sonnet"
    }]
  }]
}
```

## TypeScript API

```typescript
import { getAgentsConfig } from './shared/lib/config.ts';

const agents = getAgentsConfig('/path/to/repo');
console.log(agents.planner?.model); // "opus" | "inherit" | "claude-opus-4-7" | undefined
console.log(agents.coder?.model);
console.log(agents.reviewer?.model);
```

## Out of Scope

- **Writing new defaults into existing workspaces**: No existing `.wavemill-config.json` files are modified.
- **Changing runtime routing behavior**: The startup runner (`wavemill-startup-runner.sh`) and mill orchestrator are not modified. The `model` field is declarative only — future tooling will resolve and inject values into the `route` object.
- **Semantic validation of aliases/IDs**: The schema validates the field is a non-empty string. Whether the alias or ID is known is the responsibility of the resolution pipeline at runtime.

## Related Documentation

- `shared/lib/model-registry.ts` — Canonical model alias and capability registry
- `shared/lib/model-resolution-policy.ts` — Layered resolution pipeline
- `wavemill-config.schema.json` — Full config schema (see `definitions.modelSelector` and `properties.agents`)
- `shared/schemas/launch-plan.schema.json` — Launch plan schema (see `$defs.modelSelector`)
