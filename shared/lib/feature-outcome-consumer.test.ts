/**
 * Tests for feature-outcome-consumer module (HOK-2262).
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadFeatureOutcomeDiagnostics,
  type FeatureOutcomeReconstruction,
} from './feature-outcome-consumer.ts';

function makeFeatureState(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    derivedAt: '2026-06-19T12:00:00.000Z',
    issueId: 'HOK-9999',
    slug: 'my-feature',
    branch: 'task/my-feature',
    outcome: {
      completed: true,
      merged: true,
      ciPassed: true,
      reviewPassed: true,
      readyPassed: true,
      manualIntervention: false,
      interventionCount: 0,
      reverted: false,
      evalScore: 0.9,
      costUsd: 1.5,
      durationSeconds: 3600,
    },
    ...overrides,
  };
}

describe('feature-outcome-consumer', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'feature-outcome-consumer-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('valid feature-state.json', () => {
    it('returns present=true, valid=true, used=true with 64-char hash and normalized fields', () => {
      const featureDir = join(tmpDir, 'valid-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState();
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state, null, 2));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.present, true);
      assert.equal(diag.valid, true);
      assert.equal(diag.used, true);
      assert.equal(diag.sourceFile, 'feature-state.json');
      assert.ok(diag.sourceHash, 'sourceHash should be set');
      assert.equal(diag.sourceHash?.length, 64, 'SHA-256 hash should be 64 hex chars');
      assert.equal(diag.schemaVersion, '1.0');
      assert.equal(diag.reason, 'loaded');
      assert.equal(diag.eligibilityDiagnostic, 'eligible');
      assert.ok(!diag.missingFields || diag.missingFields.length === 0);
      assert.ok(!diag.invalidFields || diag.invalidFields.length === 0);

      const nf = diag.normalizedFields!;
      assert.equal(nf.completed, true);
      assert.equal(nf.merged, true);
      assert.equal(nf.ciPassed, true);
      assert.equal(nf.reviewPassed, true);
      assert.equal(nf.readyPassed, true);
      assert.equal(nf.manualIntervention, false);
      assert.equal(nf.interventionCount, 0);
      assert.equal(nf.evalScore, 0.9);
      assert.equal(nf.costUsd, 1.5);
      assert.equal(nf.durationSeconds, 3600);
    });
  });

  describe('missing artifact', () => {
    it('returns present=false without throwing', () => {
      const featureDir = join(tmpDir, 'missing-feature-dir');
      // Do not create the directory

      assert.doesNotThrow(() => {
        const diag = loadFeatureOutcomeDiagnostics({ featureDir });
        assert.equal(diag.present, false);
        assert.equal(diag.valid, false);
        assert.equal(diag.used, false);
        assert.equal(diag.reason, 'artifact_absent');
        assert.equal(diag.eligibilityDiagnostic, 'unknown');
      });
    });
  });

  describe('malformed artifact', () => {
    it('computes hash, present=true, valid=false, reason=malformed_json', () => {
      const featureDir = join(tmpDir, 'malformed-feature');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, 'feature-state.json'), 'this is not json }{');

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.present, true);
      assert.equal(diag.valid, false);
      assert.equal(diag.used, false);
      assert.equal(diag.reason, 'malformed_json');
      assert.equal(diag.eligibilityDiagnostic, 'unknown');
      assert.ok(diag.sourceHash, 'hash should still be computed');
      assert.equal(diag.sourceHash?.length, 64);
    });
  });

  describe('incomplete artifact', () => {
    it('reports missing fields and ineligible_missing_outcome', () => {
      const featureDir = join(tmpDir, 'incomplete-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState({
        outcome: {
          // Missing: merged, ciPassed, reviewPassed, readyPassed, manualIntervention,
          //          interventionCount, evalScore, costUsd, durationSeconds
          completed: true,
        },
      });
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.present, true);
      assert.equal(diag.valid, false);
      assert.equal(diag.reason, 'incomplete_outcome');
      assert.equal(diag.eligibilityDiagnostic, 'ineligible_missing_outcome');
      assert.ok(Array.isArray(diag.missingFields) && diag.missingFields.length > 0);
      assert.ok(diag.missingFields!.includes('merged'));
      assert.ok(diag.missingFields!.includes('ciPassed'));
      assert.ok(diag.missingFields!.includes('evalScore'));
    });

    it('missing fields are exact and stable', () => {
      const featureDir = join(tmpDir, 'incomplete2-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState({
        outcome: {
          completed: true,
          merged: null,
          // missing ciPassed, reviewPassed
          readyPassed: true,
          manualIntervention: false,
          interventionCount: 0,
          evalScore: 0.8,
          costUsd: 2.0,
          durationSeconds: 1800,
        },
      });
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.ok(diag.missingFields!.includes('ciPassed'));
      assert.ok(diag.missingFields!.includes('reviewPassed'));
      assert.ok(!diag.missingFields!.includes('merged'));
      assert.ok(!diag.missingFields!.includes('completed'));
    });
  });

  describe('conflict with reconstruction', () => {
    it('reports conflict=true with conflicting field listed', () => {
      const featureDir = join(tmpDir, 'conflict-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState(); // completed=true
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state));

      const reconstructed: FeatureOutcomeReconstruction = {
        completed: false, // conflict!
        merged: true,
        ciPassed: true,
      };

      const diag = loadFeatureOutcomeDiagnostics({ featureDir, reconstructed });

      assert.equal(diag.conflictsWithReconstruction, true);
      assert.ok(diag.conflictingFields!.includes('completed'));
      // merged and ciPassed match — not in conflicts
      assert.ok(!diag.conflictingFields!.includes('merged'));
    });

    it('does not overwrite reconstructed fields', () => {
      const featureDir = join(tmpDir, 'conflict2-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState({ outcome: { ...makeFeatureState().outcome, evalScore: 0.5 } });
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state));

      const reconstructed: FeatureOutcomeReconstruction = {
        evalScore: 0.9,
      };

      // Conflict is detected but reconstruction value is unchanged by the consumer
      const diag = loadFeatureOutcomeDiagnostics({ featureDir, reconstructed });
      assert.equal(diag.conflictsWithReconstruction, true);
      assert.ok(diag.conflictingFields!.includes('evalScore'));
      // Consumer only reports; it does not modify reconstruction
      assert.equal(reconstructed.evalScore, 0.9);
    });

    it('no conflict when absent on one side', () => {
      const featureDir = join(tmpDir, 'no-conflict-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState();
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state));

      const reconstructed: FeatureOutcomeReconstruction = {
        // No ciPassed provided — absence is not a conflict
      };

      const diag = loadFeatureOutcomeDiagnostics({ featureDir, reconstructed });
      assert.ok(!diag.conflictsWithReconstruction);
    });
  });

  describe('file alias priority', () => {
    it('feature-state.json wins over feature-outcome.json when both present', () => {
      const featureDir = join(tmpDir, 'alias-priority-feature');
      mkdirSync(featureDir, { recursive: true });

      const primaryState = makeFeatureState({ outcome: { ...makeFeatureState().outcome, evalScore: 0.9 } });
      const aliasState = makeFeatureState({ outcome: { ...makeFeatureState().outcome, evalScore: 0.1 } });

      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(primaryState));
      writeFileSync(join(featureDir, 'feature-outcome.json'), JSON.stringify(aliasState));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.sourceFile, 'feature-state.json');
      assert.equal(diag.normalizedFields?.evalScore, 0.9);
    });

    it('falls back to feature-outcome.json when feature-state.json is missing', () => {
      const featureDir = join(tmpDir, 'alias-only-feature');
      mkdirSync(featureDir, { recursive: true });

      const aliasState = makeFeatureState({ outcome: { ...makeFeatureState().outcome, evalScore: 0.7 } });
      writeFileSync(join(featureDir, 'feature-outcome.json'), JSON.stringify(aliasState));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.sourceFile, 'feature-outcome.json');
      assert.equal(diag.normalizedFields?.evalScore, 0.7);
    });
  });

  describe('archive directory fallback', () => {
    it('loads from archive when featureDir has no artifact', () => {
      const featureDir = join(tmpDir, 'no-artifact-feature');
      const archiveDir = join(tmpDir, 'archive-dir');
      mkdirSync(featureDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });

      const state = makeFeatureState();
      writeFileSync(join(archiveDir, 'feature-state.json'), JSON.stringify(state));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir, archiveDir });

      assert.equal(diag.present, true);
      assert.equal(diag.valid, true);
      assert.equal(diag.sourceFile, 'feature-state.json');
    });
  });

  describe('failed outcome artifact', () => {
    it('returns ineligible_failed_outcome when completed=false', () => {
      const featureDir = join(tmpDir, 'failed-outcome-feature');
      mkdirSync(featureDir, { recursive: true });
      const state = makeFeatureState({
        outcome: {
          ...makeFeatureState().outcome,
          completed: false,
        },
      });
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(state));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.valid, true);
      assert.equal(diag.eligibilityDiagnostic, 'ineligible_failed_outcome');
    });
  });

  describe('invalid root', () => {
    it('returns invalid_root when root is not a plain object', () => {
      const featureDir = join(tmpDir, 'invalid-root-feature');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify([1, 2, 3]));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.present, true);
      assert.equal(diag.valid, false);
      assert.equal(diag.reason, 'invalid_root');
      assert.equal(diag.eligibilityDiagnostic, 'unknown');
    });

    it('returns invalid_outcome when outcome field is missing', () => {
      const featureDir = join(tmpDir, 'no-outcome-feature');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify({ schemaVersion: '1.0' }));

      const diag = loadFeatureOutcomeDiagnostics({ featureDir });

      assert.equal(diag.present, true);
      assert.equal(diag.valid, false);
      assert.equal(diag.reason, 'invalid_outcome');
    });
  });
});
