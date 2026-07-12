# HOK-2423_c Verification Evidence

Generated: 2026-07-12

## Production Notes

- Production fix required: yes.
- The certification report now fail-closes on missing, malformed, wrong-suite, and wrong-identity artifacts instead of falling back to registry metadata.
- Review, planning, and task-expansion now share one actionable native-provider failure message format with provider/model identity, rejection class, and remediation hints.

## Commands Run

### Scoped tests

```bash
node --test shared/lib/native-agent/providers.test.ts shared/lib/native-agent/certification/report.test.ts shared/lib/native-agent/review.test.ts shared/lib/native-agent/launch-planning.test.ts shared/lib/native-expansion.test.ts tools/hok2423-verify-native-provider-gate.test.ts
```

```text
1..11
# tests 66
# suites 11
# pass 66
# fail 0
# duration_ms 8061.024417
```

### Verifier tool

```bash
npx tsx tools/hok2423-verify-native-provider-gate.ts --json
```

```json
{
  "passed": true,
  "cases": [
    {
      "caseId": "openai-workflow-ready",
      "reportState": "ready",
      "reportEligibleStages": ["reviewer", "coder", "planner"],
      "certificationModeStatus": "ready"
    },
    {
      "caseId": "openrouter-patch-ready",
      "reportState": "ready",
      "reportEligibleStages": ["reviewer", "coder"],
      "certificationModeStatus": "ready"
    },
    {
      "caseId": "missing-artifact",
      "reportState": "uncertified",
      "certificationModeStatus": "ready"
    },
    {
      "caseId": "stale-artifact",
      "reportState": "stale",
      "certificationModeStatus": "ready"
    },
    {
      "caseId": "wrong-suite-artifact",
      "reportState": "uncertified",
      "certificationModeStatus": "ready"
    },
    {
      "caseId": "wrong-identity-artifact",
      "reportState": "uncertified",
      "certificationModeStatus": "ready"
    }
  ]
}
```

### Report output on this repo

```bash
npx tsx tools/native-agent-models-report.ts --json --repo .
```

```json
{
  "models": [
    {
      "provider": "openrouter",
      "model": "glm-5.2",
      "state": "ready",
      "certifiedPhase": "workflow",
      "eligibleStages": ["reviewer", "coder", "planner"]
    },
    {
      "provider": "openrouter",
      "model": "kimi-k2",
      "state": "uncertified",
      "eligibleStages": []
    },
    {
      "provider": "openrouter",
      "model": "kimi-k2.7-code",
      "state": "ready",
      "certifiedPhase": "workflow",
      "eligibleStages": ["reviewer", "coder", "planner"]
    },
    {
      "provider": "openrouter",
      "model": "qwen-3-coder",
      "state": "ready",
      "certifiedPhase": "workflow",
      "eligibleStages": ["reviewer", "coder", "planner"]
    }
  ]
}
```

### Lint

```bash
npm run lint
```

```text
--- Results: 383 passed, 0 failed ---
```

### Typecheck / broad test script

```bash
npm run typecheck
```

```text
1..200
# tests 1189
# suites 231
# pass 1189
# fail 0
# duration_ms 37579.573542

--- Results: 60 passed, 0 failed ---
--- Results: 22 passed, 0 failed ---
```

## Manual Native OpenRouter Review Smoke

Environment note: `OPENROUTER_API_KEY` was not set in this shell, so the manual smoke exercised the real review entry point and confirmed the actionable failure path instead of a live provider round-trip.

```bash
node --import tsx --input-type=module -e "import { runNativeReview } from './shared/lib/native-agent/review.ts'; const result = await runNativeReview({ diff: 'diff --git a/example.ts b/example.ts', plan: 'Plan', taskPacket: 'Task packet', designContext: null, metadata: { branch: 'task/manual-openrouter-smoke', files: ['example.ts'], hasUiChanges: false } }, process.cwd(), {}); console.log(JSON.stringify({ verdict: result.verdict, finding: result.codeReviewFindings[0]?.description ?? null }, null, 2));"
```

```json
{
  "verdict": "not_ready",
  "finding": "Native review is unavailable: openrouter:qwen/qwen3-coder unavailable (OPENROUTER_API_KEY is not set); set OPENROUTER_API_KEY; openrouter:z-ai/glm-5.2 unavailable (OPENROUTER_API_KEY is not set); set OPENROUTER_API_KEY; openrouter:moonshotai/kimi-k2.7-code unavailable (OPENROUTER_API_KEY is not set); set OPENROUTER_API_KEY. Run wavemill native-agent models report --json to inspect current artifact eligibility."
}
```

This is an expected deferred result for the current environment and confirms the review launch path now surfaces an actionable remediation message instead of a generic failure.
