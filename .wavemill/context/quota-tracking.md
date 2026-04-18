# Quota Tracking

## Purpose

Quota tracking provides a persistent, model-level health view (`healthy`, `degrading`, `exhausted`) that can degrade **before** first hard 429 failures. This lets routing reserve premium capacity for hard and critical work during load spikes.

## State Model

State is stored in `.wavemill/quota-state.json` (repo-scoped).

Each model entry tracks:
- Reactive limit signals: `lastLimitErrorAt`, `consecutiveLimitErrors`, `remainingEstimate`, `resetAt`
- Proactive load signals: `requestHistory` (rolling), `consecutiveNearLimitSignals`, `lastNearLimitAt`, `budgetSignal`
- Outcome context: `lastSuccessAt`, `lastReason`, `confidence`, `status`

Backward compatibility is additive: missing fields are normalized with defaults on read.

## Proactive Heuristics

A model transitions to `degrading` when any proactive rule triggers:

1. Rolling volume threshold
- Window: last 5 minutes
- Buffer: last 100 request timestamps
- Trigger: requests in window >= `volumeThresholdPercent` of baseline window capacity (default 70% of 100)

2. Partial remaining-budget warning
- Trigger: `remainingEstimate / budgetSignal.limit <= 20%`
- Used when provider responses expose a near-limit estimate before hard-stop

3. Repeated near-limit warnings
- Trigger: `consecutiveNearLimitSignals >= nearLimitCount` within healthy decay window
- Default `nearLimitCount`: 3

4. Provider budget signal
- Trigger: `budgetSignal.remaining / budgetSignal.limit <= budgetThresholdPercent`
- Default `budgetThresholdPercent`: 25

## API Surface

`shared/lib/quota-state.ts` exports:
- `recordLimitError(input)` for reactive 429s / quota errors
- `recordSuccess(input)` for successful requests after error periods
- `recordRequest(input)` for rolling usage tracking with optional `budgetSignal`
- `recordNearLimit(input)` for pre-429 warning signals
- `estimateQuotaHealth(modelId)` returning `healthy | approaching_degradation | degrading`
- `readQuotaSnapshot()` for projected status view with override application

## Manual Overrides

Manual overrides are configured in `.wavemill-config.json`:

```json
{
  "quota": {
    "manualOverrides": {
      "claude-sonnet-4-6": {
        "status": "degrading",
        "reason": "known provider peak window",
        "expiresAt": "2026-04-18T23:59:59Z"
      }
    },
    "thresholds": {
      "volumeThresholdPercent": 70,
      "budgetThresholdPercent": 25,
      "nearLimitCount": 3
    }
  }
}
```

Semantics:
- Overrides apply at snapshot read time after projection
- Expired overrides are ignored automatically
- Overrides can target models even without persisted quota state yet

## CLI

Use `wavemill quota`:

```bash
wavemill quota status
wavemill quota set sonnet degrading --reason "known peak window"
wavemill quota set claude-sonnet-4-6 degrading --expires 2026-04-19T02:00:00Z
wavemill quota clear sonnet
wavemill quota estimate claude-sonnet-4-6
```

`set` writes manual overrides to `.wavemill-config.json`.

## Testing Patterns

Recommended test scenarios:
- Simulate high load with repeated `recordRequest()` calls and assert degrade before any `recordLimitError()`
- Assert near-limit accumulation via `recordNearLimit()` and reset behavior after `recordSuccess()`
- Validate budget-signal-triggered degradation with low remaining percentages
- Validate manual override precedence and expiration behavior
- Validate operating-mode transition to `constrained` when premium model(s) become proactively degrading

## Integration Points

When provider wiring is added, request pipeline should:
- Call `recordRequest()` on successful responses (attach provider budget signal when available)
- Call `recordNearLimit()` on warning headers or soft limit responses
- Call `recordLimitError()` on hard 429/quota failures
- Optionally call `recordSuccess()` after recovery periods

