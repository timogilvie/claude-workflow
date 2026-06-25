import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acceptCodingCompletion,
  evaluateCompletionGate,
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

    it('rejects payloads with missing metric fields with per-field missing_field codes', () => {
      const result = validateCodingArtifacts({ type: 'coding', filesChanged: 1 });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(
        result.errors.map((error) => ({ code: error.code, path: error.path })),
        [
          { code: 'missing_field', path: '$.linesAdded' },
          { code: 'missing_field', path: '$.linesRemoved' },
          { code: 'missing_field', path: '$.commitCount' },
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
          { code: 'negative_value', path: '$.filesChanged' },
          { code: 'non_integer_value', path: '$.linesAdded' },
          { code: 'non_integer_value', path: '$.linesRemoved' },
          { code: 'non_integer_value', path: '$.commitCount' },
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

  describe('evaluateCompletionGate', () => {
    it('rejects when policy requires clean/committed tree and dirty entries are uncommitted', () => {
      const decision = evaluateCompletionGate({
        dirtyEntries: ['shared/lib/foo.ts'],
        allChangesCommitted: false,
        requiredChecksPassed: true,
        policy: { requireCleanOrCommitted: true },
      });

      assert.equal(decision.allowed, false);
      if (decision.allowed) return;
      assert.equal(decision.code, 'dirty_tree_uncommitted');
      assert.match(decision.detail, /shared\/lib\/foo\.ts/);
    });

    it('allows when tree is clean and required checks have passed', () => {
      const decision = evaluateCompletionGate({
        dirtyEntries: [],
        allChangesCommitted: true,
        requiredChecksPassed: true,
        policy: { requireCleanOrCommitted: true, requireChecksPassed: true },
      });

      assert.deepEqual(decision, { allowed: true });
    });

    it('allows dirty entries when policy accepts fully committed state', () => {
      const decision = evaluateCompletionGate({
        dirtyEntries: ['shared/lib/foo.ts'],
        allChangesCommitted: true,
        requiredChecksPassed: true,
        policy: { requireCleanOrCommitted: true },
      });

      assert.deepEqual(decision, { allowed: true });
    });

    it('rejects when required checks are not satisfied', () => {
      const decision = evaluateCompletionGate({
        dirtyEntries: [],
        allChangesCommitted: true,
        requiredChecksPassed: false,
        policy: { requireChecksPassed: true },
      });

      assert.equal(decision.allowed, false);
      if (decision.allowed) return;
      assert.equal(decision.code, 'checks_not_satisfied');
    });

    it('treats missing policy as gate disabled', () => {
      const decision = evaluateCompletionGate({
        dirtyEntries: ['shared/lib/foo.ts'],
        allChangesCommitted: false,
        requiredChecksPassed: false,
      });

      assert.deepEqual(decision, { allowed: true });
    });
  });

  describe('acceptCodingCompletion', () => {
    const validMarker = 'confidence=high\n';
    const validArtifacts = {
      type: 'coding',
      filesChanged: 1,
      linesAdded: 4,
      linesRemoved: 0,
      commitCount: 1,
    } as const;

    it('returns blocked when the completion gate rejects a dirty uncommitted tree', () => {
      const result = acceptCodingCompletion({
        marker: validMarker,
        artifacts: validArtifacts,
        gate: {
          dirtyEntries: ['shared/lib/foo.ts'],
          allChangesCommitted: false,
          requiredChecksPassed: true,
          policy: { requireCleanOrCommitted: true },
        },
      });

      assert.equal(result.status, 'blocked');
      if (result.status !== 'blocked') return;
      assert.equal(result.code, 'dirty_tree_uncommitted');
      assert.match(result.detail, /shared\/lib\/foo\.ts/);
    });

    it('returns blocked idempotently for repeated dirty calls', () => {
      const input = {
        marker: validMarker,
        artifacts: validArtifacts,
        gate: {
          dirtyEntries: ['shared/lib/foo.ts'],
          allChangesCommitted: false,
          requiredChecksPassed: true,
          policy: { requireCleanOrCommitted: true },
        },
      };

      const first = acceptCodingCompletion(input);
      const second = acceptCodingCompletion(input);
      assert.deepEqual(first, second);
    });

    it('accepts when the gate is satisfied and emits the parsed completion marker', () => {
      const result = acceptCodingCompletion({
        marker: validMarker,
        artifacts: validArtifacts,
        gate: {
          dirtyEntries: [],
          allChangesCommitted: true,
          requiredChecksPassed: true,
          policy: { requireCleanOrCommitted: true, requireChecksPassed: true },
        },
      });

      assert.equal(result.status, 'accepted');
      if (result.status !== 'accepted') return;
      assert.deepEqual(result.complete, { confidence: 'high' });
      assert.deepEqual(result.artifacts, validArtifacts);
    });

    it('returns invalid when the marker or artifacts do not parse', () => {
      const result = acceptCodingCompletion({
        marker: 'confidence=certain\n',
        artifacts: { type: 'coding' },
      });

      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') return;
      const codes = result.errors.map((e) => e.code);
      assert.ok(codes.includes('invalid_confidence'));
      assert.ok(codes.includes('missing_field'));
    });

    it('accepts when no gate is provided (additive default)', () => {
      const result = acceptCodingCompletion({
        marker: validMarker,
        artifacts: validArtifacts,
      });

      assert.equal(result.status, 'accepted');
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
