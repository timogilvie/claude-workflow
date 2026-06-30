import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type NativeCertificationArtifact,
} from './schema.ts';
import {
  type CertificationExpectations,
  checkIdentity,
  checkLimitations,
  checkNotExpired,
  checkPhaseSatisfies,
  checkScenarios,
  checkSchemaVersion,
  checkSuiteVersion,
  validateCertification,
} from './validator.ts';

const FIXTURE_DIR = new URL('./fixtures', import.meta.url).pathname;

function loadFixture(name: string): NativeCertificationArtifact {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as NativeCertificationArtifact;
}

const NOW = new Date('2026-06-30T00:00:00.000Z');

function defaultExpectations(record: NativeCertificationArtifact): CertificationExpectations {
  return {
    expectedProvider: record.provider,
    expectedModel: record.model,
    expectedSuiteVersion: record.suiteVersion,
    requiredPhase: 'read-only',
    now: NOW,
  };
}

// ─── validateCertification (full aggregate) ───────────────────────────────

describe('validateCertification', () => {
  it('valid-read-only fixture → ok', () => {
    const record = loadFixture('valid-read-only.json');
    const result = validateCertification(record, defaultExpectations(record));
    assert.ok(result.ok);
  });

  it('valid-patch fixture with requiredPhase read-only → ok', () => {
    const record = loadFixture('valid-patch.json');
    const expectations = { ...defaultExpectations(record), requiredPhase: 'read-only' as const };
    const result = validateCertification(record, expectations);
    assert.ok(result.ok);
  });

  it('valid-patch fixture with requiredPhase patch → ok', () => {
    const record = loadFixture('valid-patch.json');
    const expectations = { ...defaultExpectations(record), requiredPhase: 'patch' as const };
    const result = validateCertification(record, expectations);
    assert.ok(result.ok);
  });

  it('valid-expires-at fixture → ok', () => {
    const record = loadFixture('valid-expires-at.json');
    const result = validateCertification(record, defaultExpectations(record));
    assert.ok(result.ok);
  });

  it('stale-artifact fixture (derived TTL) → expired error with source=derived', () => {
    const record = loadFixture('stale-artifact.json');
    const result = validateCertification(record, defaultExpectations(record));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const expired = result.errors.find(e => e.code === 'expired');
      assert.ok(expired, 'should have expired error');
      assert.ok(expired!.message.includes('certifiedAt+ttl'));
      assert.equal(expired!.detail.source, 'derived');
    }
  });

  it('stale-expires-at fixture → expired error with source=expiresAt', () => {
    const record = loadFixture('stale-expires-at.json');
    const result = validateCertification(record, defaultExpectations(record));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const expired = result.errors.find(e => e.code === 'expired');
      assert.ok(expired, 'should have expired error');
      assert.equal(expired!.detail.source, 'expiresAt');
    }
  });

  it('boundary: now === expiresAt exactly → expired', () => {
    const record: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'read-only',
      suiteVersion: 'v1',
      certifiedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: NOW.toISOString(),
      scenarios: [{ scenarioId: 'list-files', passed: true }],
    };
    const result = validateCertification(record, defaultExpectations(record));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some(e => e.code === 'expired'));
    }
  });

  it('wrong-suite-version fixture → suite-version-mismatch', () => {
    const record = loadFixture('wrong-suite-version.json');
    const expectations = { ...defaultExpectations(record), expectedSuiteVersion: 'v1' };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some(e => e.code === 'suite-version-mismatch'));
    }
  });

  it('phase-insufficient fixture with requiredPhase patch → phase-insufficient', () => {
    const record = loadFixture('phase-insufficient.json');
    const expectations = { ...defaultExpectations(record), requiredPhase: 'patch' as const };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const err = result.errors.find(e => e.code === 'phase-insufficient');
      assert.ok(err);
      assert.equal(err!.detail.actual, 'read-only');
      assert.equal(err!.detail.required, 'patch');
    }
  });

  it('identity mismatch (provider) → identity-mismatch with detail.fields=[provider]', () => {
    const record = loadFixture('valid-read-only.json');
    const expectations = { ...defaultExpectations(record), expectedProvider: 'openai' };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const err = result.errors.find(e => e.code === 'identity-mismatch');
      assert.ok(err);
      assert.deepEqual(err!.detail.fields, ['provider']);
    }
  });

  it('identity mismatch (model) → identity-mismatch with detail.fields=[model]', () => {
    const record = loadFixture('valid-read-only.json');
    const expectations = { ...defaultExpectations(record), expectedModel: 'gpt-4' };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const err = result.errors.find(e => e.code === 'identity-mismatch');
      assert.ok(err);
      assert.deepEqual(err!.detail.fields, ['model']);
    }
  });

  it('identity mismatch (both) → one error with detail.fields=[provider, model]', () => {
    const record = loadFixture('valid-read-only.json');
    const expectations = {
      ...defaultExpectations(record),
      expectedProvider: 'openai',
      expectedModel: 'gpt-4',
    };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const identityErrors = result.errors.filter(e => e.code === 'identity-mismatch');
      assert.equal(identityErrors.length, 1, 'should produce exactly one identity-mismatch error');
      assert.deepEqual(identityErrors[0].detail.fields, ['provider', 'model']);
    }
  });

  it('identity comparison is case-sensitive', () => {
    const record = loadFixture('valid-read-only.json');
    // record.provider is 'anthropic'; 'Anthropic' should mismatch
    const expectations = { ...defaultExpectations(record), expectedProvider: 'Anthropic' };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some(e => e.code === 'identity-mismatch'));
    }
  });

  it('limitation conflict → limitation-conflict with detail.conflicting', () => {
    const record: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'read-only',
      suiteVersion: 'v1',
      certifiedAt: '2026-06-01T00:00:00.000Z',
      scenarios: [{ scenarioId: 'list-files', passed: true }],
      knownLimitations: ['long-context'],
    };
    const expectations: CertificationExpectations = {
      ...defaultExpectations(record),
      requiredCapabilities: ['long-context'],
    };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const err = result.errors.find(e => e.code === 'limitation-conflict');
      assert.ok(err);
      assert.deepEqual(err!.detail.conflicting, ['long-context']);
    }
  });

  it('no limitation conflict when required capabilities do not overlap', () => {
    const record: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'read-only',
      suiteVersion: 'v1',
      certifiedAt: '2026-06-01T00:00:00.000Z',
      scenarios: [{ scenarioId: 'list-files', passed: true }],
      knownLimitations: ['long-context'],
    };
    const expectations: CertificationExpectations = {
      ...defaultExpectations(record),
      requiredCapabilities: ['streaming'],
    };
    const result = validateCertification(record, expectations);
    assert.ok(result.ok);
  });

  it('no limitation error when requiredCapabilities not provided', () => {
    const record = loadFixture('valid-read-only.json');
    const expectations = defaultExpectations(record);
    // No requiredCapabilities
    const result = validateCertification(record, expectations);
    assert.ok(result.ok);
  });

  it('scenario-failure fixture → scenario-failure error with failed scenario IDs', () => {
    const record = loadFixture('scenario-failure.json');
    const result = validateCertification(record, defaultExpectations(record));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const err = result.errors.find(e => e.code === 'scenario-failure');
      assert.ok(err);
      assert.ok(Array.isArray(err!.detail.failedScenarioIds));
      assert.ok((err!.detail.failedScenarioIds as string[]).length > 0);
    }
  });

  it('aggregation: stale + wrong provider → 2 errors', () => {
    const record = loadFixture('stale-artifact.json');
    const expectations = { ...defaultExpectations(record), expectedProvider: 'openai' };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const codes = result.errors.map(e => e.code);
      assert.ok(codes.includes('expired'), `missing expired in: ${codes.join(', ')}`);
      assert.ok(codes.includes('identity-mismatch'), `missing identity-mismatch in: ${codes.join(', ')}`);
      assert.equal(result.errors.length, 2);
    }
  });

  it('aggregation: record failing all checks produces errors for every check', () => {
    // Construct a record that can fail all checks:
    // - schema version mismatch (cast)
    // - suite version mismatch
    // - expired (old certifiedAt, no expiresAt)
    // - phase insufficient (read-only, require workflow)
    // - identity mismatch (both provider and model)
    // - limitation conflict
    // - scenario failure
    const record: NativeCertificationArtifact = {
      schemaVersion: 999 as 1, // cast to trigger schema-version-mismatch
      provider: 'wrong-provider',
      model: 'wrong-model',
      phase: 'read-only',
      suiteVersion: 'wrong-suite',
      certifiedAt: '2020-01-01T00:00:00.000Z',
      scenarios: [{ scenarioId: 'failing', passed: false, failureMessage: 'boom' }],
      knownLimitations: ['long-context'],
    };
    const expectations: CertificationExpectations = {
      expectedProvider: 'anthropic',
      expectedModel: 'claude-sonnet-4-6',
      expectedSuiteVersion: 'v1',
      requiredPhase: 'workflow',
      requiredCapabilities: ['long-context'],
      now: NOW,
    };
    const result = validateCertification(record, expectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const codes = result.errors.map(e => e.code);
      assert.ok(codes.includes('schema-version-mismatch'), `codes: ${codes}`);
      assert.ok(codes.includes('suite-version-mismatch'), `codes: ${codes}`);
      assert.ok(codes.includes('expired'), `codes: ${codes}`);
      assert.ok(codes.includes('phase-insufficient'), `codes: ${codes}`);
      assert.ok(codes.includes('identity-mismatch'), `codes: ${codes}`);
      assert.ok(codes.includes('limitation-conflict'), `codes: ${codes}`);
      assert.ok(codes.includes('scenario-failure'), `codes: ${codes}`);
      assert.ok(result.errors.length >= 6, `expected >= 6 errors, got ${result.errors.length}`);
    }
  });

  it('expectations.now defaults to current date when omitted', () => {
    // A fresh artifact should pass when now is not provided
    const record: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'read-only',
      suiteVersion: 'v1',
      certifiedAt: new Date().toISOString(), // just now
      scenarios: [{ scenarioId: 'list-files', passed: true }],
    };
    const expectations: CertificationExpectations = {
      expectedProvider: 'anthropic',
      expectedModel: 'claude-sonnet-4-6',
      expectedSuiteVersion: 'v1',
      requiredPhase: 'read-only',
      // no now
    };
    const result = validateCertification(record, expectations);
    assert.ok(result.ok);
  });

  it('schema version mismatch → schema-version-mismatch error', () => {
    const record = loadFixture('valid-read-only.json');
    const bad = { ...record, schemaVersion: 2 as 1 };
    const result = validateCertification(bad, defaultExpectations(record));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some(e => e.code === 'schema-version-mismatch'));
    }
  });
});

// ─── Per-check helpers ────────────────────────────────────────────────────

describe('checkSchemaVersion', () => {
  it('returns null for matching version', () => {
    const record = loadFixture('valid-read-only.json');
    assert.equal(checkSchemaVersion(record), null);
  });

  it('returns error for mismatched version', () => {
    const record = { ...loadFixture('valid-read-only.json'), schemaVersion: 99 as 1 };
    const err = checkSchemaVersion(record);
    assert.ok(err);
    assert.equal(err!.code, 'schema-version-mismatch');
  });
});

describe('checkSuiteVersion', () => {
  it('returns null for matching suite version', () => {
    const record = loadFixture('valid-read-only.json');
    assert.equal(checkSuiteVersion(record, 'v1'), null);
  });

  it('returns suite-version-mismatch for wrong version', () => {
    const record = loadFixture('wrong-suite-version.json');
    const err = checkSuiteVersion(record, 'v1');
    assert.ok(err);
    assert.equal(err!.code, 'suite-version-mismatch');
    assert.ok(err!.message.includes('v0'));
    assert.ok(err!.message.includes('v1'));
  });
});

describe('checkNotExpired', () => {
  it('returns null for a fresh artifact (derived TTL)', () => {
    const record = loadFixture('valid-read-only.json');
    assert.equal(checkNotExpired(record, NOW), null);
  });

  it('returns null for a fresh artifact (explicit expiresAt in future)', () => {
    const record = loadFixture('valid-expires-at.json');
    assert.equal(checkNotExpired(record, NOW), null);
  });

  it('returns expired for stale artifact (derived TTL), source=derived', () => {
    const record = loadFixture('stale-artifact.json');
    const err = checkNotExpired(record, NOW);
    assert.ok(err);
    assert.equal(err!.code, 'expired');
    assert.equal(err!.detail.source, 'derived');
    assert.ok(err!.message.includes('certifiedAt+ttl'));
  });

  it('returns expired for stale artifact (past expiresAt), source=expiresAt', () => {
    const record = loadFixture('stale-expires-at.json');
    const err = checkNotExpired(record, NOW);
    assert.ok(err);
    assert.equal(err!.code, 'expired');
    assert.equal(err!.detail.source, 'expiresAt');
  });
});

describe('checkPhaseSatisfies', () => {
  it('returns null when phase satisfies requirement', () => {
    const record = loadFixture('valid-patch.json');
    assert.equal(checkPhaseSatisfies(record, 'read-only'), null);
    assert.equal(checkPhaseSatisfies(record, 'patch'), null);
  });

  it('returns phase-insufficient when phase is too low', () => {
    const record = loadFixture('phase-insufficient.json');
    const err = checkPhaseSatisfies(record, 'patch');
    assert.ok(err);
    assert.equal(err!.code, 'phase-insufficient');
    assert.equal(err!.detail.actual, 'read-only');
    assert.equal(err!.detail.required, 'patch');
  });
});

describe('checkIdentity', () => {
  it('returns null when both provider and model match', () => {
    const record = loadFixture('valid-read-only.json');
    assert.equal(checkIdentity(record, 'anthropic', 'claude-sonnet-4-6'), null);
  });

  it('returns error for provider mismatch', () => {
    const record = loadFixture('valid-read-only.json');
    const err = checkIdentity(record, 'openai', 'claude-sonnet-4-6');
    assert.ok(err);
    assert.equal(err!.code, 'identity-mismatch');
    assert.deepEqual(err!.detail.fields, ['provider']);
  });

  it('returns error for model mismatch', () => {
    const record = loadFixture('valid-read-only.json');
    const err = checkIdentity(record, 'anthropic', 'gpt-4');
    assert.ok(err);
    assert.equal(err!.code, 'identity-mismatch');
    assert.deepEqual(err!.detail.fields, ['model']);
  });

  it('returns one error with both fields when both mismatch', () => {
    const record = loadFixture('valid-read-only.json');
    const err = checkIdentity(record, 'openai', 'gpt-4');
    assert.ok(err);
    assert.equal(err!.code, 'identity-mismatch');
    assert.deepEqual(err!.detail.fields, ['provider', 'model']);
  });
});

describe('checkLimitations', () => {
  const recordWithLimitations: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    phase: 'read-only',
    suiteVersion: 'v1',
    certifiedAt: '2026-06-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 'list-files', passed: true }],
    knownLimitations: ['long-context'],
  };

  it('returns null when requiredCapabilities is undefined', () => {
    assert.equal(checkLimitations(recordWithLimitations, undefined), null);
  });

  it('returns null when requiredCapabilities is empty', () => {
    assert.equal(checkLimitations(recordWithLimitations, []), null);
  });

  it('returns null when no capabilities conflict', () => {
    assert.equal(checkLimitations(recordWithLimitations, ['streaming']), null);
  });

  it('returns limitation-conflict when capabilities intersect', () => {
    const err = checkLimitations(recordWithLimitations, ['long-context']);
    assert.ok(err);
    assert.equal(err!.code, 'limitation-conflict');
    assert.deepEqual(err!.detail.conflicting, ['long-context']);
  });

  it('comparison is case-sensitive', () => {
    // 'Long-Context' should not match 'long-context'
    assert.equal(checkLimitations(recordWithLimitations, ['Long-Context']), null);
  });
});

describe('checkScenarios', () => {
  it('returns null when all scenarios pass', () => {
    const record = loadFixture('valid-read-only.json');
    assert.equal(checkScenarios(record), null);
  });

  it('returns scenario-failure when a scenario failed', () => {
    const record = loadFixture('scenario-failure.json');
    const err = checkScenarios(record);
    assert.ok(err);
    assert.equal(err!.code, 'scenario-failure');
    assert.ok((err!.detail.failedScenarioIds as string[]).includes('read-file'));
  });

  it('returns scenario-failure for empty scenarios array', () => {
    const record: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'read-only',
      suiteVersion: 'v1',
      certifiedAt: '2026-06-01T00:00:00.000Z',
      scenarios: [],
    };
    const err = checkScenarios(record);
    assert.ok(err);
    assert.equal(err!.code, 'scenario-failure');
    assert.ok(err!.message.includes('no scenarios'));
  });
});
