# Native Certification Scenario Harness

This document describes the deterministic certification scenario harness that ships on top of the native certification contract (HOK-2392, `docs/native-certification-contract.md`). The harness provides:

- A typed scenario catalog with per-scenario executable assertions.
- A runner that walks the catalog, dispatches assertions, and aggregates results.
- A loud-unsupported guarantee for missing compat fixtures and failed capability checks.
- A dry-run guarantee that prevents accidental live certification from offline runs.

---

## Relationship to the Certification Contract

The harness is a **downstream consumer** of the contract defined in HOK-2392. It does **not** mutate `schema.ts`, `schema.json`, `loader.ts`, or `store.ts`. The persisted `NativeCertificationArtifact` shape and its `ScenarioResult` sub-records are unchanged; the harness introduces richer in-memory types (`HarnessScenarioResult`, `HarnessReport`) and projects down to the persisted shape via `toArtifactScenario()` when a live cert is written.

---

## Scenario Model

### Classification

```
ScenarioClassification = 'deterministic' | 'live-judged'
```

- **`deterministic`** — assertion runs offline against scripted providers, compat fixtures, and pure helper functions. Produces `pass`, `fail`, or `unsupported`. All scenarios in `getDefaultScenarios()` that can be certifying are deterministic.
- **`live-judged`** — assertion requires a paid LLM call. The runner returns `not-run` for these without invoking any network call.

### Category

```
ScenarioCategory = 'tool' | 'usage' | 'transcript' | 'phase'
```

| Category | Tests |
|---|---|
| `tool` | Compat fixture lookup, `validateToolCompat` capability check |
| `usage` | Token mapping from scripted provider turns |
| `transcript` | `TranscriptWriter` JSONL correctness |
| `phase` | `phaseSatisfies` ordering, `writeCertification` / `checkCertificationEligibility` roundtrip |

### CertificationScenario

```ts
interface CertificationScenario {
  id: string;                     // stable, kebab-case
  phase: CertificationPhase;      // from PHASE_ORDER ('read-only' | 'patch' | 'workflow')
  category: ScenarioCategory;
  classification: ScenarioClassification;
  description: string;
  assertion?: ScenarioAssertion;  // required iff classification === 'deterministic'
  knownLimitation?: string;       // surfaced into HarnessReport.knownLimitations
}
```

---

## Default Catalog

`getDefaultScenarios()` returns the shipped catalog. All entries are deterministic except the live-judged placeholder that exercises the `not-run` runner path.

| Scenario ID | Category | What it certifies |
|---|---|---|
| `tool.compat.git_status.openai-completions` | `tool` | `git_status` fixture exists for `openai-completions`; `validateToolCompat` returns ok for (provider, model, transport) |
| `usage.scripted.records-input-output-tokens` | `usage` | Scripted provider turn with `usage: { input: 100, output: 25 }` maps to `inputTokens: 100, outputTokens: 25` |
| `transcript.scripted.session_started_then_ended` | `transcript` | `TranscriptWriter` produces JSONL with `session_started` first, `session_ended` last, matching `sessionId`/`provider`/`model` |
| `phase.read-only.satisfies-read-only` | `phase` | `phaseSatisfies('read-only', 'read-only')` and `phaseSatisfies('patch', 'read-only')` are true; `phaseSatisfies('read-only', 'patch')` is false |
| `phase.fixture.persistence-roundtrip` | `phase` | `writeCertification` + `checkCertificationEligibility` round-trip returns `eligible: true` |
| `live.judge.tool-output-summary-quality` | `tool` | Live-judged placeholder — always returns `not-run` |

### Catalog integrity rules

Enforced by `scenarios.test.ts` and checked at CI:

- Every `id` is a non-empty string.
- No duplicate `id`s (case-sensitive).
- Every `deterministic` scenario has an `assertion` function.
- No `live-judged` scenario has an `assertion` function.
- Every `phase` value is in `PHASE_ORDER`.
- Every category (`tool`, `usage`, `transcript`, `phase`) has ≥1 deterministic scenario.

### Adding a scenario

1. Write an `async function assertMySomething(ctx: ScenarioContext): Promise<ScenarioAssertionOutcome>` in `scenarios.ts`.
2. Add a `CertificationScenario` entry to `DEFAULT_SCENARIOS` with `assertion: assertMySomething`.
3. If the scenario can never pass offline (requires an LLM call), set `classification: 'live-judged'` and omit `assertion`.
4. `scenarios.test.ts` will catch any catalog integrity violations at test time.

---

## Runner

### Input

```ts
interface RunScenariosOptions {
  provider: NativeProviderName;   // 'openai' | 'openrouter'
  model: string;
  transport: PiTransportKind;     // 'openai-responses' | 'openai-completions'
  scenarios: CertificationScenario[];
  registry?: ModelRegistry;       // forwarded to validateToolCompat
  dryRun?: boolean;               // default false
}
```

### Output

```ts
interface HarnessReport {
  provider: string;
  model: string;
  transport: PiTransportKind;
  results: HarnessScenarioResult[];
  countsByStatus: Record<HarnessScenarioStatus, number>;
  countsByCategory: Record<ScenarioCategory, number>;
  knownLimitations: string[];
  harnessPassed: boolean;       // zero fail + zero unsupported
  liveCertifiable: boolean;     // harnessPassed && !dryRun
  dryRun: boolean;
}
```

### Status semantics

| Status | Meaning |
|---|---|
| `pass` | Assertion returned `{ kind: 'pass' }` |
| `fail` | Assertion returned `{ kind: 'fail' }` or threw; never re-thrown |
| `unsupported` | Assertion returned `{ kind: 'unsupported' }` with a stable `reason` code |
| `not-run` | Scenario is `live-judged`; skipped without invoking any assertion |

### harnessPassed

`harnessPassed = (fail === 0 && unsupported === 0)`.

Every `unsupported` result is unexpected — if a scenario is expected to be unsupported for a given context, its catalog entry should be `live-judged` (→ `not-run`) rather than `deterministic` (→ `unsupported`). The runner never silently drops an unsupported result.

---

## Loud-unsupported guarantee

Three structured `unsupported` reason codes are emitted loudly in the results array (never silently dropped):

| Reason | Trigger |
|---|---|
| `fixture-not-found` | `findFixture(tool, transport)` returns `undefined` |
| `capability-validator-rejected` | `validateToolCompat()` returns `ok: false` |
| `shape-mismatch` | Scripted provider result doesn't match fixture's `expectedToolCall` |
| `registry-missing-model` | Model has no `nativeCapability` entry in the supplied registry |

All four are included in `HarnessScenarioResult.reason` when applicable. Any assertion that returns `{ kind: 'unsupported' }` must supply a non-empty `detail` string — this is the primary diagnostic surface.

---

## Dry-run guarantee

```ts
const report = await runScenarios({ ..., dryRun: true });
// report.dryRun === true
// report.liveCertifiable === false  ← always false for dry-run
```

`runScenarios({ dryRun: true })` runs every deterministic assertion (same mechanics as a live run) but sets `report.liveCertifiable = false` unconditionally. The runner itself never writes a certification artifact; that is the caller's responsibility.

**Contract:** Do not pass a `dryRun: true` report's `toArtifactScenario()` results to `writeCertification` as a live certification. The `liveCertifiable` field on the report is the programmatic guard — callers must check it before writing.

---

## Artifact projection

```ts
import { toArtifactScenario } from './certification/scenario-runner.ts';

// For live (non-dry-run) reports only:
if (report.liveCertifiable) {
  const scenarioResults = report.results.map(toArtifactScenario);
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: report.provider,
    model: report.model,
    phase: 'read-only',
    suiteVersion: 'v1',
    certifiedAt: new Date().toISOString(),
    scenarios: scenarioResults,
    knownLimitations: report.knownLimitations,
  };
  writeCertification(repoDir, artifact);
}
```

`toArtifactScenario(result)` maps any `HarnessScenarioResult` to a `ScenarioResult` shape:
- `pass` → `{ scenarioId, passed: true }`
- `fail` / `unsupported` / `not-run` → `{ scenarioId, passed: false, failureMessage: result.detail }`

---

## Source of truth

| File | Role |
|---|---|
| `shared/lib/native-agent/certification/scenarios.ts` | Catalog types, scenario definitions, assertion functions |
| `shared/lib/native-agent/certification/scenario-runner.ts` | Runner, aggregator, artifact projection |
| `shared/lib/native-agent/certification/scenarios.test.ts` | Catalog integrity tests |
| `shared/lib/native-agent/certification/scenario-runner.test.ts` | Runner behavior tests |
| `shared/lib/native-agent/certification/index.ts` | Barrel re-exports |
| `docs/native-certification-contract.md` | Persisted artifact contract (HOK-2392) |
