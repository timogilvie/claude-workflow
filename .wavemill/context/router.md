# Router

**Last updated:** 2026-04-19T16:30:00.000Z
**Files touched:** 2 files in last 30 days

## Purpose

The router now has a single operating-mode view derived from quota health so commands can read one system-wide signal instead of inspecting each model individually.

## Operating Modes

| Mode | Meaning |
|------|---------|
| `normal` | At least one frontier model has healthy capacity after treating snapshot-absent frontier models as `healthy`. This includes mixed-frontier scenarios where the top-of-ladder frontier is degraded but a healthy frontier sibling can be substituted transparently. |
| `constrained` | Aggregate-across-frontier degraded mode: no frontier model is healthy, and at least one frontier model is `degrading` rather than `exhausted`. |
| `survival` | Aggregate-across-frontier exhausted mode: every frontier model is `exhausted`. |

Frontier models are defined by `PREMIUM_MODEL_CLASS = 'frontier'`.

## Derivation Rule

The operating mode is derived from `readQuotaSnapshot()` plus the effective model registry:

1. Resolve frontier model IDs from `getEffectiveRegistry()` where `capabilities.class === PREMIUM_MODEL_CLASS`.
2. Compute each frontier model's effective status from the quota snapshot, treating models absent from the snapshot as `healthy`.
3. Aggregate those effective statuses across the full frontier set.

Decision table:

| Effective frontier statuses (absent from snapshot = `healthy`) | Result | Notes |
|---------------------------------------------------------------|--------|-------|
| Any `healthy`, and it is the top-of-ladder frontier | `normal` | Standard routing |
| Any `healthy`, but the top-of-ladder frontier is `degrading` or `exhausted` | `normal` | Cross-frontier substitution keeps routing within the frontier class |
| None `healthy`, at least one `degrading` | `constrained` | Aggregate degraded routing; class downgrade allowed |
| Every `exhausted` | `survival` | Aggregate exhausted routing; haiku-only path |

A single degraded frontier model must never trigger `constrained` mode on its own; the router stays in `normal` until no frontier alternative is healthy.

### Normal-Mode Cross-Frontier Substitution

When `deriveOperatingMode()` returns `normal`, the routing policy still checks whether the preferred frontier candidate is degraded. If the top-of-ladder frontier is `degrading` or `exhausted` and another frontier sibling is `healthy`, routing remains in `normal` mode and substitutes the healthy sibling.

This substitution path is implemented in `routing-policy.ts`:

- `findHealthyFrontierSibling()` looks for a healthy frontier peer for the active task ladder.
- `healthyFrontierSubstituteAvailable` marks the mixed-frontier case where the preferred frontier is unhealthy but a healthy sibling exists.
- `resolveModel()` assigns `below-frontier-substitute` to non-frontier candidates in that case, preventing a downgrade to sonnet or haiku while a healthy frontier sibling is still available.

This is a normal-mode policy adjustment, not degraded routing. `workflow-router.ts` logs the substitution with `policyAdjustmentLog()` and `logFinalFrontierSubstitution()`, including `same-class=frontier` metadata. Constrained and survival banners do not fire for this path.

## API

`shared/lib/operating-mode.ts` exports:

- `deriveOperatingMode(snapshot, premiumModelIds)` for pure derivation
- `getCurrentOperatingMode(repoDir?)` for reading the current persisted quota state
- `PREMIUM_MODEL_CLASS`
- `CONSTRAINED_TRIGGER_STATUS`
- `SURVIVAL_TRIGGER_STATUS`

## Current Scope

Individual command behavior now changes based on operating mode. In `constrained` mode, routing restricts to sonnet/haiku candidates and skips LLM-based difficulty classification. In `survival` mode, routing uses haiku only and relies on stage-aware KNN signals instead of open-ended LLM reasoning.

## Proactive Degradation Detection

Operating mode now includes proactive quota-state transitions, not just reactive 429-driven state.

`readQuotaSnapshot()` can mark a model `degrading` before hard-stop if any heuristic triggers:
- Rolling request volume in the last 5 minutes crosses configured threshold
- Repeated near-limit warnings accumulate inside the healthy decay window
- Provider-surfaced budget signal reports low remaining percentage
- Remaining estimate drops below near-limit ratio threshold relative to known limit

Manual per-model overrides in `.wavemill-config.json` are applied after projection and can force
`healthy`, `degrading`, or `exhausted` status for known high-usage windows.

See [Quota Tracking](quota-tracking.md) for full signal definitions, thresholds, and CLI override flow.

## Degraded-Mode Routing

When the operating mode is `constrained` or `survival`, `routeWorkflowAuto()` automatically invokes degraded-mode routing:

- **Constrained**: Model pool restricted to `strong_generalist` and `fast_economy` classes. LLM-based difficulty classification is skipped.
- **Survival**: Model pool restricted to `fast_economy` class (haiku-only). LLM-based difficulty classification is skipped.

Both modes use stage-aware KNN signals for candidate selection and prepend a degraded-mode rationale to the routing decision's reasoning field. Those degraded-mode banners only fire once the aggregate frontier state has crossed into `constrained` or `survival`. If any frontier sibling remains healthy, routing stays in `normal` mode, uses cross-frontier substitution, and does not emit degraded-mode rationale. If no models of the appropriate class are available, routing falls back to the full pool with a warning.

`routeWorkflowDegraded()` is the explicit API for degraded-mode routing; `routeWorkflowAuto()` uses it automatically based on current operating mode.

## Architectural Constraints

### DO
- Always prepend degraded-mode rationale to routing decisions when constrained or survival
- Treat constrained and survival as aggregate-across-frontier states, not single-model triggers
- Prefer a healthy frontier sibling over non-frontier fallbacks when the top-of-ladder frontier is degrading in normal mode
- Respect `modelsAvailable` option in routing functions to allow test injection
- Skip LLM-based difficulty classification in constrained and survival modes
- Fall back to full model pool if no degraded candidates exist (with warning)

### DON'T
- Trigger constrained mode while any frontier model is healthy
- Skip cross-frontier substitution and fall back to non-frontier models while a healthy frontier sibling is available
- Use frontier models (opus) in constrained or survival mode
- Use LLM reasoning for candidate selection in degraded modes
- Assume model registry will have preferred classes available

## Known Failure Modes

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| Degraded routing falls back to full pool | No models of restricted class available in registry | Ensure model registry includes sonnet/haiku; verify class definitions in `model-registry.ts` |
| `constrained` mode fires even though one frontier model is healthy | Operating mode derived from a single-model check instead of aggregating all frontier IDs | Ensure `deriveOperatingMode()` iterates the full frontier set from the effective registry and treats snapshot-absent frontier models as `healthy` |
| A non-frontier model is selected while a healthy frontier sibling is available | Frontier-sibling substitution was skipped, or `below-frontier-substitute` exclusions were not applied | Verify `findHealthyFrontierSibling()` can see the current quota snapshot and `resolveModel()` is excluding non-frontier candidates in the mixed-frontier path |
| No policy-adjustment line appears for a frontier-to-frontier swap | The route never passed through `logPolicyAdjustment()` or `logFinalFrontierSubstitution()` for that path | Confirm routing stayed out of degraded mode and note that `routingMode === 'policy'` intentionally skips the final frontier-substitution log |
| `heuristic-fallback, neighbors=0` appears in degraded mode despite populated `evals.jsonl` | The degraded `modelsAvailable` allowlist filters every k-nearest neighbor before stage selection, so `routeStageAware()` returns `null` and the caller reports zero neighbors | Retry `rankModelsPerStage()` without model constraints when filtering caused the null, return `stage-aware-partial`, and let the caller overlay degraded model selection while preserving the real neighbor count |

## Testing Patterns

`shared/lib/workflow-router.test.ts` includes:
- Test helpers (`writeQuotaState`) for injecting quota state into repos
- Survival mode test verifying haiku-only routing and no opus/sonnet usage
- Constrained mode test verifying opus exclusion but sonnet/haiku availability
- Normal mode test verifying no degraded rationale is prepended

## Dependencies

- `operating-mode.ts` — for `getCurrentOperatingMode()` to detect quota state
- `model-registry.ts` — for model class definitions and effective registry resolution
- `stage-aware-router.ts` — for KNN-based routing fallback

## Related Subsystems

- [Quota Tracking](quota-tracking.md) — quota state derivation, thresholds, and the persisted snapshot consumed by operating-mode and substitution logic
- `shared/lib/model-registry.ts` — model class definitions and effective registry resolution used to identify frontier models
- `shared/lib/stage-aware-router.ts` — KNN-based routing used by degraded modes after aggregate frontier exhaustion/degradation is confirmed

## Recent Changes

### 2026-04-19T16:30:00.000Z - HOK-1370: Router docs refreshed for multi-frontier semantics
**Changed:** Updated the router subsystem spec to document aggregate-across-frontier operating modes, explicit mixed-frontier decision-table behavior, normal-mode frontier sibling substitution, and the `below-frontier-substitute` / transparency-log invariants.
**Impact:** Future routing work can distinguish true degraded-mode entry from healthy frontier substitution and avoids reintroducing single-model triggers for `constrained` mode.

### 2026-04-19T16:00:00.000Z - HOK-1369: Cross-frontier substitution transparency
**Changed:** Normal-mode routing now emits per-role policy-adjustment lines when a healthy frontier sibling is chosen because the top frontier is `degrading` or `exhausted`, for example `[coder] policy adjustment: claude-opus-4-7 -> gpt-5.4 (quota=exhausted, same-class=frontier)`.
**Impact:** Operators can distinguish healthy cross-frontier rerouting from true class downgrades, while constrained and survival banners remain reserved for aggregated degraded modes only.

### 2026-04-19T15:13:53.493Z - HOK-1341: Degraded-mode behavior for the `route` command
**Changed:** `routeWorkflowAuto()` now detects operating mode and delegates to `routeWorkflowDegraded()` when constrained or survival. Degraded routing restricts model pool (sonnet/haiku in constrained, haiku-only in survival), skips LLM difficulty classification, and prepends mode-aware rationale to reasoning field.
**Impact:** Auto-mode routing now makes quota-aware decisions automatically. Commands using auto routing gracefully fall back to smaller models under quota pressure without user intervention.
