# Resource Registry

Wavemill now persists runtime assets in:

- `.wavemill/registry/resources.jsonl`
- `.wavemill/manifests/<sessionId>.json`

The registry stores immutable resource versions for `prompt`, `optimizer-artifact`, `tool`, `memory`, `agent-config`, `environment`, and `runtime`.

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
npx tsx tools/registry.ts diff <session|harness> <session|harness>
npx tsx tools/registry.ts harness <harness-id-prefix>
```

The `diff` subcommand accepts either a manifest session id or a full/short
harness id (`^[0-9a-f]{8,64}$`). If you pass a harness id, the comparison
uses only the manifest's "participating" resource refs — environment refs are
excluded — because that is what the harness id covers. To see environment
differences, compare by session id instead.

Backfill existing data with:

```bash
npx tsx tools/backfill-harness-ids.ts [--dry-run]
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

## Harness IDs

Every manifest now carries a `harnessId`: a deterministic SHA-256 over the
sorted, de-duplicated `id@version` tuple of every **participating** resource
in `manifest.resources`. Participation is defined by
`HARNESS_EXCLUDED_RESOURCE_TYPES` in `shared/lib/resource-manifest.ts`;
today only `environment:*` refs are excluded, so the harness id captures
the exact prompt, tool, runtime, agent-config, and optimizer-artifact
versions in use.

A harness id is recomputed on every manifest write (`openManifest`,
`recordUse`, `closeManifest`), and it is stamped additively on eval records,
route decision artifacts, and challenge records at write time. Because it is
capturing the participating tuple (including `agent-config:` and `runtime:`
refs, which embed the routed model), two sessions with identical prompts but
different routed models will produce different harness IDs. This matches the
"hash the whole tuple" intent; narrowing the exclusion list is a follow-on
regression-analysis concern.

Conversely, adding, removing, or changing an `environment:*` ref does **not**
affect the harness id, so CLI version metadata churn (node/platform/config
hashes) is not treated as a harness version change.

### Backfill semantics

- Manifests: legacy manifests are rewritten to add `harnessId`; the original
  `digest` is preserved.
- Eval records: joined to a manifest by `sessionId`,
  `manifestRef.sessionId`, or `metadata.sessionId`; otherwise left unset.
- Challenge records: per-arm eval records are resolved by
  `challengePairId` + PR URL; consensus `harnessId` is only set when both
  arms report the same value.
- Route decision artifacts: left untouched because archived route JSONs carry
  no session id or manifest reference.

`harnessId` is absent rather than `null`: unset means "unmapped".

When `enabled` is `false`, write paths become no-ops.
