# Resource Registry

Wavemill persists runtime assets in:

- `.wavemill/registry/resources.jsonl`
- `.wavemill/manifests/<sessionId>.json`

The registry stores immutable resource versions for `prompt`, `optimizer-artifact`, `tool`, `memory`, `agent-config`, and `environment`.

The manifest stores the exact `id` and `version` pairs used by a workflow run, grouped by phase.

## Typed Resource Retrieval

`shared/lib/resource-retrieval.ts` exposes a typed request/result API layered on top of the file-backed registry. Callers describe capabilities using typed contract fields; the module resolves to the backing file, registers it, and returns content with attribution.

### Contract metadata

Resources registered via the typed API include contract fields in `metadata`:

| Field | Example | Where used |
|-------|---------|------------|
| `stage` | `"planning"` | Prompt resources |
| `role` | `"phase"`, `"reviewer"`, `"judge"` | Prompt resources |
| `operatingMode` | `"constrained"` | Mode-sensitive prompts |
| `persona` | `"general"`, `"security"` | Reviewer prompts |
| `stability` | `"stable"` | All resource classes |
| `tier` | `"hot"`, `"cold"`, `"concept"` | Memory resources |
| `subsystemId` | `"linear-api"` | Cold memory |
| `conceptId` | `"progressive-disclosure"` | Concept memory |
| `policyName` | `"config"` | Policy resources |

### Stability channels

Phase one supports only `"stable"` (the default). Requesting any other channel (`canary`, `experimental`, `optimized`) throws a clear error with a note that HOK-1379 is required. This leaves a clean seam for future variant routing without silently selecting arbitrary files.

### Storage

Phase one preserves file-backed storage. `tools/prompts/` remains the backing directory for all prompt resources; `.wavemill/` remains the backing directory for memory and policy resources. The typed retrieval layer adds registration and attribution on top without changing where files live.

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
  }
}
```

When `enabled` is `false`, write paths become no-ops. Typed retrieval still returns content and a null `resourceRef`.
