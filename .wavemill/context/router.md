# Router

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

This milestone only surfaces and documents operating mode. Individual command behavior does not yet change based on mode; that wiring is deferred to the next milestone.
