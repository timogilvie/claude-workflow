import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
  loadPatchCodingCertification,
  validatePatchCodingCertification,
  writePatchCodingCertification,
  type PatchCodingCertification,
} from './coding-certification.ts';

const REVISION = 'patch-coding-smoke-v1';

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'patch-coding-cert-'));
}

function cleanupRepo(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

function makeCertification(overrides: Partial<PatchCodingCertification> = {}): PatchCodingCertification {
  return {
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: REVISION,
    certifiedAt: '2026-06-26T12:00:00.000Z',
    providers: [
      { provider: 'openai', model: 'gpt-4o', passed: true, transcriptPath: '/tmp/openai.jsonl' },
      { provider: 'openrouter', model: 'openai/gpt-4o-mini', passed: true, transcriptPath: '/tmp/openrouter.jsonl' },
    ],
    ...overrides,
  };
}

describe('patch coding certification', () => {
  it('returns missing when the artifact does not exist', () => {
    const repoDir = makeTempRepo();
    try {
      const status = loadPatchCodingCertification(repoDir, REVISION);
      assert.deepEqual(status, { valid: false, reason: 'missing' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns malformed when the artifact JSON cannot be parsed', () => {
    const repoDir = makeTempRepo();
    try {
      const outputPath = getPatchCodingCertificationPath(repoDir);
      mkdirSync(join(repoDir, '.wavemill/native-agent'), { recursive: true });
      writeFileSync(outputPath, '{ broken json', 'utf-8');
      const status = loadPatchCodingCertification(repoDir, REVISION);
      assert.deepEqual(status, { valid: false, reason: 'malformed' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('rejects certified false records', () => {
    const status = validatePatchCodingCertification(makeCertification({ certified: false }), REVISION);
    assert.equal(status.valid, false);
    assert.equal(status.reason, 'not_certified');
  });

  it('rejects records with only one provider/model pair', () => {
    const status = validatePatchCodingCertification(makeCertification({
      providers: [{ provider: 'openai', model: 'gpt-4o', passed: true }],
    }), REVISION);
    assert.equal(status.valid, false);
    assert.equal(status.reason, 'insufficient_providers');
  });

  it('rejects duplicate provider/model pairs', () => {
    const status = validatePatchCodingCertification(makeCertification({
      providers: [
        { provider: 'openai', model: 'gpt-4o', passed: true },
        { provider: 'openai', model: 'gpt-4o', passed: true, transcriptPath: '/tmp/dup.jsonl' },
      ],
    }), REVISION);
    assert.equal(status.valid, false);
    assert.equal(status.reason, 'insufficient_providers');
  });

  it('rejects failed providers', () => {
    const status = validatePatchCodingCertification(makeCertification({
      providers: [
        { provider: 'openai', model: 'gpt-4o', passed: true },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini', passed: false, skipReason: 'skipped' },
      ],
    }), REVISION);
    assert.equal(status.valid, false);
    assert.equal(status.reason, 'provider_failed');
  });

  it('rejects empty provider or model values', () => {
    const status = validatePatchCodingCertification(makeCertification({
      providers: [
        { provider: '', model: 'gpt-4o', passed: true },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini', passed: true },
      ],
    }), REVISION);
    assert.equal(status.valid, false);
    assert.equal(status.reason, 'malformed');
  });

  it('rejects stale revisions', () => {
    const status = validatePatchCodingCertification(makeCertification({
      smokeSuiteRevision: 'patch-coding-smoke-v0',
    }), REVISION);
    assert.equal(status.valid, false);
    assert.equal(status.reason, 'revision_mismatch');
  });

  it('accepts a valid two-pair certification', () => {
    const status = validatePatchCodingCertification(makeCertification(), REVISION);
    assert.equal(status.valid, true);
    if (status.valid) {
      assert.equal(status.record.providers.length, 2);
      assert.equal(status.record.smokeSuiteRevision, REVISION);
    }
  });

  it('writes parseable JSON to the expected path atomically', () => {
    const repoDir = makeTempRepo();
    try {
      const record = makeCertification();
      const outputPath = writePatchCodingCertification(repoDir, record);
      assert.equal(outputPath, getPatchCodingCertificationPath(repoDir));

      const written = JSON.parse(readFileSync(outputPath, 'utf-8')) as PatchCodingCertification;
      assert.deepEqual(written, record);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});
