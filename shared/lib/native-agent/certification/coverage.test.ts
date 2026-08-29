import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { evaluateNativeProviderGate } from './eligibility-gate.ts';
import { buildGlobalCertificationPath } from './loader.ts';
import { resolveCertificationSubject } from './identity.ts';
import { CERTIFICATION_SCHEMA_VERSION, type NativeCertificationArtifact } from './schema.ts';
import { evaluateSuiteCoverage } from './coverage.ts';
import type { ModelRegistry } from '../../model-registry.ts';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function makeRegistry(requiredSuiteVersion = 'vNEW'): ModelRegistry {
  return {
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
            certifiedAt: '2026-08-01T00:00:00.000Z',
            certificationSuiteVersion: requiredSuiteVersion,
          },
        },
      },
    },
    ladders: {},
  };
}

function makeArtifact(suiteVersion: string, registry: ModelRegistry): NativeCertificationArtifact {
  const subject = resolveCertificationSubject({ provider: 'openai', model: 'gpt-4o', registry });
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: subject.subject,
    provider: subject.storageIdentity.provider,
    model: subject.storageIdentity.model,
    phase: 'read-only',
    suiteVersion,
    certifiedAt: '2026-08-24T00:00:00.000Z',
    scenarios: [{ scenarioId: 'read-only.list-files', passed: true }],
  };
}

function writeArtifact(root: string, artifact: NativeCertificationArtifact): void {
  const path = buildGlobalCertificationPath(artifact.provider, artifact.model, artifact.suiteVersion, { root });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

describe('evaluateSuiteCoverage', () => {
  it('detects a suite bump without published current artifacts and recovers after publish', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-'));
    const registry = makeRegistry('vNEW');
    try {
      writeArtifact(root, makeArtifact('vOLD', registry));

      const coverage = evaluateSuiteCoverage({ registry, root });
      assert.equal(coverage.status, 'bump-without-publish');
      assert.equal(coverage.requiredSuiteVersion, 'vNEW');
      assert.equal(coverage.artifactCountForRequiredSuite, 0);
      assert.deepEqual(coverage.artifactCountByOtherSuite, { vOLD: 1 });
      assert.match(coverage.remediationCommand, /certify --all/);

      writeArtifact(root, makeArtifact('vNEW', registry));
      const recovered = evaluateSuiteCoverage({ registry, root });
      assert.equal(recovered.status, 'ok');
      assert.equal(recovered.artifactCountForRequiredSuite, 1);

      const gate = evaluateNativeProviderGate({
        modelId: 'gpt-4o',
        mode: 'task',
        requiredPhase: 'read-only',
        registry,
        apiKeyPresent: true,
        apiKeyEnv: 'OPENAI_API_KEY',
        now: NOW,
        certificationRoot: root,
      });
      assert.equal(gate.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags identity drift when artifacts are on the right suite but no longer match their subject', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-drift-'));
    const registry = makeRegistry('vNEW');
    try {
      // A healthy store: right suite, right subject.
      writeArtifact(root, makeArtifact('vNEW', registry));
      assert.equal(evaluateSuiteCoverage({ registry, root }).status, 'ok');

      // Now simulate the launch-priority fixture changing underneath it. The
      // artifact count and suite version are untouched — only catalogHash moves,
      // which is precisely the case the count-based guard could not see.
      const drifted = makeArtifact('vNEW', registry);
      drifted.subject = { ...drifted.subject!, catalogHash: 'hash-from-a-previous-fixture' };
      writeArtifact(root, drifted);

      const coverage = evaluateSuiteCoverage({ registry, root });
      assert.equal(coverage.status, 'identity-drift');
      assert.equal(coverage.artifactCountForRequiredSuite, 1, 'count signal is unchanged');
      assert.equal(coverage.eligibleModelCount, 0);
      assert.equal(coverage.identityDriftCount, 1);
      assert.deepEqual(
        coverage.ineligibleModels.map((m) => m.reason),
        ['identity-reidentified'],
      );

      // Re-certifying restores eligibility.
      writeArtifact(root, makeArtifact('vNEW', registry));
      assert.equal(evaluateSuiteCoverage({ registry, root }).status, 'ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not raise identity drift for a lone stale orphan while the fleet is healthy', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-orphan-'));
    const registry = makeRegistry('vNEW');
    try {
      writeArtifact(root, makeArtifact('vNEW', registry));
      // An artifact for a model that is no longer in the registry at all must not
      // be counted against the fleet: it is never resolved as a certifiable model.
      const orphan = makeArtifact('vNEW', registry);
      orphan.provider = 'stealth';
      orphan.model = 'removed-model';
      writeArtifact(root, orphan);

      const coverage = evaluateSuiteCoverage({ registry, root });
      assert.equal(coverage.status, 'ok');
      assert.equal(coverage.eligibleModelCount, 1);
      assert.equal(coverage.identityDriftCount, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats an empty store as a warning state, not a bump failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-coverage-empty-'));
    try {
      const coverage = evaluateSuiteCoverage({ registry: makeRegistry('vNEW'), root });
      assert.equal(coverage.status, 'empty-store');
      assert.equal(coverage.artifactCountForRequiredSuite, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
