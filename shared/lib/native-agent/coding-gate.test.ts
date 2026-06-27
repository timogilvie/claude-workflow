import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { evaluatePatchCodingGate, isPatchCodingEnabled } from './coding-gate.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
  type PatchCodingCertification,
} from './coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from './smoke.ts';

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'patch-coding-gate-'));
}

function cleanupRepo(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

function writeConfig(repoDir: string, content: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
}

function writeCertification(repoDir: string, record: PatchCodingCertification): void {
  const path = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

function makeCertification(overrides: Partial<PatchCodingCertification> = {}): PatchCodingCertification {
  return {
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: '2026-06-26T12:00:00.000Z',
    providers: [
      { provider: 'openai', model: 'gpt-4o', passed: true },
      { provider: 'openrouter', model: 'openai/gpt-4o-mini', passed: true },
    ],
    ...overrides,
  };
}

describe('patch coding gate', () => {
  it('returns disabled when config and certification are both absent', () => {
    const repoDir = makeTempRepo();
    try {
      assert.deepEqual(isPatchCodingEnabled(repoDir), {
        enabled: false,
        reason: 'config_disabled',
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns disabled when config is enabled but certification is missing', () => {
    const repoDir = makeTempRepo();
    try {
      writeConfig(repoDir, {
        nativeAgent: {
          patchCoding: {
            enabled: true,
          },
        },
      });

      assert.deepEqual(isPatchCodingEnabled(repoDir), {
        enabled: false,
        reason: 'missing',
        certification: undefined,
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns disabled when config is absent even if certification is valid', () => {
    const repoDir = makeTempRepo();
    try {
      writeCertification(repoDir, makeCertification());

      assert.deepEqual(isPatchCodingEnabled(repoDir), {
        enabled: false,
        reason: 'config_disabled',
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns enabled when config is true and certification is valid', () => {
    const repoDir = makeTempRepo();
    try {
      writeConfig(repoDir, {
        nativeAgent: {
          patchCoding: {
            enabled: true,
          },
        },
      });
      const certification = makeCertification();
      writeCertification(repoDir, certification);

      assert.deepEqual(isPatchCodingEnabled(repoDir), {
        enabled: true,
        reason: 'enabled',
        certification,
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns disabled when config is true and certification revision is stale', () => {
    const repoDir = makeTempRepo();
    try {
      writeConfig(repoDir, {
        nativeAgent: {
          patchCoding: {
            enabled: true,
          },
        },
      });
      const certification = makeCertification({
        smokeSuiteRevision: 'patch-coding-smoke-v0',
      });
      writeCertification(repoDir, certification);

      assert.deepEqual(isPatchCodingEnabled(repoDir), {
        enabled: false,
        reason: 'revision_mismatch',
        certification,
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('evaluatePatchCodingGate only uses injected data', () => {
    const certification = makeCertification();
    assert.deepEqual(
      evaluatePatchCodingGate({
        config: { enabled: true },
        certification: { valid: true, record: certification },
        currentSmokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
      }),
      {
        enabled: true,
        reason: 'enabled',
        certification,
      },
    );
  });
});
