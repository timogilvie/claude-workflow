# Resource Registry

Wavemill now persists runtime assets in:

- `.wavemill/registry/resources.jsonl`
- `.wavemill/manifests/<sessionId>.json`

The registry stores immutable resource versions for `prompt`, `optimizer-artifact`, `tool`, `memory`, `agent-config`, and `environment`.

The manifest stores the exact `id` and `version` pairs used by a workflow run, grouped by phase.

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

When `enabled` is `false`, write paths become no-ops.
