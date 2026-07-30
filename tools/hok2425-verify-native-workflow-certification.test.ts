import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildVerificationMarkdown,
  classifyLiveRunDeferral,
  getConfiguredNativeOpenRouterModels,
  pickRepresentativeModel,
  summarizeArtifactCoverage,
} from './hok2425-verify-native-workflow-certification.ts';
import type { NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';

describe('hok2425 native workflow verification helpers', () => {
  it('extracts configured native OpenRouter rollout models and prefers the representative rollout order', () => {
    const config = {
      nativeAgent: {
        providers: {
          openrouter: {
            models: [
              'moonshotai/kimi-k2.7-code',
              'qwen/qwen3-coder',
            ],
          },
        },
      },
    };

    assert.deepEqual(getConfiguredNativeOpenRouterModels(config), [
      'moonshotai/kimi-k2.7-code',
      'qwen/qwen3-coder',
    ]);
    assert.equal(pickRepresentativeModel(config), 'qwen/qwen3-coder');
  });

  it('summarizes missing and failing workflow scenario coverage', () => {
    const artifact: NativeCertificationArtifact = {
      schemaVersion: 2,
      provider: 'qwen',
      model: 'qwen3-coder',
      phase: 'workflow',
      suiteVersion: 'v1',
      certifiedAt: '2026-07-11T00:00:00.000Z',
      scenarios: [
        { scenarioId: 'workflow.tools.contract-shape-stable', passed: true },
        { scenarioId: 'workflow.phase.workflow-persistence-roundtrip', passed: false },
        { scenarioId: 'legacy.workflow.old-scenario', passed: true },
      ],
    };

    const summary = summarizeArtifactCoverage(artifact, '/repo/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json', [
      'workflow.phase.workflow-persistence-roundtrip',
      'workflow.tools.contract-shape-stable',
      'workflow.usage.multi-turn-token-accounting',
    ]);

    assert.equal(summary.workflowScenarioCount, 2);
    assert.equal(summary.passingWorkflowScenarioCount, 1);
    assert.deepEqual(summary.failingWorkflowScenarioIds, ['workflow.phase.workflow-persistence-roundtrip']);
    assert.deepEqual(summary.missingWorkflowScenarioIds, ['workflow.usage.multi-turn-token-accounting']);
  });

  it('classifies external live-run failures as deferrals', () => {
    const deferred = classifyLiveRunDeferral({
      command: 'npx tsx tools/native-agent-certify.ts --provider openrouter',
      exitCode: 1,
      stdout: '',
      stderr: 'Error: OpenRouter request failed: HTTP 503 Service Unavailable',
    });
    const notDeferred = classifyLiveRunDeferral({
      command: 'npx tsx tools/native-agent-certify.ts --provider openrouter',
      exitCode: 1,
      stdout: '',
      stderr: 'Error: invariant failed while building the artifact',
    });

    assert.match(deferred ?? '', /deferred/i);
    assert.equal(notDeferred, null);
  });

  it('renders markdown evidence with a live deferral and fail-closed matrix', () => {
    const summary: Parameters<typeof buildVerificationMarkdown>[0] = {
      issueId: 'HOK-2425',
      gitSha: 'abc123',
      generatedAt: '2026-07-11T12:00:00.000Z',
      nodeVersion: 'v24.0.0',
      openRouterApiKeyPresent: false,
      representativeModel: 'qwen/qwen3-coder',
      workflowScenarioIds: [
        'workflow.phase.workflow-persistence-roundtrip',
        'workflow.tools.contract-shape-stable',
      ],
      dryRun: {
        capture: {
          command: 'npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen/qwen3-coder --phase workflow --dry-run --json',
          exitCode: 0,
          stdout: '{\n  "harnessPassed": true\n}',
          stderr: '',
        },
        parsed: {
          provider: 'openrouter',
          model: 'qwen/qwen3-coder',
          phase: 'workflow',
          suiteVersion: 'v1',
          dryRun: true,
          harnessPassed: true,
          liveCertifiable: true,
        },
      },
      liveRun: {
        status: 'deferred',
        reason: 'OPENROUTER_API_KEY is not set in this environment.',
      },
      currentArtifacts: [
        {
          path: '/repo/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json',
          phase: 'workflow',
          suiteVersion: 'v1',
          scenarioCount: 6,
          passingScenarioCount: 6,
          workflowScenarioCount: 1,
          passingWorkflowScenarioCount: 1,
          failingWorkflowScenarioIds: [],
          missingWorkflowScenarioIds: ['workflow.phase.workflow-persistence-roundtrip'],
        },
      ],
      failClosedPlannerCases: [
        { caseId: 'missing', planner: '', reason: 'missing' },
        { caseId: 'stale', planner: '', reason: 'stale' },
        { caseId: 'wrong-suite', planner: '', reason: 'wrong-suite' },
        { caseId: 'malformed', planner: '', reason: 'malformed' },
        { caseId: 'insufficient-phase', planner: '', reason: 'insufficient-phase' },
      ],
      readOnlyBehavior: {
        reviewerEligible: ['native-read-only-check'],
        reviewerRejected: [],
        plannerEligible: [],
        plannerRejected: [{
          modelId: 'native-read-only-check',
          role: 'planner',
          requestedPhase: 'workflow',
          certifiedPhase: 'read-only',
          nativeCapability: 'certified',
          requiredSuiteVersion: 'v1',
          reason: 'insufficient-phase',
        }],
      },
      unregisteredOpenRouter: {
        modelId: 'legacy-mistral-openrouter',
        planner: '',
        reason: 'no-native-capability',
      },
      evidencePath: 'features/verification-companion-for-native-workflow-certification-coverage/verification-evidence.md',
    };

    const markdown = buildVerificationMarkdown(summary);

    assert.match(markdown, /Deferred: OPENROUTER_API_KEY is not set/);
    assert.match(markdown, /\| missing \| `` \| `missing` \|/);
    assert.match(markdown, /legacy-mistral-openrouter/);
    assert.match(markdown, /Existing checked-in workflow artifacts do not cover the full current workflow scenario set/);
  });
});
