# Resource Registry

Wavemill now persists runtime assets in:

- `.wavemill/registry/resources.jsonl`
- `.wavemill/manifests/<sessionId>.json`

The registry stores immutable resource versions for `prompt`, `optimizer-artifact`, `tool`, `memory`, `agent-config`, and `environment`.

The manifest stores the exact `id` and `version` pairs used by a workflow run, grouped by phase.

## Runtime Selection

Wavemill can now resolve governed runtime resources for the `router`, `planner`, and `reviewer` surfaces through `shared/lib/resource-selection.ts`.

- Baseline remains the default when runtime selection is disabled.
- Repo-level opt-in lives under `resources.runtimeSelection`.
- Each surface can request `baseline`, `optimized`, or `canary`.
- `fallbackToBaseline` controls whether missing or disallowed candidates automatically revert to the prior stable baseline.
- Canary selection is deterministic per session id, so retries do not bounce between variants.

Selected prompt and router resources are still registered in `.wavemill/registry/resources.jsonl`, and the manifest records the exact resource refs used by the run.

## CLI

```bash
npx tsx tools/registry.ts list
npx tsx tools/registry.ts show <resource-id>
npx tsx tools/registry.ts manifest <session-id>
npx tsx tools/registry.ts diff <session-a> <session-b>
```

## Config

```json
{
  "registry": {
    "enabled": true,
    "dir": ".wavemill/registry"
  },
  "resources": {
    "runtimeSelection": {
      "enabled": true,
      "defaultVariant": "baseline",
      "fallbackToBaseline": true,
      "canaryRate": 0.1,
      "surfaces": {
        "planner": {
          "enabled": true,
          "variant": "optimized"
        },
        "reviewer": {
          "enabled": true,
          "variant": "baseline"
        }
      }
    }
  }
}
```

When `enabled` is `false`, write paths become no-ops.
