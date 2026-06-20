# Soft Gates

Soft gates are observability-only checks for normalized task artifacts. They detect drift between `task-contract.json`, `feature-state.json`, `trace.jsonl`, stage results, route artifacts, workflow state, and eval records, then emit structured warnings without changing workflow behavior.

## Non-goals

- Soft gates do not block phase transitions, merges, cleanup, ready checks, or eval/export behavior.
- Soft gates do not require normalized artifacts for legacy tasks. Missing artifacts remain silent coverage gaps and are not emitted to the soft-gate log.
- Soft gates do not change routing, scoring, or model selection.

## Log format

Warnings append to `.wavemill/logs/soft-gates.jsonl` as JSONL records:

```json
{
  "timestamp": "2026-06-19T12:34:56.000Z",
  "issueId": "HOK-2263",
  "slug": "add-non-blocking-soft-gates-for-normalized-task-artifact-inconsistencies",
  "gate": "completion_without_evidence",
  "severity": "warn",
  "artifacts": ["features/example/feature-state.json"],
  "expected": "passing verification evidence",
  "actual": "no non-marker passing evidence",
  "detail": "Coding is marked complete but feature-state has no passing evidence beyond legacy markers",
  "recommendedAction": "Verify CI/ready evidence or rerun verification before relying on completion markers",
  "traceId": "trc_12345678_deadbeefcafebabe",
  "fingerprint": "7dd8f55fd9ef4bf3"
}
```

Each emitted warning also writes a grep-friendly stderr line:

```text
soft-gate.warning issue=HOK-2263 gate=completion_without_evidence severity=warn artifact=features/example/feature-state.json detail="Coding is marked complete but feature-state has no passing evidence beyond legacy markers"
```

## Current gates

- `artifact_malformed`: a normalized artifact exists but is malformed.
- `contract_source_hash_mismatch`: a contract source hash no longer matches the projected source file.
- `route_contract_mismatch`: route provenance points at a packet or plan hash that does not match the active contract.
- `completion_without_evidence`: coding completion markers exist without passing verification evidence.
- `ready_inconsistency`: ready passed, but normalized outcome or evidence disagrees.
- `outcome_divergence`: normalized outcome disagrees with `.wavemill/workflow-state.json`.
- `trace_linkage_missing`: route, stage, or eval artifacts are missing the active `traceId`, or carry a different one.
- `trace_event_unreflected`: trace lifecycle events are not reflected in normalized outcome data.
- `fallback_verification_mismatch`: fallback to a weaker model was recorded without corresponding remediation or stronger verification signals.
- `eval_without_outcome`: eval records exist but the normalized outcome is absent or non-final.
- `eval_export_inconsistency`: a training-eligible eval record exists while normalized outcome fields required by export diagnostics are incomplete.

## Dedup behavior

Warnings are deduplicated by a stable fingerprint over:

- `issueId`
- `gate`
- sorted `artifacts`
- `expected`
- `actual`

By default, repeated warnings with the same fingerprint are suppressed for 6 hours. Override with `WAVEMILL_SOFT_GATES_SUPPRESS_SECONDS` or `tools/check-soft-gates.ts --suppress-window <seconds>`.

## Reuse

Gate detection lives in `shared/lib/artifact-diagnostics.ts`. Emission, deduplication, and logging live in `shared/lib/soft-gates.ts`. Reuse `evaluateSoftGates()` when a caller only needs current findings, and `runSoftGates()` when it should also apply deduplication and write logs.
