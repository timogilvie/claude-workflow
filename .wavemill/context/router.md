# Router

**Last updated:** 2026-04-19T15:13:53.493Z
**Files touched:** 2 files in last 30 days

## Purpose

The router now has a single operating-mode view derived from quota health so commands can read one system-wide signal instead of inspecting each model individually.

## Operating Modes

| Mode | Meaning |
|------|---------|
| `normal` | All tracked premium models are healthy, or no premium models are tracked in the current snapshot. |
| `constrained` | At least one premium model is degrading and no premium model is exhausted. |
| `survival` | At least one premium model is exhausted. |

Premium models are defined by `PREMIUM_MODEL_CLASS = 'frontier'`.

## Derivation Rule

The operating mode is derived from `readQuotaSnapshot()` plus the effective model registry:

1. Resolve premium model IDs from `getEffectiveRegistry()` where `capabilities.class === PREMIUM_MODEL_CLASS`.
2. Inspect only those premium models present in the quota snapshot.
3. Apply the status thresholds in priority order:
   - `SURVIVAL_TRIGGER_STATUS = 'exhausted'`
   - `CONSTRAINED_TRIGGER_STATUS = 'degrading'`
   - Otherwise `normal`

Decision table:

| Premium model statuses in snapshot | Result |
|-----------------------------------|--------|
| any `exhausted` | `survival` |
| none exhausted, any `degrading` | `constrained` |
| otherwise | `normal` |

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

See [Quota Tracking](/Users/timothyogilvie/Dropbox/wavemill/worktrees/proactive-quota-degradation-before-hard-stop/.wavemill/context/quota-tracking.md) for full signal definitions, thresholds, and CLI override flow.

## Degraded-Mode Routing

When the operating mode is `constrained` or `survival`, `routeWorkflowAuto()` automatically invokes degraded-mode routing:

- **Constrained**: Model pool restricted to `strong_generalist` and `fast_economy` classes. LLM-based difficulty classification is skipped.
- **Survival**: Model pool restricted to `fast_economy` class (haiku-only). LLM-based difficulty classification is skipped.

Both modes use stage-aware KNN signals for candidate selection and prepend a degraded-mode rationale to the routing decision's reasoning field. If no models of the appropriate class are available, routing falls back to the full pool with a warning.

`routeWorkflowDegraded()` is the explicit API for degraded-mode routing; `routeWorkflowAuto()` uses it automatically based on current operating mode.

## Architectural Constraints

### DO
- Always prepend degraded-mode rationale to routing decisions when constrained or survival
- Respect `modelsAvailable` option in routing functions to allow test injection
- Skip LLM-based difficulty classification in constrained and survival modes
- Fall back to full model pool if no degraded candidates exist (with warning)

### DON'T
- Use frontier models (opus) in constrained or survival mode
- Use LLM reasoning for candidate selection in degraded modes
- Assume model registry will have preferred classes available

## Known Failure Modes

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| Degraded routing falls back to full pool | No models of restricted class available in registry | Ensure model registry includes sonnet/haiku; verify class definitions in `model-registry.ts` |

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

- [Quota Tracking](quota-tracking.md) — quota state derivation and thresholds
- [Model Registry](model-registry.md) — model class definitions and capability registry
- [Stage-Aware Router](stage-aware-router.md) — KNN-based routing for degraded modes

## Recent Changes

### 2026-04-19T15:13:53.493Z - HOK-1341: Degraded-mode behavior for the `route` command
**Changed:** `routeWorkflowAuto()` now detects operating mode and delegates to `routeWorkflowDegraded()` when constrained or survival. Degraded routing restricts model pool (sonnet/haiku in constrained, haiku-only in survival), skips LLM difficulty classification, and prepends mode-aware rationale to reasoning field.
**Impact:** Auto-mode routing now makes quota-aware decisions automatically. Commands using auto routing gracefully fall back to smaller models under quota pressure without user intervention.