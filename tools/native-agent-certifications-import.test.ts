import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { importLegacyCertifications } from './native-agent-certifications-import.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/schema.ts';
import {
  listCertifications,
  writeLegacyCertification,
} from '../shared/lib/native-agent/certification/store.ts';

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-cert-import-'));
  const previousCertificationRoot = process.env.WAVEMILL_CERTIFICATION_ROOT;
  process.env.WAVEMILL_CERTIFICATION_ROOT = join(repoDir, 'shared-certifications');
  return {
    repoDir,
    cleanup: () => {
      rmSync(repoDir, { recursive: true, force: true });
      if (previousCertificationRoot === undefined) {
        delete process.env.WAVEMILL_CERTIFICATION_ROOT;
      } else {
        process.env.WAVEMILL_CERTIFICATION_ROOT = previousCertificationRoot;
      }
    },
  };
}

function artifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: 'openai',
    model: 'gpt-5.5',
    phase: 'patch',
    suiteVersion: 'v2',
    certifiedAt: '2026-07-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 'patch-basic', passed: true }],
    ...overrides,
  };
}

describe('importLegacyCertifications', () => {
  it('imports a valid repo-local artifact into shared storage', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const localPath = writeLegacyCertification(repoDir, artifact());
      const results = importLegacyCertifications({
        repoDir,
        now: new Date('2026-07-15T00:00:00.000Z'),
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].sourcePath, localPath);
      assert.equal(results[0].imported, true);
      assert.equal(listCertifications(repoDir).length, 1);
      assert.ok(results[0].artifactPath?.includes('shared-certifications/openai/gpt-5.5/v2.json'));
    } finally {
      cleanup();
    }
  });

  it('rejects stale legacy artifacts without writing shared storage', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeLegacyCertification(repoDir, artifact({ certifiedAt: '2026-01-01T00:00:00.000Z' }));
      const results = importLegacyCertifications({
        repoDir,
        now: new Date('2026-07-15T00:00:00.000Z'),
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].imported, false);
      assert.equal(results[0].skipped, true);
      assert.equal(results[0].reason, 'stale');
      assert.deepEqual(listCertifications(repoDir), []);
    } finally {
      cleanup();
    }
  });
});
