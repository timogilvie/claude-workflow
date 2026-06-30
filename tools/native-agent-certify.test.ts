import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { certifyNativeAgent } from './native-agent-certify.ts';
import type { HarnessReport, HarnessScenarioResult } from '../shared/lib/native-agent/certification/scenario-runner.ts';
import type { NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import type { ModelRegistry } from '../shared/lib/model-registry.ts';

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
          certificationSuiteVersion: 'v1',
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
        return '/repo/.wavemill/native-agent-certifications/openai/gpt-4o/v1.json';
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

  it('does not certify a higher phase without phase-specific scenarios', async () => {
    let writeCalls = 0;

    const result = await certifyNativeAgent({
      provider: 'openai',
      model: 'gpt-4o',
      phase: 'patch',
      repoDir: '/repo',
      dryRun: false,
      registry: STUB_REGISTRY,
      runScenariosFn: async (opts) => {
        assert.equal(opts.scenarios.length > 0, true);
        assert.equal(opts.scenarios.some(s => s.phase === 'patch'), false);
        return PASSING_REPORT;
      },
      writeCertificationFn: () => { writeCalls++; return '/repo/cert.json'; },
    });

    assert.equal(writeCalls, 0, 'writeCertification must not be called without requested phase coverage');
    assert.equal(result.harnessPassed, true);
    assert.equal(result.liveCertifiable, false);
    assert.equal(result.artifactPath, undefined);
    assert.match(result.knownLimitations.join('\n'), /no patch scenarios/);
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
});
