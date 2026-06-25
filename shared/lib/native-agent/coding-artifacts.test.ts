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

    it('accepts payloads with missing metric fields', () => {
      const result = validateCodingArtifacts({ type: 'coding' });
      assert.deepEqual(result, {
        ok: true,
        value: { type: 'coding' },
      });
    });

    it('rejects negative and non-integer counts', () => {
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
        result.errors.map((error) => error.path),
        ['$.filesChanged', '$.linesAdded', '$.linesRemoved', '$.commitCount'],
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
      assert.equal(result.errors[0]?.code, 'invalid_confidence');
    });

    it('parses the current marker format and preserves forward-compatible fields', () => {
      const result = parseCodingComplete('confidence=high\nproducer=native-agent\n');
      assert.deepEqual(result, {
        ok: true,
        value: {
          confidence: 'high',
          fields: {
            producer: 'native-agent',
          },
        },
      });

      assert.equal(
        serializeCodingComplete({
          confidence: 'low',
          fields: { producer: 'native-agent' },
        }),
        'confidence=low\nproducer=native-agent\n',
      );
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
