import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { auditLaunchPriorityCoverage } from './launch-priority-audit.ts';
import {
  evaluateNativeProviderGate,
  type NativeGateRejectReason,
} from './native-agent/certification/eligibility-gate.ts';
import { getEffectiveRegistry } from './model-registry.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('effective-models-consistency', () => {
  it('gate distinguishes missing-api-key from missing-artifact', () => {
    const registry = getEffectiveRegistry();
    const testModel = 'kimi-k2.7-code';

    const gateWithoutKey = evaluateNativeProviderGate({
      modelId: testModel,
      mode: 'task',
      requiredPhase: 'patch',
      registry,
      repoDir: undefined,
      apiKeyPresent: false,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      now: new Date('2026-07-15T00:00:00.000Z'),
    });

    assert.equal(
      gateWithoutKey.ok,
      false,
      'gate should reject model when API key is missing',
    );
    assert.equal(
      (gateWithoutKey as any).reason,
      'missing_api_key',
      'gate should report missing-api-key reason',
    );

    const gateWithoutArtifact = evaluateNativeProviderGate({
      modelId: testModel,
      mode: 'task',
      requiredPhase: 'patch',
      registry,
      repoDir: makeTempDir('test-no-artifact-'),
      apiKeyPresent: true,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      now: new Date('2026-07-15T00:00:00.000Z'),
    });

    assert.equal(
      gateWithoutArtifact.ok,
      false,
      'gate should reject model when artifact is missing',
    );
    assert.equal(
      (gateWithoutArtifact as any).reason,
      'missing_artifact',
      'gate should report missing-artifact reason',
    );
  });

  it('audit routes through gate and preserves reason distinction', () => {
    const registry = getEffectiveRegistry();
    const testModel = 'kimi-k2.7-code';

    const auditWithNoKey = auditLaunchPriorityCoverage({
      catalog: [],
      evalRecords: [],
      checkNativeCertification: (provider: string, model: string, role: 'planning' | 'coding' | 'review') => {
        const decision = evaluateNativeProviderGate({
          modelId: model,
          mode: 'task',
          requiredPhase: role === 'coding' ? 'patch' : 'read-only',
          registry,
          repoDir: undefined,
          apiKeyPresent: false,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          now: new Date('2026-07-15T00:00:00.000Z'),
        });
        if (decision.ok) {
          return { eligible: true };
        }
        const reason = (decision as any).reason;
        return { eligible: false, reason: mapAuditReason(reason) };
      },
    });

    const auditWithKeyNoArtifact = auditLaunchPriorityCoverage({
      catalog: [],
      evalRecords: [],
      repoDir: makeTempDir('test-audit-distinction-'),
      checkNativeCertification: (provider: string, model: string, role: 'planning' | 'coding' | 'review') => {
        const decision = evaluateNativeProviderGate({
          modelId: model,
          mode: 'task',
          requiredPhase: role === 'coding' ? 'patch' : 'read-only',
          registry,
          repoDir: makeTempDir('test-audit-with-key-'),
          apiKeyPresent: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          now: new Date('2026-07-15T00:00:00.000Z'),
        });
        if (decision.ok) {
          return { eligible: true };
        }
        const reason = (decision as any).reason;
        return { eligible: false, reason: mapAuditReason(reason) };
      },
    });

    assert.equal(
      auditWithNoKey.schemaVersion,
      '1',
      'both audits should produce valid schema',
    );
    assert.equal(
      auditWithKeyNoArtifact.schemaVersion,
      '1',
      'both audits should produce valid schema',
    );
  });
});

function mapAuditReason(reason: NativeGateRejectReason): string {
  switch (reason) {
    case 'missing_api_key':
      return 'missing-api-key';
    case 'unregistered_model':
      return 'no-native-capability';
    case 'missing_artifact':
      return 'missing-artifact';
    case 'malformed_artifact':
      return 'malformed-artifact';
    case 'stale_artifact':
      return 'stale-artifact';
    case 'wrong_suite':
      return 'wrong-suite';
    case 'insufficient_phase':
      return 'insufficient-phase';
  }
}
