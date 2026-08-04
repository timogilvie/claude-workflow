import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CERTIFICATION_SCHEMA_VERSION,
  writeCertification,
  type NativeCertificationArtifact,
} from './index.ts';
import { evaluateMigrationEligibility } from './migration.ts';

const NOW = new Date('2026-07-02T00:00:00.000Z');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'native-cert-migration-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function makeArtifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: 'openai',
    model: 'gpt-4o',
    phase: 'patch',
    suiteVersion: 'v2',
    certifiedAt: '2026-07-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 'patch', passed: true }],
    ...overrides,
  };
}

describe('evaluateMigrationEligibility', () => {
  it('refuses v1 suite artifacts rather than promoting them', () => {
    const repoDir = makeTempDir();
    try {
      const path = writeCertification(repoDir, makeArtifact({ suiteVersion: 'v1' }));
      const result = evaluateMigrationEligibility({ path, now: NOW, globalArtifactExists: () => false });

      assert.equal(result.decision, 'not-importable-v1-suite');
      assert.match(result.reason, /re-certified/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('marks compatible v2 artifacts reusable only after verify', () => {
    const repoDir = makeTempDir();
    try {
      const path = writeCertification(repoDir, makeArtifact());
      const result = evaluateMigrationEligibility({ path, now: NOW, globalArtifactExists: () => false });

      assert.equal(result.decision, 'reusable-but-verify');
      assert.equal(result.provider, 'openai');
      assert.equal(result.model, 'gpt-4o');
      assert.equal(result.suiteVersion, 'v2');
    } finally {
      cleanup(repoDir);
    }
  });

  it('flags stale v2 artifacts for re-certification', () => {
    const repoDir = makeTempDir();
    try {
      const path = writeCertification(repoDir, makeArtifact({ certifiedAt: '2025-01-01T00:00:00.000Z' }));
      const result = evaluateMigrationEligibility({ path, now: NOW, globalArtifactExists: () => false });

      assert.equal(result.decision, 'stale-reuse-not-recommended');
      assert.match(result.reason, /expired/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports already-global when the canonical global artifact exists', () => {
    const repoDir = makeTempDir();
    try {
      const path = writeCertification(repoDir, makeArtifact());
      const result = evaluateMigrationEligibility({ path, now: NOW, globalArtifactExists: () => true });

      assert.equal(result.decision, 'already-global');
      assert.equal(result.globalArtifactExists, true);
    } finally {
      cleanup(repoDir);
    }
  });
});
