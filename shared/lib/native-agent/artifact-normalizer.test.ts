import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyVerificationEvidenceGuard,
  normalizeBlockedCompletion,
  normalizeCodingComplete,
  parseFlatYamlLike,
} from './artifact-normalizer.ts';
import type { BlockedCompletion } from '../blocked-completion.ts';

const validBlocked: BlockedCompletion = {
  stage: 'coding',
  implementationComplete: true,
  committed: true,
  passingChecks: ['npm test'],
  blockingChecks: ['npm run typecheck'],
  blockingReason: 'baseline_tests_failing',
  evidence: 'Scoped tests passed; baseline typecheck failed.',
  recommendedAction: 'advance_to_review',
};

describe('artifact-normalizer', () => {
  it('parses the supported flat YAML subset', () => {
    assert.deepEqual(parseFlatYamlLike(`
---
stage: coding
implementationComplete: true
committed: true
passingChecks: ["npm test", 'node smoke']
blockingChecks:
  - npm run typecheck
  - "npm run lint"
blockingReason: baseline_tests_failing # trailing comment
evidence: 'baseline failed'
recommendedAction: advance_to_review
`), {
      ...validBlocked,
      passingChecks: ['npm test', 'node smoke'],
      blockingChecks: ['npm run typecheck', 'npm run lint'],
      evidence: 'baseline failed',
    });
  });

  it('rejects ambiguous YAML shapes', () => {
    assert.equal(parseFlatYamlLike('stage: coding\nstage: coding\n'), null);
    assert.equal(parseFlatYamlLike('outer:\n  inner: value\n'), null);
    assert.equal(parseFlatYamlLike('items:\n- invalid\n'), null);
  });

  it('normalizes YAML blocked-completion artifacts to canonical JSON', () => {
    const normalized = normalizeBlockedCompletion(`
stage: coding
implementationComplete: true
committed: true
passingChecks:
  - npm test
blockingChecks: [npm run typecheck]
blockingReason: baseline_tests_failing
evidence: baseline failed
recommendedAction: advance_to_review
`);

    assert.equal(normalized.ok, true);
    if (normalized.ok) {
      assert.equal(normalized.normalizedFrom, 'yaml');
      assert.deepEqual(JSON.parse(normalized.canonicalJson), {
        ...validBlocked,
        evidence: 'baseline failed',
      });
    }
  });

  it('keeps strict JSON blocked-completion artifacts valid without marking normalization', () => {
    const normalized = normalizeBlockedCompletion(JSON.stringify(validBlocked));
    assert.equal(normalized.ok, true);
    if (normalized.ok) {
      assert.equal(normalized.normalizedFrom, undefined);
      assert.deepEqual(JSON.parse(normalized.canonicalJson), validBlocked);
    }
  });

  it('reports malformed blocked-completion payloads with existing error codes', () => {
    const normalized = normalizeBlockedCompletion('stage: coding\nnested:\n  value: no\n');
    assert.equal(normalized.ok, false);
    if (!normalized.ok) {
      assert.equal(normalized.code, 'MALFORMED_JSON');
    }
  });

  it('normalizes JSON and YAML coding-complete markers to key=value', () => {
    const fromJson = normalizeCodingComplete('{"confidence":"high","commit":"abc123","attempt":2}');
    assert.equal(fromJson.ok, true);
    if (fromJson.ok) {
      assert.equal(fromJson.normalizedFrom, 'json');
      assert.equal(fromJson.canonicalText, 'confidence=high\nattempt=2\ncommit=abc123\n');
    }

    const fromYaml = normalizeCodingComplete('confidence: medium\nproducer: native\nignored: [nested]\n');
    assert.equal(fromYaml.ok, true);
    if (fromYaml.ok) {
      assert.equal(fromYaml.normalizedFrom, 'yaml');
      assert.deepEqual(fromYaml.droppedFields, ['ignored']);
      assert.equal(fromYaml.canonicalText, 'confidence=medium\nproducer=native\n');
    }
  });

  it('keeps invalid coding-complete confidence failures structured', () => {
    const missing = normalizeCodingComplete('{"commit":"abc123"}');
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.errors[0]?.code, 'missing_confidence');
    }

    const invalid = normalizeCodingComplete('confidence: certain\n');
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.errors[0]?.code, 'invalid_confidence');
    }
  });

  it('downgrades completion claims without verification evidence', () => {
    assert.equal(applyVerificationEvidenceGuard(validBlocked, { verificationCommandsSucceeded: 1 }).coerced, false);

    const emptyChecks = applyVerificationEvidenceGuard(
      { ...validBlocked, passingChecks: [] },
      { verificationCommandsSucceeded: 1 },
    );
    assert.equal(emptyChecks.coerced, true);
    assert.equal(emptyChecks.reason, 'empty_passing_checks');
    assert.equal(emptyChecks.value.implementationComplete, false);

    const noRunner = applyVerificationEvidenceGuard(validBlocked, { verificationCommandsSucceeded: 0 });
    assert.equal(noRunner.coerced, true);
    assert.equal(noRunner.reason, 'no_successful_verification_commands');
    assert.equal(noRunner.value.implementationComplete, false);

    const alreadyFalse = applyVerificationEvidenceGuard(
      { ...validBlocked, implementationComplete: false, passingChecks: [] },
      { verificationCommandsSucceeded: 0 },
    );
    assert.equal(alreadyFalse.coerced, false);
    assert.equal(alreadyFalse.value.implementationComplete, false);
  });
});
