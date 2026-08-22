# Resource Registry

Wavemill now persists runtime assets in:

- `.wavemill/registry/resources.jsonl`
- `.wavemill/manifests/<sessionId>.json`

The registry stores immutable resource versions for `prompt`, `optimizer-artifact`, `tool`, `memory`, `agent-config`, and `environment`.

The manifest stores the exact `id` and `version` pairs used by a workflow run, grouped by phase.

## Harness ID

Every manifest now carries `harnessId`: a stable SHA-256 hash over the sorted unique behavior-relevant resource tuples used by the run. The tuple is `id@version`; modern registry refs already embed the version in `id`, and legacy refs are normalized defensively.

`environment:` and `tool:` refs are excluded. They currently represent local Node/Codex/Claude CLI/runtime version snapshots, and including them would fragment results on environment churn rather than harness behavior. `runtime:` refs are included because provider/model state is part of the evaluated harness.

New eval records, route artifacts, and challenge comparisons are additive: legacy records without harness fields still validate. Challenge comparisons store per-side `primaryHarnessId` and `challengerHarnessId` because each arm can run under a different harness.

Backfill is idempotent:

```bash
npx tsx tools/backfill-harness-ids.ts
npx tsx tools/backfill-harness-ids.ts --dry-run
```

Existing manifests can always be backfilled. Eval records are stamped only when they have a `manifestRef.sessionId` that maps to a manifest. Challenge records are stamped only when their PR URL maps exactly and uniquely to an eval record with a `harnessId`. Archived route artifacts are not backfilled because they do not carry a stable session key.

Current limitation: mill-mode scripts still only get a manifest when a session has been opened by existing session/planning-canary paths. `recordUse` is a no-op without an open manifest, so wiring manifest creation into mill launch remains a follow-up.

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
npx tsx tools/registry.ts harness <harness-id-or-session>
npx tsx tools/registry.ts diff <session-or-harness-a> <session-or-harness-b>
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
