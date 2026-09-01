import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../shared/lib/model-registry.ts';
import {
  buildGlobalCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  resolveCertificationSubject,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';
import { pruneOrphanCertifications, renderPruneSummary } from './native-agent-certifications-prune.ts';

function registry(): ModelRegistry {
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
            maxCertifiedPhase: 'workflow',
            certifiedAt: '2026-08-01T00:00:00.000Z',
            certificationSuiteVersion: 'v3',
          },
        },
      },
    },
    ladders: {},
  };
}

function artifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  const subject = resolveCertificationSubject({ provider: 'openai', model: 'gpt-4o', registry: registry() });
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: subject.subject,
    provider: subject.storageIdentity.provider,
    model: subject.storageIdentity.model,
    phase: 'workflow',
    suiteVersion: 'v3',
    certifiedAt: '2026-08-24T00:00:00.000Z',
    scenarios: [{ scenarioId: 'workflow.run', passed: true }],
    ...overrides,
  };
}

function writeArtifact(root: string, record: NativeCertificationArtifact): string {
  const path = buildGlobalCertificationPath(record.provider, record.model, record.suiteVersion, { root });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

describe('pruneOrphanCertifications', () => {
  it('reports orphan artifacts in dry-run mode without deleting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-cert-prune-'));
    try {
      const currentPath = writeArtifact(root, artifact());
      const orphanPath = writeArtifact(root, artifact({ provider: 'stealth', model: 'ox-alpha' }));

      const summary = pruneOrphanCertifications({
        repoDir: process.cwd(),
        root,
        registry: registry(),
        dryRun: true,
      });

      assert.equal(summary.dryRun, true);
      assert.equal(summary.candidates.length, 1);
      assert.equal(summary.candidates[0]?.provider, 'stealth');
      assert.equal(existsSync(orphanPath), true);
      assert.equal(existsSync(currentPath), true);
      assert.match(renderPruneSummary(summary), /would prune: stealth\/ox-alpha\/v3/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes orphans with --yes semantics and leaves current artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-cert-prune-delete-'));
    try {
      const currentPath = writeArtifact(root, artifact());
      const orphanPath = writeArtifact(root, artifact({ provider: 'stealth', model: 'ox-alpha' }));

      const summary = pruneOrphanCertifications({
        repoDir: process.cwd(),
        root,
        registry: registry(),
        dryRun: false,
      });

      assert.equal(summary.failures.length, 0);
      assert.equal(summary.pruned.length, 1);
      assert.equal(existsSync(orphanPath), false);
      assert.equal(existsSync(currentPath), true);
      assert.match(renderPruneSummary(summary), /pruned: stealth\/ox-alpha\/v3/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports zero orphans cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-cert-prune-empty-'));
    try {
      writeArtifact(root, artifact());
      const summary = pruneOrphanCertifications({
        repoDir: process.cwd(),
        root,
        registry: registry(),
      });
      assert.deepEqual(summary.candidates, []);
      assert.match(renderPruneSummary(summary), /0 orphan artifacts found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a stable JSON-friendly summary shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-cert-prune-json-'));
    try {
      writeArtifact(root, artifact({ provider: 'stealth', model: 'ox-alpha' }));
      const summary = pruneOrphanCertifications({
        repoDir: process.cwd(),
        root,
        registry: registry(),
      });
      assert.deepEqual(Object.keys(summary).sort(), ['candidates', 'dryRun', 'failures', 'pruned']);
      assert.equal(summary.dryRun, true);
      assert.equal(summary.candidates.length, 1);
      assert.deepEqual(summary.pruned, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
