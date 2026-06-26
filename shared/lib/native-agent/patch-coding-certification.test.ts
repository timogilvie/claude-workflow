import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  assertPatchCodingCertificationCoverage,
  computeSmokeSuiteRevision,
  readPatchCodingCertification,
  type PatchCodingCertification,
} from './patch-coding-certification.ts';

const tempDirs = new Set<string>();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function makeCertification(overrides: Partial<PatchCodingCertification> = {}): PatchCodingCertification {
  return {
    schemaVersion: '1',
    smokeSuiteRevision: 'abc123',
    certifiedAt: '2026-06-26T00:00:00.000Z',
    providers: [
      { provider: 'openai', model: 'gpt-4o', usageTokens: 1200, toolCalls: 3 },
      { provider: 'openrouter', model: 'openai/gpt-4o-mini', usageTokens: 900, toolCalls: 3 },
    ],
    ...overrides,
  };
}

describe('patch-coding-certification coverage', () => {
  it('accepts two distinct certified providers', () => {
    assert.deepEqual(assertPatchCodingCertificationCoverage(makeCertification()), { ok: true });
  });

  it('rejects fewer than two providers', () => {
    const result = assertPatchCodingCertificationCoverage(makeCertification({
      providers: [{ provider: 'openai', model: 'gpt-4o', usageTokens: 1200, toolCalls: 3 }],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /requires ≥2/i);
  });

  it('rejects duplicate provider and model pairs', () => {
    const result = assertPatchCodingCertificationCoverage(makeCertification({
      providers: [
        { provider: 'openai', model: 'gpt-4o', usageTokens: 1200, toolCalls: 3 },
        { provider: 'openai', model: 'gpt-4o', usageTokens: 900, toolCalls: 2 },
      ],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /duplicate/i);
  });

  it('rejects zero usage tokens', () => {
    const result = assertPatchCodingCertificationCoverage(makeCertification({
      providers: [
        { provider: 'openai', model: 'gpt-4o', usageTokens: 0, toolCalls: 3 },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini', usageTokens: 900, toolCalls: 3 },
      ],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /zero usage tokens/i);
  });

  it('rejects zero tool calls', () => {
    const result = assertPatchCodingCertificationCoverage(makeCertification({
      providers: [
        { provider: 'openai', model: 'gpt-4o', usageTokens: 1200, toolCalls: 0 },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini', usageTokens: 900, toolCalls: 3 },
      ],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /no tool calls/i);
  });

  it('accepts more than two distinct providers', () => {
    assert.deepEqual(assertPatchCodingCertificationCoverage(makeCertification({
      providers: [
        { provider: 'openai', model: 'gpt-4o', usageTokens: 1200, toolCalls: 3 },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini', usageTokens: 900, toolCalls: 3 },
        { provider: 'openrouter', model: 'qwen/qwen-3-coder', usageTokens: 950, toolCalls: 2 },
      ],
    })), { ok: true });
  });
});

describe('patch-coding-certification reader', () => {
  it('reads a valid certification record', () => {
    const dir = makeTempDir('patch-coding-cert-read-');
    const certPath = join(dir, 'cert.json');
    writeFileSync(certPath, `${JSON.stringify(makeCertification(), null, 2)}\n`, 'utf-8');
    assert.deepEqual(readPatchCodingCertification(certPath), makeCertification());
  });

  it('returns null for missing files', () => {
    const dir = makeTempDir('patch-coding-cert-missing-');
    assert.equal(readPatchCodingCertification(join(dir, 'missing.json')), null);
  });

  it('returns null for malformed json', () => {
    const dir = makeTempDir('patch-coding-cert-bad-json-');
    const certPath = join(dir, 'cert.json');
    writeFileSync(certPath, '{bad json', 'utf-8');
    assert.equal(readPatchCodingCertification(certPath), null);
  });

  it('returns null for wrong schema version', () => {
    const dir = makeTempDir('patch-coding-cert-schema-');
    const certPath = join(dir, 'cert.json');
    writeFileSync(certPath, `${JSON.stringify({ ...makeCertification(), schemaVersion: '2' }, null, 2)}\n`, 'utf-8');
    assert.equal(readPatchCodingCertification(certPath), null);
  });

  it('returns null for empty files', () => {
    const dir = makeTempDir('patch-coding-cert-empty-');
    const certPath = join(dir, 'cert.json');
    writeFileSync(certPath, '', 'utf-8');
    assert.equal(readPatchCodingCertification(certPath), null);
  });
});

describe('patch-coding-certification revision hashing', () => {
  it('is deterministic and order-independent', () => {
    const dir = makeTempDir('patch-coding-cert-hash-');
    const first = join(dir, 'a.txt');
    const second = join(dir, 'b.txt');
    writeFileSync(first, 'alpha\n', 'utf-8');
    writeFileSync(second, 'beta\n', 'utf-8');

    const left = computeSmokeSuiteRevision([first, second]);
    const right = computeSmokeSuiteRevision([second, first]);

    assert.equal(left, right);
  });

  it('changes when fixture content changes', () => {
    const dir = makeTempDir('patch-coding-cert-hash-change-');
    const first = join(dir, 'a.txt');
    const second = join(dir, 'b.txt');
    writeFileSync(first, 'alpha\n', 'utf-8');
    writeFileSync(second, 'beta\n', 'utf-8');

    const before = computeSmokeSuiteRevision([first, second]);
    writeFileSync(second, 'gamma\n', 'utf-8');
    const after = computeSmokeSuiteRevision([first, second]);

    assert.notEqual(before, after);
  });
});
