# HOK-2419 Verification Evidence

Run mode: deterministic harness.

Reason: the certification artifacts were generated from the deterministic workflow suite. The live-judge scenario is retained as a `knownLimitation` and is not persisted into the artifact gate, so deterministic workflow artifacts still remain eligible for router/report checks.

No secrets were printed or persisted.

## Verification Commands

### Certification commands

```bash
npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen/qwen3-coder --phase workflow --json
npx tsx tools/native-agent-certify.ts --provider openrouter --model z-ai/glm-5.2 --phase workflow --json
npx tsx tools/native-agent-certify.ts --provider openrouter --model moonshotai/kimi-k2.7-code --phase workflow --json
```

Selected output:

```json
{
  "provider": "openrouter",
  "model": "qwen/qwen3-coder",
  "phase": "workflow",
  "suiteVersion": "v1",
  "dryRun": false,
  "harnessPassed": true,
  "liveCertifiable": true,
  "artifactPath": ".wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json"
}
{
  "provider": "openrouter",
  "model": "z-ai/glm-5.2",
  "phase": "workflow",
  "suiteVersion": "v1",
  "dryRun": false,
  "harnessPassed": true,
  "liveCertifiable": true,
  "artifactPath": ".wavemill/native-agent-certifications/z-ai/glm-5.2/v1.json"
}
{
  "provider": "openrouter",
  "model": "moonshotai/kimi-k2.7-code",
  "phase": "workflow",
  "suiteVersion": "v1",
  "dryRun": false,
  "harnessPassed": true,
  "liveCertifiable": true,
  "artifactPath": ".wavemill/native-agent-certifications/moonshotai/kimi-k2.7-code/v1.json"
}
```

### Artifact inventory

```bash
find .wavemill/native-agent-certifications -type f -name '*.json' | sort
```

Output:

```text
.wavemill/native-agent-certifications/moonshotai/kimi-k2.7-code/v1.json
.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json
.wavemill/native-agent-certifications/z-ai/glm-5.2/v1.json
```

### Models report

```bash
npx tsx tools/native-agent-models-report.ts --json
```

Selected output:

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

Report note:

- `qwen-3-coder` is the Wavemill alias for the requested OpenRouter ID `qwen/qwen3-coder`.
- `glm-5.2` is the Wavemill alias for `z-ai/glm-5.2`.
- `kimi-k2.7-code` matches the requested upstream model segment from `moonshotai/kimi-k2.7-code`.

## Artifact Summaries

| Path | Provider | Model | Phase | Suite | Certified At | Scenarios | Passed | Failed |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |
| `.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json` | `qwen` | `qwen3-coder` | `workflow` | `v1` | `2026-07-05T15:31:57.711Z` | 6 | 6 | 0 |
| `.wavemill/native-agent-certifications/z-ai/glm-5.2/v1.json` | `z-ai` | `glm-5.2` | `workflow` | `v1` | `2026-07-05T15:31:57.527Z` | 6 | 6 | 0 |
| `.wavemill/native-agent-certifications/moonshotai/kimi-k2.7-code/v1.json` | `moonshotai` | `kimi-k2.7-code` | `workflow` | `v1` | `2026-07-05T15:31:57.748Z` | 6 | 6 | 0 |

## Router / Planning Eligibility Diagnostics

Fresh workflow artifact accepts both planner and reviewer:

```json
{
  "freshPlanner": {
    "eligible": ["fresh"],
    "rejected": []
  },
  "freshReviewer": {
    "eligible": ["fresh"],
    "rejected": []
  }
}
```

Fail-closed rejection diagnostics:

```json
{
  "missing": {
    "modelId": "missing",
    "role": "planner",
    "requestedPhase": "workflow",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "missing"
  },
  "stale": {
    "modelId": "stale",
    "role": "planner",
    "requestedPhase": "workflow",
    "certifiedPhase": "workflow",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "stale"
  },
  "malformed": {
    "modelId": "malformed",
    "role": "planner",
    "requestedPhase": "workflow",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "malformed"
  },
  "wrongSuite": {
    "modelId": "wrongSuite",
    "role": "planner",
    "requestedPhase": "workflow",
    "certifiedPhase": "workflow",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "wrong-suite"
  },
  "insufficientPlanner": {
    "modelId": "insufficient",
    "role": "planner",
    "requestedPhase": "workflow",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "insufficient-phase"
  },
  "insufficientReviewer": {
    "eligible": ["insufficient"],
    "rejected": []
  }
}
```

This confirms:

- planner accepts fresh workflow artifacts
- planner rejects missing, stale, malformed, wrong-suite, and insufficient-phase artifacts
- reviewer remains eligible when the artifact still satisfies lower read-only requirements

## Automated Verification

Commands run successfully:

```bash
node --test shared/lib/openrouter-catalog.test.ts shared/lib/model-registry.test.ts shared/lib/native-agent/certification/schema.test.ts shared/lib/native-agent/certification/router-filter.test.ts shared/lib/native-agent/certification/report.test.ts shared/lib/native-agent/certification/rollout-regression.test.ts tools/native-agent-certify.test.ts
node --test shared/lib/native-agent/certification/scenarios.test.ts shared/lib/native-agent/certification/scenario-runner.test.ts tools/native-agent-certify.test.ts shared/lib/native-agent/certification/rollout-regression.test.ts
npx tsx shared/lib/workflow-router.test.ts
npm run typecheck
```

Results:

- targeted certification/router/report/tool tests: passed
- `shared/lib/workflow-router.test.ts`: `58 passed, 0 failed`
- `npm run typecheck`: exit `0`
