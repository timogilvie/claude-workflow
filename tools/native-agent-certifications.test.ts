import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { listGlobalCertificationArtifacts } from './native-agent-certifications-list.ts';
import { inspectGlobalCertification } from './native-agent-certifications-inspect.ts';
import { verifyGlobalCertification } from './native-agent-certifications-verify.ts';
import { planIdentityAudit, writeIdentityAudit } from './native-agent-certifications-identity.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  GLOBAL_CERTIFICATION_ROOT_ENV,
  resolveCertificationSubject,
  writeGlobalCertification,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';
import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';

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
  const subject = resolveCertificationSubject({
    provider: 'openrouter',
    model: 'qwen-3-coder',
    registry: getEffectiveRegistry(),
  });
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: subject.subject,
    provider: 'qwen',
    model: 'qwen3-coder',
    phase: 'patch',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
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
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
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
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      requiredPhase: 'patch',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.provider, 'qwen');
    assert.equal(result.model, 'qwen3-coder');
    assert.equal(result.reason, 'phase-insufficient');
  }));

  it('plans re-identification dry-runs without writing audit artifacts', () => withGlobalRoot((root) => {
    const certPath = writeGlobalCertification(artifact());

    const result = planIdentityAudit({
      operation: 'reidentify',
      provider: 'openrouter',
      model: 'qwen/qwen3-coder',
      root,
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.auditPath, undefined);
    assert.equal(existsSync(join(root, '.audits')), false);
    assert.deepEqual(result.affectedArtifactPaths, [relative(root, certPath)]);
    assert.equal(result.oldSubjects.length, 1);
    assert.equal(result.newSubject?.registryKey, 'qwen-3-coder');
    assert.deepEqual(result.recertificationCommands, [
      'wavemill native-agent certifications re-certify --provider openrouter --model qwen-3-coder --phase patch',
    ]);
  }));

  it('writes identity audit artifacts atomically without temporary leftovers', () => withGlobalRoot((root) => {
    writeGlobalCertification(artifact());
    const plan = planIdentityAudit({
      operation: 'invalidate',
      provider: 'openrouter',
      model: 'qwen-3-coder',
      root,
      reason: 'manual-invalidation',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });

    const auditPath = writeIdentityAudit(root, { ...plan, dryRun: false });
    const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as {
      operation: string;
      dryRun: boolean;
      reason: string;
      affectedArtifactPaths: string[];
    };

    assert.equal(audit.operation, 'invalidate');
    assert.equal(audit.dryRun, false);
    assert.equal(audit.reason, 'manual-invalidation');
    assert.equal(audit.affectedArtifactPaths.length, 1);
    assert.equal(readdirSync(dirname(auditPath)).some((name) => name.includes('.tmp-')), false);
  }));
});
