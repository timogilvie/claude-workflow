import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isCodingCompleteConfidence,
  parseCodingComplete,
  serializeCodingComplete,
  validateCodingArtifacts,
  validateWholeFileWriteAllowlistInput,
} from './coding-artifacts.ts';

describe('coding-artifacts', () => {
  describe('validateCodingArtifacts', () => {
    it('accepts valid metric payloads', () => {
      const result = validateCodingArtifacts({
        type: 'coding',
        filesChanged: 3,
        linesAdded: 18,
        linesRemoved: 7,
        commitCount: 2,
      });

      assert.deepEqual(result, {
        ok: true,
        value: {
          type: 'coding',
          filesChanged: 3,
          linesAdded: 18,
          linesRemoved: 7,
          commitCount: 2,
        },
      });
    });

    it('rejects payloads with missing metric fields with shared codes', () => {
      const result = validateCodingArtifacts({ type: 'coding', filesChanged: 1 });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(
        result.errors.map((error) => ({ code: error.code, path: error.path })),
        [
          { code: 'MISSING_REQUIRED_FIELD', path: '$.linesAdded' },
          { code: 'MISSING_REQUIRED_FIELD', path: '$.linesRemoved' },
          { code: 'MISSING_REQUIRED_FIELD', path: '$.commitCount' },
        ],
      );
    });

    it('rejects negative and non-integer counts with deterministic codes', () => {
      const result = validateCodingArtifacts({
        type: 'coding',
        filesChanged: -1,
        linesAdded: 1.5,
        linesRemoved: Number.NaN,
        commitCount: '2',
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(
        result.errors.map((error) => ({ code: error.code, path: error.path })),
        [
          { code: 'INVALID_VALUE', path: '$.filesChanged' },
          { code: 'INVALID_FIELD_TYPE', path: '$.linesAdded' },
          { code: 'INVALID_FIELD_TYPE', path: '$.linesRemoved' },
          { code: 'INVALID_FIELD_TYPE', path: '$.commitCount' },
        ],
      );
    });
  });

  describe('coding-complete confidence', () => {
    it('accepts supported confidence values', () => {
      assert.equal(isCodingCompleteConfidence('high'), true);
      assert.equal(isCodingCompleteConfidence('medium'), true);
      assert.equal(isCodingCompleteConfidence('low'), true);
    });

    it('rejects unsupported confidence values', () => {
      assert.equal(isCodingCompleteConfidence('certain'), false);
      const result = parseCodingComplete('confidence=certain\n');
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.errors[0]?.code, 'INVALID_ENUM_VALUE');
    });

    it('parses JSON markers and preserves forward-compatible fields', () => {
      const result = parseCodingComplete('{"stage":"coding","confidence":"high","producer":"native-agent"}\n');
      assert.deepEqual(result, {
        ok: true,
        value: {
          stage: 'coding',
          confidence: 'high',
          producer: 'native-agent',
        },
      });

      assert.equal(
        serializeCodingComplete({
          stage: 'coding',
          confidence: 'low',
          producer: 'native-agent',
        }),
        '{\n  "stage": "coding",\n  "confidence": "low",\n  "producer": "native-agent"\n}\n',
      );
    });

    it('accepts legacy key=value markers through the shared normalizer', () => {
      const result = parseCodingComplete('confidence=high\nproducer=native-agent\n');
      assert.deepEqual(result, {
        ok: true,
        value: {
          stage: 'coding',
          confidence: 'high',
          producer: 'native-agent',
        },
      });
    });
  });

  describe('whole-file allowlist inputs', () => {
    it('normalizes generated and Wavemill-owned paths', () => {
      const result = validateWholeFileWriteAllowlistInput({
        generatedPaths: ['./dist/output.json'],
        wavemillOwnedPaths: ['shared/lib/ready-stage.ts'],
      });

      assert.deepEqual(result, {
        ok: true,
        value: {
          generatedPaths: ['dist/output.json'],
          wavemillOwnedPaths: ['shared/lib/ready-stage.ts'],
        },
      });
    });

    it('rejects invalid allowlist path boundaries', () => {
      const result = validateWholeFileWriteAllowlistInput({
        generatedPaths: ['../dist/output.json'],
        wavemillOwnedPaths: [42],
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(
        result.errors.map((error) => error.path),
        ['$.generatedPaths[0]', '$.wavemillOwnedPaths[0]'],
      );
    });
  });
});
