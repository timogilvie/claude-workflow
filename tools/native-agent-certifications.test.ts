import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { listGlobalCertificationArtifacts } from './native-agent-certifications-list.ts';
import { inspectGlobalCertification } from './native-agent-certifications-inspect.ts';
import { verifyGlobalCertification } from './native-agent-certifications-verify.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  writeGlobalCertification,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';

function withGlobalRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'native-cert-tools-'));
  const previous = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) {
      delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    } else {
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function artifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: 'qwen',
    model: 'qwen3-coder',
    phase: 'patch',
    suiteVersion: 'v2',
    certifiedAt: '2026-08-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 'patch-apply', passed: true }],
    ...overrides,
  };
}

describe('native-agent certifications tools', () => {
  it('lists and inspects artifacts from the global root', () => withGlobalRoot(() => {
    writeGlobalCertification(artifact());

    const listed = listGlobalCertificationArtifacts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].provider, 'qwen');
    assert.equal(listed[0].model, 'qwen3-coder');

    const inspected = inspectGlobalCertification({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      suiteVersion: 'v2',
      requiredPhase: 'patch',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    assert.equal(inspected.found, true);
    assert.equal(inspected.eligible, true);
    assert.equal(inspected.expiresAt, '2026-09-30T00:00:00.000Z');
  }));

  it('verifies aliases and rejects phase-insufficient artifacts identically', () => withGlobalRoot(() => {
    writeGlobalCertification(artifact({ phase: 'read-only' }));

    const result = verifyGlobalCertification({
      provider: 'openrouter',
      model: 'qwen-3-coder',
      suiteVersion: 'v2',
      requiredPhase: 'patch',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.provider, 'qwen');
    assert.equal(result.model, 'qwen3-coder');
    assert.equal(result.reason, 'phase-insufficient');
  }));
});
