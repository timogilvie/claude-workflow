# HOK-2425 Verification Evidence

Generated: 2026-07-11T15:42:47.170Z
Git SHA: 9aa2583e0c77ba6483eb9a09f3d5bf096107de75
Node: v22.22.2
Representative model: `qwen/qwen3-coder`
OPENROUTER_API_KEY present: no
Evidence artifact: `features/verification-companion-for-native-workflow-certification-coverage/verification-evidence.md`

## Dry-Run Workflow Certification

Command:

```bash
npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen/qwen3-coder --phase workflow --dry-run --json
```
Captured stdout:

```json
{
  "provider": "openrouter",
  "model": "qwen/qwen3-coder",
  "phase": "workflow",
  "suiteVersion": "v1",
  "dryRun": true,
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
      "scenarioId": "phase.workflow.artifact-unlocks-planner",
      "status": "pass"
    },
    {
      "scenarioId": "live.judge.tool-output-summary-quality",
      "status": "not-run"
    },
    {
      "scenarioId": "workflow.tools.contract-shape-stable",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.tools.mutation-policy-allows-in-phase",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.tools.mutation-policy-denies-out-of-phase",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.transcript.approval-lifecycle-jsonl-shape",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.provenance.untrusted-input-detects-phase-override",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.usage.multi-turn-token-accounting",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.cleanup.tracker-roundtrip-and-summary-event",
      "status": "pass"
    },
    {
      "scenarioId": "workflow.phase.workflow-persistence-roundtrip",
      "status": "pass"
    }
  ],
  "knownLimitations": [
    "Live-judged scenarios require a paid provider call and are not run by the deterministic harness."
  ]
}
```
Captured stderr:

```text
(no stderr)
```

## Live Workflow Certification

Deferred: OPENROUTER_API_KEY is not set in this environment.

## Current Checked-In Workflow Artifact Inventory

Current workflow scenario IDs (9): `phase.workflow.artifact-unlocks-planner`, `workflow.cleanup.tracker-roundtrip-and-summary-event`, `workflow.phase.workflow-persistence-roundtrip`, `workflow.provenance.untrusted-input-detects-phase-override`, `workflow.tools.contract-shape-stable`, `workflow.tools.mutation-policy-allows-in-phase`, `workflow.tools.mutation-policy-denies-out-of-phase`, `workflow.transcript.approval-lifecycle-jsonl-shape`, `workflow.usage.multi-turn-token-accounting`

| Path | Phase | Suite | Total Records | Workflow Records | Passing Workflow Records | Notes |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json` | `workflow` | `v1` | 6 | 1 | 1 | missing 8 workflow IDs |
| `.wavemill/native-agent-certifications/z-ai/glm-5.2/v1.json` | `workflow` | `v1` | 6 | 1 | 1 | missing 8 workflow IDs |
| `.wavemill/native-agent-certifications/moonshotai/kimi-k2.7-code/v1.json` | `workflow` | `v1` | 6 | 1 | 1 | missing 8 workflow IDs |

## Fail-Closed Planner Selection

| Case | Planner Selection | Observed Reason |
| --- | --- | --- |
| missing | `` | `missing` |
| stale | `` | `stale` |
| wrong-suite | `` | `wrong-suite` |
| malformed | `` | `malformed` |
| insufficient-phase | `` | `insufficient-phase` |

## Read-Only Certification Behavior

Reviewer eligibility: eligible=`native-read-only-check` rejected=(none)
Planner eligibility from the same read-only artifact: eligible=(none) rejected=`insufficient-phase`

## Unregistered OpenRouter Catalog Model

Model: `mistral-large-2`
Planner selection: ``
Observed reason: `no-native-capability`

## Acceptance Criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Dry-run workflow certification executed for a configured native OpenRouter model | PASS | `qwen/qwen3-coder` via `npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen/qwen3-coder --phase workflow --dry-run --json` exited 0. |
| Live workflow certification executed or explicitly deferred | DEFERRED | OPENROUTER_API_KEY is not set in this environment. |
| Live artifact has workflow phase, v1 suite, and passing workflow records when executed | DEFERRED | Deferred with no live artifact written in this run. |
| Planner/workflow selection fails closed for missing, stale, wrong-suite, malformed, and insufficient-phase artifacts | PASS | missing=>missing, stale=>stale, wrong-suite=>wrong-suite, malformed=>malformed, insufficient-phase=>insufficient-phase |
| Read-only certification still admits read-only routing but not workflow routing | PASS | reviewer eligible=`native-read-only-check`; planner rejection=insufficient-phase. |
| Workflow certification does not automatically admit unregistered OpenRouter catalog models | PASS | `mistral-large-2` rejected with `no-native-capability`. |
| Current checked-in workflow artifacts were evaluated against the current workflow suite | PASS | Existing checked-in workflow artifacts do not cover the full current workflow scenario set and were treated as stale verification evidence. |
