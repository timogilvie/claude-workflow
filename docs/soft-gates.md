# Soft Gates — Artifact Inconsistency Observer

**Observability-only. These gates never block workflow behavior.**

Soft gates detect inconsistencies between normalized task artifacts
(`task-contract.json`, `feature-state.json`, `trace.jsonl`) and existing
controller truth. They emit structured warnings to `.wavemill/logs/soft-gates.jsonl`
and print grep-friendly lines to stdout.

No phase transition, merge, cleanup, or eval behavior will fail solely because a
soft gate fires. The purpose is to build a reliable feedback signal before any
gate graduates to a narrow hard gate.

---

## Gate IDs and Logic

| Gate ID | Severity | What it detects |
|---------|----------|-----------------|
| `contract_source_hash_mismatch` | warn | `task-contract.json` records a SHA-256 for a source file (task-packet.md, plan.md) that no longer matches the file on disk |
| `completion_without_evidence` | warn | `.coding-complete` marker exists but `feature-state.json` has no passing evidence beyond legacy markers |
| `trace_linkage_missing` | info | `trace.jsonl` or `.trace-context.json` establishes a `traceId` but route/stage artifacts do not carry that same ID |
| `outcome_divergence` | warn | `feature-state.json` phase or status disagrees with `workflow-state.json` for the same task |
| `eval_export_inconsistency` | warn | An eval record has `trainingEligible=true` but `featureOutcomeDiagnostics` is absent/invalid, has `missingFields`, or `eligibilityErrors` include a feature-outcome error code |
| `route_contract_mismatch` | warn | A route artifact (`inputHash` / `packet_hash`) was computed from a task packet not projected by the active `task-contract.json` |
| `ready_inconsistency` | warn | `.ready-result.json` verdict is `pass` but `feature-state.json` `outcome.readyPassed` disagrees or has no passing `ready_check` evidence entry |
| `fallback_verification_mismatch` | warn | `trace.jsonl` has `fallback_used` events but `feature-state.json` shows no compensating safeguards (no blockers, no fail evidence, no review pass) |

### Detection implementation

Four gates reuse detection logic from `artifact-diagnostics.ts` (HOK-2260) and
map its finding codes onto stable public gate IDs:

| Soft-gate ID | Source finding code |
|---|---|
| `contract_source_hash_mismatch` | `contract_hash_drift` |
| `completion_without_evidence` | `coding_complete_without_evidence` |
| `trace_linkage_missing` | `trace_id_missing` |
| `outcome_divergence` | `feature_outcome_state_mismatch` |

The remaining four gates (`eval_export_inconsistency`, `route_contract_mismatch`,
`ready_inconsistency`, `fallback_verification_mismatch`) are implemented directly
in `shared/lib/soft-gates.ts`.

---

## JSONL Log Schema

Warnings are appended to `.wavemill/logs/soft-gates.jsonl` (one JSON object per
line, gitignored at project level).

```jsonc
{
  "timestamp": "2026-06-19T12:00:00.000Z",  // ISO 8601
  "issueId": "HOK-1234",                    // Linear issue ID, or null
  "slug": "my-feature",                     // feature slug, or null
  "gate": "completion_without_evidence",    // stable gate ID (see table above)
  "severity": "warn",                       // "info" | "warn" | "error"
  "artifacts": ["features/my-feature/feature-state.json"],
  "expected": "at least one non-marker passing evidence entry",
  "actual": "coding complete marker exists with no passing evidence",
  "detail": "Coding is marked complete but ...",
  "recommendedAction": "Investigate whether the coding stage produced verifiable output"
}
```

---

## Grep-friendly prefix

Each newly emitted warning also prints a stable key-value line to stdout:

```
soft-gate.warning issue=HOK-1234 gate=completion_without_evidence severity=warn artifact=features/my-feature/feature-state.json detail="..."
```

Search all warnings across runs:

```bash
grep 'soft-gate.warning' .wavemill/logs/soft-gates.jsonl | jq -r '.gate + " " + .detail'
# or with the key-value format captured in CI logs:
grep 'soft-gate.warning gate=' build.log
```

---

## Dedup

Cross-tick dedup prevents warning spam when the same breach repeats on every
monitor poll.

A fingerprint (`sha256` of `issueId|slug|gate|artifacts|expected|actual`) is
persisted in `.wavemill/logs/.soft-gates-seen.json` using the serialized
`mutateJsonState` writer. Any warning whose fingerprint is already present is
counted as `suppressed` and not re-written or re-printed.

---

## CLI tool

```bash
# Detect and emit for the current worktree feature
npx tsx tools/check-soft-gates.ts

# Scope to a specific task
npx tsx tools/check-soft-gates.ts HOK-1234
npx tsx tools/check-soft-gates.ts --slug my-feature-slug
npx tsx tools/check-soft-gates.ts --feature-dir features/my-feature

# Print JSON array of warnings
npx tsx tools/check-soft-gates.ts --json

# Detect only — do not write log or persist fingerprints
npx tsx tools/check-soft-gates.ts --no-emit
```

The tool **always exits 0** regardless of findings.

---

## Reuse in other consumers

The module exports three functions for use by observer, dashboard, or eval
diagnostics without duplicating gate logic:

```typescript
import {
  evaluateSoftGates,   // pure detection, returns SoftGateWarning[]
  emitSoftGates,       // append to log, print grep lines, dedup
  checkAndEmitSoftGates, // convenience wrapper: evaluate + emit
} from './shared/lib/soft-gates.ts';
```

`evaluateSoftGates()` is synchronous and side-effect-free.
`emitSoftGates()` is async (uses `mutateJsonState` for the dedup file).
Both are best-effort and never throw.

---

## Future graduation to hard gates

Soft gates are intentionally observability-only. Once a gate demonstrates
reliable signal (low false-positive rate, actionable detail, stable breach
frequency), it may be converted to a narrow hard gate in a follow-up issue.
That conversion should happen in isolation, per gate, with explicit acceptance
criteria for the hard-gate behavior.
