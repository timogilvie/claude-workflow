# Eval Success Policy

Release note for HOK-1498: Wavemill now uses a single canonical eval success policy across routing labels and Hokusai submissions.

## Threshold

- Default success threshold: `score >= 0.8`
- Rationale: HOK-1264 is the binding spec, and keeping the stricter threshold avoids over-labeling borderline runs as successful.

## Precedence

1. `outcomes.success === true` means success.
2. `outcomes.success === false` means failure.
3. Otherwise, if `score` is present, success is `score >= threshold`.
4. Otherwise, the record is treated as unsuccessful.

## Configuration

Override the default with `.wavemill-config.json`:

```json
{
  "eval": {
    "successThreshold": 0.8
  }
}
```

## Affected Flows

- Hokusai submission export
- Local eval success labels used by routing
- Wavemill router benchmark completion-success scoring

References: HOK-1264, HOK-1498.
