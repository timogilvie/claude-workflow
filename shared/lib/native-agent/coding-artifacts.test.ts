import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODING_ARTIFACTS_VERSION,
  CodingCompleteConfidence,
  validateCodingArtifacts,
  validateCodingResult,
} from './coding-artifacts.ts';

describe('coding artifacts validator', () => {
  it('accepts valid coding artifacts and coding result wrappers', () => {
    const artifacts = {
      filesChanged: 2,
      linesAdded: 12,
      linesRemoved: 4,
      commitCount: 1,
    };

    assert.deepEqual(validateCodingArtifacts(artifacts), { ok: true });
    assert.deepEqual(
      validateCodingResult({
        version: CODING_ARTIFACTS_VERSION,
        confidence: CodingCompleteConfidence.HIGH,
        artifacts,
      }),
      { ok: true },
    );
  });

  it('rejects negative artifact counts', () => {
    const result = validateCodingArtifacts({
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: -1,
      commitCount: 0,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['ARTIFACTS_NEGATIVE']);
    assert.equal(result.rejection.errors[0]?.field, 'linesRemoved');
  });

  it('rejects non-integer artifact counts', () => {
    const result = validateCodingArtifacts({
      filesChanged: 2.5,
      linesAdded: 2,
      linesRemoved: 1,
      commitCount: 0,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['ARTIFACTS_NON_INTEGER']);
    assert.equal(result.rejection.errors[0]?.field, 'filesChanged');
  });

  it('rejects unknown confidence values', () => {
    const result = validateCodingResult({
      version: CODING_ARTIFACTS_VERSION,
      confidence: 'maybe',
      artifacts: {
        filesChanged: 1,
        linesAdded: 2,
        linesRemoved: 3,
        commitCount: 0,
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['ARTIFACTS_UNKNOWN_CONFIDENCE']);
  });

  it('rejects missing artifact fields', () => {
    const result = validateCodingArtifacts({
      filesChanged: 1,
      linesAdded: 2,
      commitCount: 0,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['ARTIFACTS_FIELD_MISSING']);
    assert.equal(result.rejection.errors[0]?.field, 'linesRemoved');
  });

  it('rejects unknown wrapper versions', () => {
    const result = validateCodingResult({
      version: '2',
      confidence: CodingCompleteConfidence.LOW,
      artifacts: {
        filesChanged: 1,
        linesAdded: 2,
        linesRemoved: 3,
        commitCount: 4,
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['ARTIFACTS_UNKNOWN_VERSION']);
  });

  it('returns byte-identical validation results for the same malformed input', () => {
    const input = {
      version: 'broken',
      confidence: 'maybe',
      artifacts: {
        filesChanged: 1.5,
        linesAdded: -1,
      },
    };

    assert.equal(
      JSON.stringify(validateCodingResult(input)),
      JSON.stringify(validateCodingResult(input)),
    );
  });
});
