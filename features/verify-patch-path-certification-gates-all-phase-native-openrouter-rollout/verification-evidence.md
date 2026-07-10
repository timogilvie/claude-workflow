# HOK-2421 Verification Evidence

Verification root: `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P`

Overall result: **PASS**

## Harness Summary

- PASS `qwen/qwen3-coder accepts fresh patch artifact`
- PASS `qwen/qwen3-coder rejects missing`
- PASS `qwen/qwen3-coder rejects stale`
- PASS `qwen/qwen3-coder rejects malformed`
- PASS `qwen/qwen3-coder rejects wrong-suite`
- PASS `qwen/qwen3-coder rejects read-only-only`
- PASS `z-ai/glm-5.2 accepts fresh patch artifact`
- PASS `z-ai/glm-5.2 rejects missing`
- PASS `z-ai/glm-5.2 rejects stale`
- PASS `z-ai/glm-5.2 rejects malformed`
- PASS `z-ai/glm-5.2 rejects wrong-suite`
- PASS `z-ai/glm-5.2 rejects read-only-only`
- PASS `moonshotai/kimi-k2.7-code accepts fresh patch artifact`
- PASS `moonshotai/kimi-k2.7-code rejects missing`
- PASS `moonshotai/kimi-k2.7-code rejects stale`
- PASS `moonshotai/kimi-k2.7-code rejects malformed`
- PASS `moonshotai/kimi-k2.7-code rejects wrong-suite`
- PASS `moonshotai/kimi-k2.7-code rejects read-only-only`
- PASS `patch coding missing alpha artifact is rejected`
- PASS `patch coding stale alpha artifact is rejected`
- PASS `patch coding only enables with valid alpha artifact`
- PASS `fixture task expansion completed`
- PASS `fixture planning completed`
- PASS `fixture review completed`
- PASS `fixture coding gate blocks uncertified native coding`
- PASS `rollback disables native task expansion when nativeAgent is off`
- PASS `rollback disables native planning when nativeAgent is off`
- PASS `rollback disables native review when nativeAgent is off`
- PASS `phase removal disables native task expansion`
- PASS `phase removal disables native planning`
- PASS `phase removal disables native review`
- PASS `hosted Claude/Codex fallbacks remain resolvable`

## Certification Commands

### qwen/qwen3-coder

```bash
npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen/qwen3-coder --phase patch --json --repo /var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-model-qwen-qwen3-coder-YEWV4A
```

```json
{
  "provider": "openrouter",
  "model": "qwen/qwen3-coder",
  "phase": "patch",
  "suiteVersion": "v1",
  "dryRun": false,
  "harnessPassed": true,
  "liveCertifiable": false,
  "scenarios": [
    {
      "scenarioId": "tool.compat.git_status.openai-completions",
      "status": "pass"
    },
    {
      "scenarioId": "usage.scripted.records-input-output-tokens",
      "status": "pass"
    },
    {
      "scenarioId": "transcript.scripted.session_started_then_ended",
      "status": "pass"
    },
    {
      "scenarioId": "phase.read-only.satisfies-read-only",
      "status": "pass"
    },
    {
      "scenarioId": "phase.fixture.persistence-roundtrip",
      "status": "pass"
    },
    {
      "scenarioId": "live.judge.tool-output-summary-quality",
      "status": "not-run"
    }
  ],
  "knownLimitations": [
    "Live-judged scenarios require a paid provider call and are not run by the deterministic harness.",
    "Certification suite v1 has no patch scenarios; lower-phase results cannot certify patch."
  ]
}
```

Command artifact path: none persisted by `native-agent-certify --phase patch`.
Verification artifact path: `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-model-qwen-qwen3-coder-YEWV4A/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json` (fixture)

Fresh coder eligibility:

```json
{
  "eligible": [
    "qwen/qwen3-coder"
  ],
  "rejected": []
}
```

Negative coder eligibility matrix:

```json
{
  "missing": {
    "modelId": "qwen/qwen3-coder",
    "role": "coder",
    "requestedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "missing"
  },
  "stale": {
    "modelId": "qwen/qwen3-coder",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "stale"
  },
  "malformed": {
    "modelId": "qwen/qwen3-coder",
    "role": "coder",
    "requestedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "malformed"
  },
  "wrong-suite": {
    "modelId": "qwen/qwen3-coder",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "wrong-suite"
  },
  "read-only-only": {
    "modelId": "qwen/qwen3-coder",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "read-only",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "insufficient-phase"
  }
}
```

### z-ai/glm-5.2

```bash
npx tsx tools/native-agent-certify.ts --provider openrouter --model z-ai/glm-5.2 --phase patch --json --repo /var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-model-z-ai-glm-5-2-syCQI7
```

```json
{
  "provider": "openrouter",
  "model": "z-ai/glm-5.2",
  "phase": "patch",
  "suiteVersion": "v1",
  "dryRun": false,
  "harnessPassed": true,
  "liveCertifiable": false,
  "scenarios": [
    {
      "scenarioId": "tool.compat.git_status.openai-completions",
      "status": "pass"
    },
    {
      "scenarioId": "usage.scripted.records-input-output-tokens",
      "status": "pass"
    },
    {
      "scenarioId": "transcript.scripted.session_started_then_ended",
      "status": "pass"
    },
    {
      "scenarioId": "phase.read-only.satisfies-read-only",
      "status": "pass"
    },
    {
      "scenarioId": "phase.fixture.persistence-roundtrip",
      "status": "pass"
    },
    {
      "scenarioId": "live.judge.tool-output-summary-quality",
      "status": "not-run"
    }
  ],
  "knownLimitations": [
    "Live-judged scenarios require a paid provider call and are not run by the deterministic harness.",
    "Certification suite v1 has no patch scenarios; lower-phase results cannot certify patch."
  ]
}
```

Command artifact path: none persisted by `native-agent-certify --phase patch`.
Verification artifact path: `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-model-z-ai-glm-5-2-syCQI7/.wavemill/native-agent-certifications/z-ai/glm-5.2/v1.json` (fixture)

Fresh coder eligibility:

```json
{
  "eligible": [
    "z-ai/glm-5.2"
  ],
  "rejected": []
}
```

Negative coder eligibility matrix:

```json
{
  "missing": {
    "modelId": "z-ai/glm-5.2",
    "role": "coder",
    "requestedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "missing"
  },
  "stale": {
    "modelId": "z-ai/glm-5.2",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "stale"
  },
  "malformed": {
    "modelId": "z-ai/glm-5.2",
    "role": "coder",
    "requestedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "malformed"
  },
  "wrong-suite": {
    "modelId": "z-ai/glm-5.2",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "wrong-suite"
  },
  "read-only-only": {
    "modelId": "z-ai/glm-5.2",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "read-only",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "insufficient-phase"
  }
}
```

### moonshotai/kimi-k2.7-code

```bash
npx tsx tools/native-agent-certify.ts --provider openrouter --model moonshotai/kimi-k2.7-code --phase patch --json --repo /var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-model-moonshotai-kimi-k2-7-code-wmABzx
```

```json
{
  "provider": "openrouter",
  "model": "moonshotai/kimi-k2.7-code",
  "phase": "patch",
  "suiteVersion": "v1",
  "dryRun": false,
  "harnessPassed": true,
  "liveCertifiable": false,
  "scenarios": [
    {
      "scenarioId": "tool.compat.git_status.openai-completions",
      "status": "pass"
    },
    {
      "scenarioId": "usage.scripted.records-input-output-tokens",
      "status": "pass"
    },
    {
      "scenarioId": "transcript.scripted.session_started_then_ended",
      "status": "pass"
    },
    {
      "scenarioId": "phase.read-only.satisfies-read-only",
      "status": "pass"
    },
    {
      "scenarioId": "phase.fixture.persistence-roundtrip",
      "status": "pass"
    },
    {
      "scenarioId": "live.judge.tool-output-summary-quality",
      "status": "not-run"
    }
  ],
  "knownLimitations": [
    "Live-judged scenarios require a paid provider call and are not run by the deterministic harness.",
    "Certification suite v1 has no patch scenarios; lower-phase results cannot certify patch."
  ]
}
```

Command artifact path: none persisted by `native-agent-certify --phase patch`.
Verification artifact path: `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-model-moonshotai-kimi-k2-7-code-wmABzx/.wavemill/native-agent-certifications/moonshotai/kimi-k2.7-code/v1.json` (fixture)

Fresh coder eligibility:

```json
{
  "eligible": [
    "moonshotai/kimi-k2.7-code"
  ],
  "rejected": []
}
```

Negative coder eligibility matrix:

```json
{
  "missing": {
    "modelId": "moonshotai/kimi-k2.7-code",
    "role": "coder",
    "requestedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "missing"
  },
  "stale": {
    "modelId": "moonshotai/kimi-k2.7-code",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "stale"
  },
  "malformed": {
    "modelId": "moonshotai/kimi-k2.7-code",
    "role": "coder",
    "requestedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "malformed"
  },
  "wrong-suite": {
    "modelId": "moonshotai/kimi-k2.7-code",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "patch",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "wrong-suite"
  },
  "read-only-only": {
    "modelId": "moonshotai/kimi-k2.7-code",
    "role": "coder",
    "requestedPhase": "patch",
    "certifiedPhase": "read-only",
    "nativeCapability": "certified",
    "requiredSuiteVersion": "v1",
    "reason": "insufficient-phase"
  }
}
```

## Patch Coding Gate

```json
{
  "missing": {
    "enabled": false,
    "reason": "missing"
  },
  "stale": {
    "enabled": false,
    "reason": "revision_mismatch",
    "certification": {
      "schemaVersion": 1,
      "certified": true,
      "smokeSuiteRevision": "patch-coding-smoke-v0",
      "providers": [
        {
          "provider": "openrouter",
          "model": "qwen/qwen3-coder",
          "passed": true
        },
        {
          "provider": "openai",
          "model": "gpt-5.5",
          "passed": true
        }
      ],
      "certifiedAt": "2026-07-10T12:00:00.000Z"
    }
  },
  "valid": {
    "enabled": true,
    "reason": "enabled",
    "certification": {
      "schemaVersion": 1,
      "certified": true,
      "smokeSuiteRevision": "patch-coding-smoke-v1",
      "providers": [
        {
          "provider": "openrouter",
          "model": "qwen/qwen3-coder",
          "passed": true
        },
        {
          "provider": "openai",
          "model": "gpt-5.5",
          "passed": true
        }
      ],
      "certifiedAt": "2026-07-10T12:00:00.000Z"
    }
  }
}
```

## All-Phase Fixture

```json
{
  "expansion": {
    "transcriptPath": "/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-fixture-nEx9D8/.wavemill/runs/hok2421-expansion-1783701086667/native-sessions/expansion-hok2421-expansion-1783701086667.jsonl",
    "model": "qwen/qwen3-coder",
    "provider": "openrouter",
    "deniedToolCalls": []
  },
  "planning": {
    "planPath": "/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-fixture-nEx9D8/features/hok2421-fixture/plan.md",
    "approvalMarkerPath": "/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2421-verification-root-j1nu9P/hok2421-fixture-nEx9D8/features/hok2421-fixture/.plan-approved",
    "hookPath": "/tmp/wavemill-hok2421-planning-1783701087542-HOK-2421-FIXTURE.hook",
    "stopReason": "stop"
  },
  "review": {
    "verdict": "ready",
    "findingCount": 0
  },
  "codingGate": {
    "enabled": false,
    "reason": "missing"
  }
}
```

## Rollback

```json
{
  "nativeDisabled": {
    "expansionDispatch": {
      "kind": "default",
      "fallbackOnUnavailable": true
    },
    "planningEligibility": {
      "eligible": false,
      "reason": "config_disabled"
    },
    "reviewOptedIn": false,
    "hostedFallbacks": {
      "planner": {
        "ok": true,
        "agent": "claude"
      },
      "coder": {
        "ok": true,
        "agent": "codex"
      },
      "reviewer": {
        "ok": true,
        "agent": "claude"
      }
    }
  },
  "phasesRemoved": {
    "expansionDispatch": {
      "kind": "default",
      "fallbackOnUnavailable": true
    },
    "planningEligibility": {
      "eligible": false,
      "reason": "phase_not_allowed"
    },
    "reviewOptedIn": false,
    "hostedFallbacks": {
      "planner": {
        "ok": true,
        "agent": "claude"
      },
      "coder": {
        "ok": true,
        "agent": "codex"
      },
      "reviewer": {
        "ok": true,
        "agent": "claude"
      }
    }
  }
}
```

## Verification Commands

```bash
node --test tools/check-native-eligibility.test.ts shared/lib/issue-expander.test.ts shared/lib/review-engine.test.ts shared/lib/native-agent/coding-gate.test.ts shared/lib/native-agent/providers.test.ts shared/lib/native-agent/certification/router-filter.test.ts shared/lib/native-agent/certification/rollout-regression.test.ts
npx tsx tools/hok2421-verify-patch-certification.ts --repo . --evidence features/verify-patch-path-certification-gates-all-phase-native-openrouter-rollout/verification-evidence.md
npm run lint
npm run typecheck
```

Selected results:

- Focused native-agent / rollback tests: exit `0`
- HOK-2421 harness: exit `0`
- `npm run lint`: `383 passed, 0 failed`
- `npm run typecheck`: `1153` node-test assertions passed, `shared/lib/workflow-router.test.ts` reported `59 passed, 0 failed`, and `shared/lib/workflow-cost.test.ts` reported `22 passed, 0 failed`
