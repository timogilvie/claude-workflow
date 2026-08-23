import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { importLegacyCertifications } from './native-agent-certifications-import.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  readCertification,
  writeCertification,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'native-cert-import-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function makeArtifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  const provider = overrides.provider ?? 'openai';
  const model = overrides.model ?? 'gpt-4o';
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: overrides.subject ?? {
      registryKey: model,
      nativeProvider: provider === 'qwen' ? 'openrouter' : provider,
      providerId: provider,
      providerModelId: model,
      providerNativeId: provider === 'qwen' ? `${provider}/${model}` : model,
      identityRevision: 1,
      identityFingerprint: `test-${provider}-${model}`,
      catalogHash: provider === 'qwen' ? 'test-catalog' : 'registry',
    },
    provider,
    model,
    phase: 'read-only',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: '2026-07-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 'read', passed: true }],
    ...overrides,
  };
}

describe('importLegacyCertifications', () => {
  it('imports valid legacy artifacts into shared storage', () => {
    const repoDir = makeTempDir();
    const sharedRoot = makeTempDir();
    const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
    process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = sharedRoot;
    try {
      writeCertification(repoDir, makeArtifact());
      const summary = importLegacyCertifications({
        repoDir,
        now: new Date('2026-07-02T00:00:00.000Z'),
      });

      assert.equal(summary.scanned, 1);
      assert.equal(summary.imported.length, 1);
      assert.equal(summary.skipped.length, 0);
      const imported = readCertification(summary.imported[0].artifactPath);
      assert.ok(imported.ok);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
      } else {
        process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
      }
      cleanup(repoDir);
      cleanup(sharedRoot);
    }
  });

  it('skips stale legacy artifacts', () => {
    const repoDir = makeTempDir();
    const sharedRoot = makeTempDir();
    const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
    process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = sharedRoot;
    try {
      writeCertification(repoDir, makeArtifact({ certifiedAt: '2024-01-01T00:00:00.000Z' }));
      const summary = importLegacyCertifications({
        repoDir,
        now: new Date('2026-07-02T00:00:00.000Z'),
      });

      assert.equal(summary.imported.length, 0);
      assert.deepEqual(summary.skipped.map((entry) => entry.reason), ['stale']);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
      } else {
        process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
      }
      cleanup(repoDir);
      cleanup(sharedRoot);
    }
  });

  it('refuses legacy v1 suite artifacts and schedules re-certification', () => {
    const repoDir = makeTempDir();
    const sharedRoot = makeTempDir();
    const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
    process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = sharedRoot;
    try {
      writeCertification(repoDir, makeArtifact({ suiteVersion: 'v1' }));
      const summary = importLegacyCertifications({
        repoDir,
        now: new Date('2026-07-02T00:00:00.000Z'),
      });

      assert.equal(summary.imported.length, 0);
      assert.deepEqual(summary.skipped.map((entry) => [entry.reason, entry.action]), [
        ['wrong-suite', 're-certify'],
      ]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
      } else {
        process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
      }
      cleanup(repoDir);
      cleanup(sharedRoot);
    }
  });


  it('imports normalized OpenRouter storage identities', () => {
    const repoDir = makeTempDir();
    const sharedRoot = makeTempDir();
    const previousRoot = process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
    process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = sharedRoot;
    try {
      writeCertification(repoDir, makeArtifact({
        provider: 'qwen',
        model: 'qwen3-coder',
      }));
      const summary = importLegacyCertifications({
        repoDir,
        provider: 'qwen',
        model: 'qwen3-coder',
        dryRun: true,
        now: new Date('2026-07-02T00:00:00.000Z'),
      });

      assert.equal(summary.scanned, 1);
      assert.equal(summary.imported.length, 1);
      assert.equal(summary.skipped.length, 0);
      assert.match(summary.imported[0].artifactPath, /qwen\/qwen3-coder\/v3\.json$/);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT;
      } else {
        process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = previousRoot;
      }
      cleanup(repoDir);
      cleanup(sharedRoot);
    }
  });
});
