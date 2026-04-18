# Subsystem: eval-system

**Last updated:** 2026-04-18
**Files touched:** 6

## Purpose

The eval system persists autonomous-workflow outcomes into `.wavemill/evals/evals.jsonl` using an additive schema so downstream readers can aggregate training signals without migrations.

It now also captures quota-driven cross-model fallback events through the same eval pipeline, which keeps prompt attribution, aggregation, and router-training consumers on one record stream.

## Key Files

| File | Role | Notes |
|------|------|-------|
| `shared/lib/eval-schema.ts` | Canonical TypeScript schema and changelog | Minor version bumps are required for additive fields. |
| `shared/lib/eval-schema.json` | JSON Schema mirror for validator-style tests | Must stay in sync with `eval-schema.ts`. |
| `shared/lib/eval.ts` | Builds judge-backed eval records | Owns the top-level `SCHEMA_VERSION`. |
| `shared/lib/eval-record-builder.ts` | Pure metadata attachment helpers | Null/undefined metadata must remain a no-op. |
| `shared/lib/eval-persistence.ts` | Appends and reads `evals.jsonl` | Persistence failures should never corrupt prior records. |
| `shared/lib/llm-cli.ts` | Emits fallback eval records on quota-triggered model swaps | Uses best-effort logging only after fallback events. |

## Architectural Constraints

### DO

- Keep schema evolution additive. New fields must be optional so old `evals.jsonl` rows continue to parse unchanged.
- Bump the eval schema minor version on additive changes and document the change in `eval-schema.ts`.
- Keep `eval-record-builder.ts` helpers pure and local: mutate the provided record, but treat `null` and `undefined` as "do nothing".
- Route fallback telemetry through `appendEvalRecord()` so prompt-registry and aggregation tooling continue to observe a single eval pipeline.
- Treat telemetry writes as best-effort metadata. Fallback logging must never change the success or failure semantics of the LLM call itself.

### DON'T

- Do not introduce required fields for new training metadata.
- Do not create a parallel fallback-event store unless aggregation consumers are intentionally being split.
- Do not make eval persistence failures fatal to workflow execution or `llm-cli` request handling.

## Fallback Event Records (1.6.0)

`EvalRecord.fallbackEvent` is an optional nested payload for quota-aware attribution. It is only emitted when a cross-model fallback actually occurs.

Fields:

- `preferred_model`: first candidate attempted before fallback.
- `fallback_model`: model that ultimately succeeded, or `null` if no candidate did.
- `task_type`: routing ladder type used by `llm-cli`.
- `difficulty`: optional caller-supplied `DifficultyBand`.
- `quota_snapshot`: `{ snapshotAt, models }` copy of `readQuotaSnapshot()` reduced to training-relevant fields.
- `human_intervention`: currently always `false` for `llm-cli`-emitted records.
- `outcome`: one of `success`, `all_exhausted`, or `non_quota_error`.
- `latency_ms`: total wall-clock duration across the fallback sequence.
- `cost_usd`: final surfaced cost when available, otherwise `null`.
- `fallback_chain`: ordered failures that preceded the terminal outcome.
- `schema_version`: nested payload version, currently `1.0`.

Emission rules:

- No record is emitted when the first model succeeds and no fallback occurs.
- A `success` record is emitted when at least one quota fallback happens and a later model succeeds.
- An `all_exhausted` record is emitted before `LLMQuotaError` is thrown after every candidate hits quota.
- A `non_quota_error` record is emitted when quota fallback has already started and a later candidate fails for a different reason.

Compatibility and aggregation notes:

- Missing `fallbackEvent` must be interpreted as "older record", not a parse failure.
- Fallback records use the same top-level `EvalRecord` shape and `schemaVersion = 1.6.0`.
- Aggregation remains schema-version agnostic; dedup still keys on existing top-level fields.

## Known Failure Modes

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| New fallback fields validate in TypeScript but schema tests fail | `eval-schema.json` was not updated with the additive field | Update both schema files in the same change. |
| Fallback occurred but no eval row was written | `logFallbackEvents` was disabled or persistence failed | Check `LLMCallOptions.logFallbackEvents`, then inspect `console.warn` output from `llm-cli`. |
| Older eval readers reject records | A new field was made required or parsing assumed presence | Restore optional semantics and add backward-compat coverage. |
| Fallback logging changes request behavior | Telemetry exception leaked out of the emitter | Keep `appendEvalRecord()` calls wrapped in local `try/catch`. |

## Testing Patterns

- Validate both TypeScript and JSON Schema surfaces when adding eval fields.
- Keep builder tests focused on null-safe attachment behavior.
- For `llm-cli` fallback telemetry, use a temp repo and assert directly on `.wavemill/evals/evals.jsonl`.
- Cover success, all-exhausted, non-quota-abort, and opt-out paths for fallback emission.

## Dependencies

- `shared/lib/quota-state.ts` for projected quota snapshots.
- `shared/lib/evals-paths.ts` and `shared/lib/eval-persistence.ts` for repo-aware JSONL writes.
- `shared/lib/eval-aggregator.ts` and router consumers for downstream reads.
- `shared/lib/prompt-registry.ts` for adjacent attribution tooling that shares the eval storage area.

## Related Subsystems

- [quota-tracking](./quota-tracking.md) — source of model health and snapshot data used in fallback records.
- [router](./router.md) — consumes quota-aware signals and informs task-type-based model selection.

## Recent Changes

- 2026-04-18: Added `fallbackEvent` to eval schema version `1.6.0` and wired `llm-cli` quota fallback emission into `evals.jsonl`.
