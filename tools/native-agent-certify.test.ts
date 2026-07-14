import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { certifyNativeAgent } from './native-agent-certify.ts';
import type { HarnessReport, HarnessScenarioResult } from '../shared/lib/native-agent/certification/scenario-runner.ts';
import type { NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from '../shared/lib/native-agent/certification/scenarios.ts';
import type { ModelRegistry } from '../shared/lib/model-registry.ts';

const OPENROUTER_STORAGE_CASES = [
  {
    rawId: 'qwen/qwen3-coder',
    alias: 'qwen-3-coder',
    providerPath: 'qwen',
    modelPath: 'qwen3-coder',
    vendor: 'qwen',
    modelClass: 'strong_generalist' as const,
    qualityScores: { routing: 60, planning: 72, coding: 84, review: 78, classify: 58 },
    contextWindowTokens: 131_072,
    costPerMillionInputTokensUsd: 0.35,
    costPerMillionOutputTokensUsd: 1.05,
  },
  {
    rawId: 'z-ai/glm-5.2',
    alias: 'glm-5.2',
    providerPath: 'z-ai',
    modelPath: 'glm-5.2',
    vendor: 'z-ai',
    modelClass: 'frontier' as const,
    qualityScores: { routing: 62, planning: 80, coding: 80, review: 84, classify: 60 },
    contextWindowTokens: 1_048_576,
    costPerMillionInputTokensUsd: 0.93,
    costPerMillionOutputTokensUsd: 3,
  },
  {
    rawId: 'moonshotai/kimi-k2.7-code',
    alias: 'kimi-k2.7-code',
    providerPath: 'moonshotai',
    modelPath: 'kimi-k2.7-code',
    vendor: 'kimi',
    modelClass: 'strong_generalist' as const,
    qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
    contextWindowTokens: 262_144,
    costPerMillionInputTokensUsd: 0.74,
    costPerMillionOutputTokensUsd: 3.5,
  },
] as const;

// ---------------------------------------------------------------------------
// Minimal stub registry with one certified model
// ---------------------------------------------------------------------------

const STUB_REGISTRY: ModelRegistry = {
  models: {
    'gpt-4o': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
      contextWindowTokens: 128_000,
      toolSupport: { functionCalling: true, streamingTools: true },
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 3,
      costPerMillionOutputTokensUsd: 15,
      nativeCapability: {
        nativeProvider: 'openai',
        piTransportKind: 'openai-responses',
        readOnlyNative: 'certified',
        certification: {
          maxCertifiedPhase: 'read-only',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
    'qwen-3-coder': {
      vendor: 'qwen',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 60, planning: 72, coding: 84, review: 78, classify: 58 },
      contextWindowTokens: 131_072,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 0.35,
      costPerMillionOutputTokensUsd: 1.05,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
    'glm-5.2': {
      vendor: 'z-ai',
      class: 'frontier',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 62, planning: 80, coding: 80, review: 84, classify: 60 },
      contextWindowTokens: 1_048_576,
      toolSupport: 'basic',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.93,
      costPerMillionOutputTokensUsd: 3,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
    'kimi-k2.7-code': {
      vendor: 'kimi',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
      contextWindowTokens: 262_144,
      toolSupport: 'basic',
      multimodal: { text: true, image: true },
      latencyTier: 'standard',
      reasoningTier: 'advanced',
      costPerMillionInputTokensUsd: 0.74,
      costPerMillionOutputTokensUsd: 3.5,
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: new Date().toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
  },
  ladders: {},
};

const PASSING_REPORT: HarnessReport = {
  provider: 'openai',
  model: 'gpt-4o',
  transport: 'openai-responses',
  results: [
    {
      scenarioId: 's1',
      category: 'tool',
      classification: 'deterministic',
      phase: 'read-only',
      status: 'pass',
      durationMs: 1,
    } as HarnessScenarioResult,
  ],
  countsByStatus: { pass: 1, fail: 0, unsupported: 0, 'not-run': 0 },
  countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
  knownLimitations: [],
  harnessPassed: true,
  liveCertifiable: true,
  dryRun: false,
};

const FAILING_REPORT: HarnessReport = {
  ...PASSING_REPORT,
  results: [
    {
      scenarioId: 's1',
      category: 'tool',
      classification: 'deterministic',
      phase: 'read-only',
      status: 'fail',
      detail: 'assertion failed',
      durationMs: 1,
    } as HarnessScenarioResult,
  ],
  countsByStatus: { pass: 0, fail: 1, unsupported: 0, 'not-run': 0 },
  harnessPassed: false,
  liveCertifiable: false,
};

describe('certifyNativeAgent', () => {
  it('dry-run does not persist an artifact', async () => {
    let writeCalls = 0;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: true,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({ ...PASSING_REPORT, dryRun: true, liveCertifiable: false }),
      writeCertificationFn: () => { writeCalls++; return '/repo/cert.json'; },
    });

    assert.equal(writeCalls, 0, 'writeCertification must not be called in dry-run');
    assert.equal(result.dryRun, true);
    assert.equal(result.artifactPath, undefined);
    assert.equal(result.harnessPassed, true);
  });

  it('live success writes the artifact and returns path', async () => {
    let written: NativeCertificationArtifact | undefined;
    const FIXED_NOW = new Date('2026-03-01T00:00:00.000Z');

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => PASSING_REPORT,
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
      now: () => FIXED_NOW,
    });

    assert.ok(result.artifactPath, 'artifactPath should be set');
    assert.ok(written, 'artifact should have been written');
    assert.equal(written.provider, 'openai');
    assert.equal(written.model, 'gpt-4o');
    assert.equal(written.phase, 'read-only');
    assert.equal(written.certifiedAt, FIXED_NOW.toISOString());
    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, true);
  });

  it('harness failure does not write artifact', async () => {
    let writeCalls = 0;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => FAILING_REPORT,
      writeCertificationFn: () => { writeCalls++; return '/repo/cert.json'; },
    });

    assert.equal(writeCalls, 0, 'writeCertification must not be called when harness fails');
    assert.equal(result.harnessPassed, false);
    assert.equal(result.artifactPath, undefined);
  });

  it('certifies patch when the default catalog includes patch scenarios', async () => {
    let written: NativeCertificationArtifact | undefined;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'patch',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => {
        assert.equal(opts.scenarios.length > 0, true);
        assert.equal(opts.scenarios.some((scenario) => scenario.phase === 'patch'), true);
        return {
          ...PASSING_REPORT,
          results: [
            {
              scenarioId: 'patch.runtime.native-patch-application',
              category: 'tool',
              classification: 'deterministic',
              phase: 'patch',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
        };
      },
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
    });

    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, true);
    assert.equal(result.artifactPath, `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`);
    assert.ok(written, 'patch artifact should have been written');
    assert.equal(written.phase, 'patch');
    assert.equal(result.knownLimitations.some((limitation) => /no patch scenarios/.test(limitation)), false);
  });

  it('certifies workflow when the default catalog includes workflow scenarios', async () => {
    let written: NativeCertificationArtifact | undefined;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'workflow',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => {
        assert.equal(opts.scenarios.some((scenario) => scenario.phase === 'workflow'), true);
        return {
          ...PASSING_REPORT,
          results: [
            {
              scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
              category: 'phase',
              classification: 'deterministic',
              phase: 'workflow',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
        };
      },
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
    });

    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, true);
    assert.equal(result.artifactPath, `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`);
    assert.ok(written);
    assert.equal(written.phase, 'workflow');
    assert.equal(result.knownLimitations.some((limitation) => /no workflow scenarios/.test(limitation)), false);
  });

  it('throws for unsupported model', async () => {
    await assert.rejects(
      () => certifyNativeAgent({
        provider: 'openai',
        model: 'unknown-model',
        phase: 'read-only',
        repoDir: '/repo',
        registry: STUB_REGISTRY,
        runScenariosFn: async () => PASSING_REPORT,
        writeCertificationFn: () => '/repo/cert.json',
      }),
      /not supported for native certification/,
    );
  });

  it('includes scenario outcomes in the result', async () => {
    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: true,
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({ ...PASSING_REPORT, dryRun: true, liveCertifiable: false }),
      writeCertificationFn: () => '/repo/cert.json',
    });

    assert.equal(result.scenarios.length, 1);
    assert.equal(result.scenarios[0].scenarioId, 's1');
    assert.equal(result.scenarios[0].status, 'pass');
  });

  for (const testCase of OPENROUTER_STORAGE_CASES) {
    it(`resolves raw OpenRouter id ${testCase.rawId} through registry metadata and writes storage identity`, async () => {
      let written: NativeCertificationArtifact | undefined;
      const expectedArtifactPath = `/repo/.wavemill/native-agent-certifications/${testCase.providerPath}/${testCase.modelPath}/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;

      const result = await certifyNativeAgent({
        provider: 'openrouter',
        model: testCase.rawId,
        phase: 'workflow',
        repoDir: '/repo',
        registry: STUB_REGISTRY,
        runScenariosFn: async () => ({
          ...PASSING_REPORT,
          provider: 'openrouter',
          model: testCase.rawId,
          transport: 'openai-completions',
          results: [
            {
              scenarioId: 'workflow.phase.workflow-persistence-roundtrip',
              category: 'phase',
              classification: 'deterministic',
              phase: 'workflow',
              status: 'pass',
              durationMs: 1,
            } as HarnessScenarioResult,
          ],
          countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
        }),
        writeCertificationFn: (_repoDir, artifact) => {
          written = artifact;
          return expectedArtifactPath;
        },
      });

      assert.equal(result.model, testCase.rawId);
      assert.equal(result.artifactPath, expectedArtifactPath);
      assert.ok(written, 'artifact should have been written');
      assert.equal(written.provider, testCase.providerPath);
      assert.equal(written.model, testCase.modelPath);
      assert.equal(written.phase, 'workflow');
    });
  }

  it('omits not-run live-judge scenarios from persisted artifacts', async () => {
    let written: NativeCertificationArtifact | undefined;

    await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'read-only',
      repoDir: '/repo',
      registry: STUB_REGISTRY,
      runScenariosFn: async () => ({
        ...PASSING_REPORT,
        results: [
          PASSING_REPORT.results[0]!,
          {
            scenarioId: 'live.judge.tool-output-summary-quality',
            category: 'tool',
            classification: 'live-judged',
            phase: 'read-only',
            status: 'not-run',
            reason: 'requires-live-judge',
            durationMs: 1,
          } as HarnessScenarioResult,
        ],
      }),
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        return `/repo/.wavemill/native-agent-certifications/openai/gpt-4o/${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`;
      },
    });

    assert.ok(written, 'artifact should have been written');
    assert.deepEqual(
      written.scenarios.map((scenario) => scenario.scenarioId),
      ['s1'],
    );
  });
});
