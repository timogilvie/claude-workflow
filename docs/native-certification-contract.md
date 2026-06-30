# Native Agent Certification Contract

This document defines the stable contract for native provider/model phase certification. It is intended as a reference for downstream consumer implementations in the harness, registry, router, and CLI.

## Overview

Before a native agent (provider + model pair) can be used in a given phase, it must hold a current certification artifact. The certification records which phase level was achieved, which suite version was run, per-scenario pass/fail outcomes, and when the artifact was issued.

All certification evaluation is **fail-closed**: missing, malformed, stale, wrong-version, phase-insufficient, and scenario-failed certifications all produce a structured `eligible: false` result. No evaluation path throws an exception.

---

## Storage Path Contract

```
.wavemill/native-agent-certifications/<provider>/<model>/<suite-version>.json
```

**Example:**

```
.wavemill/native-agent-certifications/anthropic/claude-sonnet-4-6/v1.json
```

### Path segment rules

- All three segments (`provider`, `model`, `suite-version`) must be non-empty strings.
- No segment may contain `/`, `\`, `.`, or NUL characters.
- Path traversal sequences (`.`, `..`) are rejected, not normalized.
- Model IDs with embedded slashes (e.g. some OpenRouter model IDs) must be re-encoded before use as path segments; this re-encoding is the caller's responsibility.

---

## Artifact Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | `1` (integer literal) | yes | Schema version for forward compatibility |
| `provider` | string | yes | Provider identifier (e.g. `anthropic`, `openai`) |
| `model` | string | yes | Model identifier (e.g. `claude-sonnet-4-6`) |
| `phase` | `"read-only"` \| `"patch"` \| `"workflow"` | yes | Certified phase level |
| `suiteVersion` | string | yes | Suite version that was run; matches the path segment |
| `certifiedAt` | ISO 8601 datetime | yes | When certification was completed |
| `expiresAt` | ISO 8601 datetime | no | Explicit expiry; takes precedence over derived TTL |
| `scenarios` | array of `ScenarioResult` | yes | Per-scenario outcomes |
| `knownLimitations` | string[] | no | Human-readable caveats for this certification |
| `totalRetryCount` | integer ≥ 0 | no | Aggregate retry count across all scenarios |

### ScenarioResult fields

| Field | Type | Required | Description |
|---|---|---|---|
| `scenarioId` | string | yes | Stable scenario identifier within the suite |
| `passed` | boolean | yes | Whether the scenario passed |
| `failureMessage` | string | no | Human-readable failure description |
| `retryCount` | integer ≥ 0 | no | Attempts before final result |

---

## Phase Ordering and Eligibility Semantics

Phases are ordered from least to most permissive:

```
read-only  <  patch  <  workflow
```

A higher certification **satisfies** all lower required phases. A lower certification **never** satisfies a higher required phase.

| Certified phase | Satisfies `read-only`? | Satisfies `patch`? | Satisfies `workflow`? |
|---|---|---|---|
| `read-only` | yes | **no** | **no** |
| `patch` | yes | yes | **no** |
| `workflow` | yes | yes | yes |

**Phase semantics:**

- **`read-only`**: The agent may read files, run searches, and inspect repository state. No mutations are permitted.
- **`patch`**: The agent may apply patches and make file mutations, in addition to all read-only operations.
- **`workflow`**: The agent may execute full workflow operations including multi-step state changes, in addition to all patch operations.

---

## Suite-Version Invalidation

A certification is only valid for the exact `suiteVersion` it was issued against. If the required suite version changes (e.g. from `v1` to `v2`), all existing `v1` certifications are automatically invalid for new `v2` checks — they do not need to be deleted, they simply do not satisfy a `v2` requirement.

Downstream consumers must supply the current suite version when calling `evaluateEligibility` or `checkCertificationEligibility`. Mismatched suite versions return the `wrong-version` reason code.

---

## TTL Policy

Default TTL: **60 days** from `certifiedAt`.

### Rationale for 60 days

- **30 days** was considered too frequent given the overhead of full certification runs and the low API churn rate for established providers.
- **90 days** risks staleness after provider API changes or model updates that may alter behavior within the certified scenario set.
- **60 days** is the chosen default; it balances re-certification cost against freshness risk.

### Precedence rules

1. If `expiresAt` is present on the artifact, it is used as the expiry boundary. The staleness check is `now >= expiresAt`.
2. If `expiresAt` is absent, the derived TTL is used: `certifiedAt + 60 days`. The staleness check is `now >= certifiedAt + 60d`.

Both checks are exclusive at the boundary: a certification is stale at the exact moment it expires.

### Injecting `now` for tests

All TTL evaluation functions accept an optional `now: Date` parameter so unit tests can exercise boundary conditions deterministically without relying on wall clock time.

---

## Reason Codes

The evaluator returns one of the following stable reason codes when a certification is ineligible:

| Code | Meaning |
|---|---|
| `missing` | No artifact file exists at the expected path |
| `malformed` | The artifact file exists but cannot be parsed or fails structural validation |
| `wrong-version` | The artifact `schemaVersion` or `suiteVersion` does not match what is required |
| `stale` | The artifact has expired (past `expiresAt` or past `certifiedAt + 60d`) |
| `phase-insufficient` | The artifact's `phase` is lower than the required phase |
| `scenario-failure` | One or more scenarios in the artifact did not pass, or the scenarios array is empty |

Reason codes are checked in the following order: `wrong-version` → `stale` → `phase-insufficient` → `scenario-failure`. The first failing check short-circuits further evaluation.

---

## API Reference

All exported symbols are available from `shared/lib/native-agent/certification/index.ts`.

### `checkCertificationEligibility(repoDir, provider, model, suiteVersion, requiredPhase, now?)`

Combined load + evaluate. Reads the artifact from disk and evaluates eligibility in one call. All failure paths return `{ eligible: false, reason }` — never throws.

### `evaluateEligibility(artifact, requiredSuiteVersion, requiredPhase, now?)`

Evaluates a pre-loaded artifact against a required suite version and phase. The `now` parameter defaults to `new Date()` if omitted.

### `loadCertification(repoDir, provider, model, suiteVersion)`

Reads and structurally validates an artifact from disk. Returns `{ ok: true, artifact }` or `{ ok: false, reason: 'missing' | 'malformed' }`.

### `buildCertificationPath(repoDir, provider, model, suiteVersion)`

Returns the canonical artifact path. Throws if any segment fails the safety check.

### `parseCertificationPath(path)`

Extracts `{ provider, model, suiteVersion }` from an artifact path. Returns `undefined` when the path does not match the expected layout.

### `phaseSatisfies(actual, required)`

Returns `true` if `actual` phase satisfies `required` phase according to the ordering.

### `isCertificationFresh(artifact, now)`

Returns `true` if the artifact has not expired.

### `allScenariosPassed(artifact)`

Returns `true` if all scenarios passed and the scenarios array is non-empty.

---

## Storage and Validation Helpers

The `shared/lib/native-agent/certification/` module includes storage and validation helpers on top of the core evaluation contract.

### Writing and reading artifacts

```ts
import { writeCertification, readCertification, listCertifications } from './store.ts';

// Write atomically (temp file + rename); returns the final absolute path.
const path = writeCertification(repoDir, artifact);

// Read from an absolute path with fine-grained error codes:
// 'not-found' | 'unreadable' | 'invalid-json' | 'schema-mismatch'
const result = readCertification(path);
if (result.ok) {
  console.log(result.artifact.phase);
} else {
  console.error(result.error.code, result.error.message);
}

// List all .json artifact paths under .wavemill/native-agent-certifications/
const paths = listCertifications(repoDir);
```

### Aggregate validator

`validateCertification` runs all checks without short-circuiting, returning every failure as a `ValidationError` with an actionable message and structured `detail`:

```ts
import { validateCertification } from './validator.ts';

const result = validateCertification(artifact, {
  expectedProvider: 'anthropic',
  expectedModel: 'claude-sonnet-4-6',
  expectedSuiteVersion: 'v1',
  requiredPhase: 'patch',
  requiredCapabilities: ['long-context'], // checked against knownLimitations
  now: new Date(),
});

if (!result.ok) {
  for (const err of result.errors) {
    console.error(err.code, err.message);
  }
}
```

**Validation error codes**: `schema-version-mismatch`, `suite-version-mismatch`, `expired`, `phase-insufficient`, `identity-mismatch`, `limitation-conflict`, `scenario-failure`.

The per-check helpers (`checkSchemaVersion`, `checkSuiteVersion`, `checkNotExpired`, `checkPhaseSatisfies`, `checkIdentity`, `checkLimitations`, `checkScenarios`) are also exported for callers that need narrower checks.

---

## Scope and Non-Goals

This contract covers **only** the certification schema, storage path, phase semantics, TTL policy, and fail-closed evaluation helpers. It does not:

- Change any existing router, harness, registry, or CLI routing behavior.
- Define how certification runs are triggered or orchestrated.
- Specify which suite scenarios are required for each phase level.

These concerns are addressed in downstream implementation issues that consume this contract.

---

## Registry Metadata Mirror

The canonical model registry mirrors the artifact contract under `nativeCapability.certification` so router and CI decisions can be made from checked-in repo state alone:

```ts
nativeCapability: {
  nativeProvider: 'openai' | 'openrouter';
  piTransportKind: 'openai-responses' | 'openai-completions';
  readOnlyNative: 'certified' | 'partial' | 'unsupported';
  certification?: {
    maxCertifiedPhase: 'read-only' | 'patch' | 'workflow';
    certifiedAt: string;
    certificationSuiteVersion: string;
    knownLimitations?: string[];
  };
}
```

`nativeProvider` and `piTransportKind` are the registry's provider/transport identity. The certification block does not duplicate them.

### Registry validation split

- Structural validation is always-on in `shared/lib/model-registry.ts`. It rejects incomplete metadata, malformed timestamps, missing provider/transport identity, and contradictions between checked-in capability flags and the certification phase.
- Freshness validation is explicit and time-aware. `validateCertificationFreshness`, `maxCertifiedPhaseForModel`, and `isCertifiedForPhase` accept an injectable `now` and treat stale certifications as ineligible without making the registry structurally invalid.

This split avoids turning checked-in `certifiedAt` values into build-breaking time bombs while still letting router, CI, and tests fail closed on stale certification state.
