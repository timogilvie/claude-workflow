import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildVerificationMarkdown,
  compareTaskPacketStructure,
  getArtifactFailures,
  getCertificationFailures,
  getFallbackFailures,
  runVerification,
  selectVerificationModels,
  type ExpansionRunSummary,
  type VerificationSummary,
} from './hok2424-verify-native-expansion.ts';

function makeExpansionSummary(overrides: Partial<ExpansionRunSummary> = {}): ExpansionRunSummary {
  return {
    modelId: 'qwen/qwen3-coder',
    provider: 'openrouter',
    api: 'hok2424-scripted',
    agent: 'native-openrouter',
    cost: 0,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    deniedToolCalls: [{ tool: 'patch_file', reason: 'phase_denied: planning disallows patch_file' }],
    taskPacketValid: true,
    validationPassed: true,
    validationIssueCount: 0,
    hasSplitMarker: true,
    gitStatusBefore: '',
    gitStatusAfter: '',
    rawPacket: '# packet',
    sidecar: {
      agent: 'native-openrouter',
      model: 'qwen/qwen3-coder',
      provider: 'openrouter',
      api: 'hok2424-scripted',
      transcriptPath: import.meta.filename,
      cost: 0,
      durationMs: 1,
      stopReason: 'stop',
      totalInputTokens: 10,
      totalOutputTokens: 20,
      deniedToolCalls: [{ tool: 'patch_file', reason: 'phase_denied: planning disallows patch_file' }],
    },
    manifestPhase: {
      totalPhaseRefs: 3,
      promptRefs: 1,
      runtimeRefs: 1,
      agentConfigRefs: 1,
      totalResources: 6,
    },
    artifacts: {
      repoDir: process.cwd(),
      taskPacket: import.meta.filename,
      header: import.meta.filename,
      details: import.meta.filename,
      sidecar: import.meta.filename,
      transcript: import.meta.filename,
      manifest: import.meta.filename,
    },
    ...overrides,
  };
}

describe('hok2424 native expansion verifier helpers', () => {
  it('selects the preferred rollout model by default and supports all-model mode', () => {
    const config = {
      nativeAgent: {
        providers: {
          openrouter: {
            models: [
              'moonshotai/kimi-k2.7-code',
              'qwen/qwen3-coder',
              'z-ai/glm-5.2',
            ],
          },
        },
      },
    };

    assert.deepEqual(selectVerificationModels(config), ['qwen/qwen3-coder']);
    assert.deepEqual(selectVerificationModels(config, { allModels: true }), [
      'moonshotai/kimi-k2.7-code',
      'qwen/qwen3-coder',
      'z-ai/glm-5.2',
    ]);
    assert.throws(
      () => selectVerificationModels(config, { model: 'openai/gpt-4o-mini' }),
      /is not configured/,
    );
  });

  it('reports structural regressions when the split marker or headings are missing', () => {
    const comparison = compareTaskPacketStructure(
      '# Header\n\n## 1. Objective\n',
      '# Baseline\n\n<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->\n\n## 1. Objective\n\n## 2. Technical Context\n',
    );

    assert.equal(comparison.hasSplitMarker, false);
    assert.deepEqual(comparison.missingHeadings, ['## 2. Technical Context']);
  });

  it('flags missing provenance, denied-tool coverage, and worktree drift in artifact validation', () => {
    const failures = getArtifactFailures(makeExpansionSummary({
      deniedToolCalls: [],
      sidecar: {
        ...makeExpansionSummary().sidecar,
        deniedToolCalls: [],
        transcriptPath: '',
      },
      manifestPhase: {
        totalPhaseRefs: 1,
        promptRefs: 0,
        runtimeRefs: 0,
        agentConfigRefs: 0,
        totalResources: 1,
      },
      gitStatusAfter: ' M notes.md',
    }));

    assert.match(failures.join('\n'), /prompt provenance record/);
    assert.match(failures.join('\n'), /runtime provenance record/);
    assert.match(failures.join('\n'), /tool-set provenance record/);
    assert.match(failures.join('\n'), /read-only mutation denial was not recorded/);
    assert.match(failures.join('\n'), /git status changed after the denied mutation attempt/);
  });

  it('flags bad certification and fallback summaries with specific messages', () => {
    const certificationFailures = getCertificationFailures([
      { caseId: 'valid', status: 'uncertified', reason: 'missing_artifact' },
      { caseId: 'missing', status: 'ready' },
      { caseId: 'stale', status: 'ready' },
      { caseId: 'wrong-suite', status: 'ready' },
      { caseId: 'malformed', status: 'ready' },
    ]);
    const fallbackFailures = getFallbackFailures({
      unavailableFallbackReturnedClaude: false,
      unavailableFallbackWarning: '',
      unavailableResultHasNativeMetadata: true,
      nonAvailabilityErrorMessage: 'masked',
      nonAvailabilityClaudeCalls: 1,
    });

    assert.match(certificationFailures.join('\n'), /valid certification control/);
    assert.match(certificationFailures.join('\n'), /missing certification case/);
    assert.match(fallbackFailures.join('\n'), /preserve Claude rollback/);
    assert.match(fallbackFailures.join('\n'), /expected fallback warning/);
    assert.match(fallbackFailures.join('\n'), /incorrectly reported native metadata/);
    assert.match(fallbackFailures.join('\n'), /incorrectly fell back to Claude/);
  });

  it('runs the offline verifier end-to-end and records prompt, runtime, and tool-set provenance', async () => {
    const summary = await runVerification({
      repoDir: process.cwd(),
      model: 'qwen/qwen3-coder',
    });

    assert.equal(summary.passed, true);
    assert.deepEqual(summary.selectedModels, ['qwen/qwen3-coder']);
    assert.equal(summary.expansionRuns.length, 1);
    assert.equal(summary.expansionRuns[0]?.manifestPhase.promptRefs, 1);
    assert.equal(summary.expansionRuns[0]?.manifestPhase.runtimeRefs, 1);
    assert.equal(summary.expansionRuns[0]?.manifestPhase.agentConfigRefs, 1);
    assert.equal(summary.expansionRuns[0]?.gitStatusBefore, summary.expansionRuns[0]?.gitStatusAfter);
    assert.equal(summary.expansionRuns[0]?.deniedToolCalls.length, 1);

    const markdown = buildVerificationMarkdown(summary);
    assert.match(markdown, /HOK-2416/);
    assert.match(markdown, /prompt=1, runtime=1, tool-set=1/);
    assert.match(markdown, /qwen\/qwen3-coder/);
  });

  it('renders evidence markdown with acceptance rows and artifact paths', () => {
    const summary: VerificationSummary = {
      issueId: 'HOK-2424',
      linkedIssueId: 'HOK-2416',
      repoDir: process.cwd(),
      gitSha: 'abc123',
      generatedAt: '2026-07-13T12:00:00.000Z',
      selectedModels: ['qwen/qwen3-coder'],
      expansionRuns: [makeExpansionSummary()],
      certificationCases: [
        { caseId: 'valid', status: 'ready' },
        { caseId: 'missing', status: 'uncertified', reason: 'missing_artifact' },
        { caseId: 'stale', status: 'uncertified', reason: 'stale_artifact' },
        { caseId: 'wrong-suite', status: 'uncertified', reason: 'wrong_suite' },
        { caseId: 'malformed', status: 'uncertified', reason: 'missing_artifact' },
      ],
      fallback: {
        unavailableFallbackReturnedClaude: true,
        unavailableFallbackWarning: 'falling back to Claude expansion',
        unavailableResultHasNativeMetadata: false,
        nonAvailabilityErrorMessage: 'Native task expansion failed: loop exited with stopReason=error.',
        nonAvailabilityClaudeCalls: 0,
      },
      structure: {
        baselinePath: '/repo/tests/fixtures/hok2424-claude-baseline-task-packet.md',
        baselineHeadings: ['## 1. Objective'],
        missingHeadings: [],
        hasSplitMarker: true,
      },
      worktreeStatusBefore: '',
      worktreeStatusAfter: '',
      evidencePath: 'features/verification-companion-for-native-openrouter-task-expansion-rollout-challenger/verification-evidence.md',
      passed: true,
    };

    const markdown = buildVerificationMarkdown(summary);

    assert.match(markdown, /\| Criterion \| Verdict \| Evidence \|/);
    assert.match(markdown, /task packet:/);
    assert.match(markdown, /Linked rollout issue: HOK-2416/);
  });
});
