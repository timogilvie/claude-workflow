# Native Certification Scenario Harness

This document describes the deterministic certification scenario harness that ships on top of the native certification contract (HOK-2392, `docs/native-certification-contract.md`). The harness provides:

- A typed scenario catalog with per-scenario executable assertions.
- A runner that walks the catalog, dispatches assertions, and aggregates results.
- A loud-unsupported guarantee for missing compat fixtures and failed capability checks.
- A dry-run guarantee that prevents accidental live certification from offline runs.

---

## Relationship to the Certification Contract

The harness is a **downstream consumer** of the contract defined in HOK-2392. It keeps the persisted contract additive and compatible while extending `ScenarioResult` with retry-accounting fields for live-certification reporting. The harness also introduces richer in-memory types (`HarnessScenarioResult`, `HarnessReport`) and projects them to the persisted shape via `toArtifactScenario()` when a live cert is written.

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
ScenarioCategory =
  | 'budget'
  | 'cleanup'
  | 'policy'
  | 'provenance'
  | 'tool'
  | 'usage'
  | 'transcript'
  | 'phase'
```

| Category | Tests |
|---|---|
| `budget` | Budget and cost-accounting stop behavior |
| `cleanup` | Cleanup and rollback behavior after workflow abort/timeout |
| `policy` | Phase-policy denial for out-of-phase mutation attempts |
| `provenance` | Runtime/tool-set resource-manifest provenance records |
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
| `workflow.planning.tool-availability` | `tool` | Planning workflow exposes required read-only planning/artifact tools and no mutation tools |
| `workflow.transcript-provenance.manifest-records` | `provenance` | Workflow certification writes transcript start/end events and runtime/tool-set provenance in the resource manifest |
| `workflow.budget.cost-limit` | `budget` | Scripted workflow loop stops with `cost_limit` after exceeding `maxCostUsd` |
| `workflow.cleanup.rollback-on-timeout` | `cleanup` | Cleanup rolls back tracked workflow mutations and leaves the tree clean after timeout |
| `workflow.policy.denies-out-of-phase-mutation` | `policy` | Planning phase denies a mutation tool whose allowed phase is coding |

### Workflow Certification

Workflow certification is the prerequisite for selecting a native model in planner/workflow routing. A `--phase workflow` run includes lower-phase scenarios, but the CLI writes a `phase: "workflow"` artifact only when deterministic workflow-phase scenarios are present in the catalog and their workflow results pass. Passing read-only scenarios alone cannot promote a model to workflow certification.

The workflow scenarios prove that Wavemill-owned planner/workflow mechanics are wired correctly for a provider/model entry:

- Planning exposes the expected read-only and artifact-inspection tools.
- Mutation tools remain unavailable during planning unless a later phase explicitly allows them.
- Transcript start/end records and resource-manifest runtime/tool-set provenance are emitted for the workflow phase.
- Budget accounting can stop a scripted workflow run at the configured cost limit.
- Cleanup can roll back tracked workflow mutations after timeout.

Workflow certification does not prove model quality, plan usefulness, broad OpenRouter catalog compatibility, coding safety, or provider uptime. It also does not automatically expand native usage to every OpenRouter model. Each model must still be registered, configured for native use, and hold a fresh artifact whose provider, model, suite version, phase, TTL, and scenario results satisfy router checks.

Existing read-only certification behavior remains backward compatible: the default suite version stays `v1`, read-only artifacts continue to certify read-only phases, and lower-phase artifacts still fail closed when a workflow phase is required.

### Catalog integrity rules

Enforced by `scenarios.test.ts` and checked at CI:

- Every `id` is a non-empty string.
- No duplicate `id`s (case-sensitive).
- Every `deterministic` scenario has an `assertion` function.
- No `live-judged` scenario has an `assertion` function.
- Every `phase` value is in `PHASE_ORDER`.
- Every category (`budget`, `cleanup`, `policy`, `provenance`, `tool`, `usage`, `transcript`, `phase`) has ≥1 deterministic scenario.
- Workflow scenarios cover planning tool availability, workflow transcript/provenance, budget behavior, cleanup behavior, and denial of out-of-phase mutation.

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
  retryPolicy?: { maxAttempts?: number }; // default 3 total attempts
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

## Retry & flake accounting

Deterministic scenarios can now return four assertion outcomes:

- `pass`
- `fail`
- `provider-flake`
- `unsupported`

Only `provider-flake` is retry-eligible. The runner applies a bounded retry policy with `maxAttempts: 3` by default. Deterministic failures and unsupported capabilities short-circuit immediately and can never be retried into a pass result.

Failure classification is surfaced separately from top-level status:

- `fail` + `failureClass: 'deterministic_failure'`
- `fail` + `failureClass: 'provider_flake'` when retries exhaust
- `unsupported` + `failureClass: 'unsupported_capability'`

Persisted `ScenarioResult` fields now include:

- `attempts` — total attempts executed
- `finalAttemptStatus` — final assertion outcome kind
- `failureClass` — deterministic failure vs provider flake vs unsupported capability
- `retryCount` — legacy field, still populated as `attempts - 1`

To mark a transient provider issue from an assertion, return:

```ts
return { kind: 'provider-flake', detail: 'provider returned malformed transient response' };
```

The persisted certification schema version is now `2`.

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
- `pass` → `{ scenarioId, passed: true, attempts, finalAttemptStatus: 'pass', retryCount }`
- `fail` / `unsupported` / `not-run` → `{ scenarioId, passed: false, failureMessage: result.detail, attempts?, finalAttemptStatus?, failureClass?, retryCount? }`

---

## Operator Commands

### `wavemill native-agent models report`

Lists certification status for every native-capable model in the registry. Reads from registry metadata and on-disk artifacts only — never triggers a paid provider call.

```bash
# Human-readable table
wavemill native-agent models report

# Machine-readable JSON (suitable for CI)
wavemill native-agent models report --json

# Filter by provider
wavemill native-agent models report --provider openai

# Filter by model
wavemill native-agent models report --model gpt-4o --json
```

**Output states:**

| State | Meaning |
|---|---|
| `ready` | Fresh, passing certification; satisfies ≥1 router stage |
| `uncertified` | `certified` capability but no valid on-disk artifact |
| `stale` | Artifact present but TTL-expired or suite-version mismatch |
| `unsupported` | `readOnlyNative: 'unsupported'` — model never intended for native use |
| `certification-only` | `readOnlyNative: 'partial'` — routable in cert mode only, not task mode |

**Exit codes:** `0` always on successful listing (even with uncertified rows); `2` on invalid input.

---

### `wavemill native-agent certify`

Runs the certification scenario harness for a specific provider/model/phase. On success (non-dry-run), writes a `NativeCertificationArtifact` to disk.

```bash
# Dry run — validate without persisting (safe offline)
wavemill native-agent certify --provider openai --model gpt-4o --phase read-only --dry-run

# Live certification — runs scenarios and writes artifact on success
wavemill native-agent certify --provider openai --model gpt-4o --phase read-only

# JSON output (artifact path + scenario outcomes)
wavemill native-agent certify --provider openai --model gpt-4o --phase read-only --json

# OpenRouter example
wavemill native-agent certify --provider openrouter --model openai/gpt-4o --phase read-only --dry-run

# Workflow certification dry run — validates planner/workflow scenarios without persisting
wavemill native-agent certify --provider openrouter --model qwen/qwen3-coder --phase workflow --dry-run
```

**Flags:**

| Flag | Required | Default | Description |
|---|---|---|---|
| `--provider` | yes | — | `openai` or `openrouter` |
| `--model` | yes | — | Model ID (e.g. `gpt-4o`) |
| `--phase` | yes | — | `read-only`, `patch`, or `workflow` |
| `--dry-run` | no | false | Run scenarios without writing an artifact |
| `--json` | no | false | Machine-readable JSON output |
| `--repo` | no | cwd | Repository root |

**Exit codes:** `0` harness passed; `1` harness failed or model unsupported; `2` invalid input.

**Dry-run contract:** A dry-run report is never `liveCertifiable`. No artifact is written regardless of scenario outcomes. Use `--dry-run` in CI pipelines to validate harness connectivity without spending quota.

---

## Source of truth

| File | Role |
|---|---|
| `shared/lib/native-agent/certification/scenarios.ts` | Catalog types, scenario definitions, assertion functions, `DEFAULT_CERTIFICATION_SUITE_VERSION` |
| `shared/lib/native-agent/certification/scenario-runner.ts` | Runner, aggregator, artifact projection |
| `shared/lib/native-agent/certification/report.ts` | Report builder, serializer, table renderer |
| `shared/lib/native-agent/certification/scenarios.test.ts` | Catalog integrity tests |
| `shared/lib/native-agent/certification/scenario-runner.test.ts` | Runner behavior tests |
| `shared/lib/native-agent/certification/report.test.ts` | Report builder tests |
| `shared/lib/native-agent/certification/index.ts` | Barrel re-exports |
| `tools/native-agent-models-report.ts` | `wavemill native-agent models report` CLI |
| `tools/native-agent-certify.ts` | `wavemill native-agent certify` CLI |
| `docs/native-certification-contract.md` | Persisted artifact contract (HOK-2392) |
