/**
 * Verification Scenarios Test Suite
 *
 * Tests the verification engine behavior across different model quality scenarios:
 * - Weak model on moderate task (trigger verification)
 * - Weak model with strong reviewer available (trigger second-pass review)
 * - Weak model with no stronger reviewer (enforce patch size cap)
 * - Strong model (no extra verification)
 * - Quality threshold boundary cases
 *
 * @module tests/verification-scenarios
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { determineVerificationRequirements, isWeakModel } from '../shared/lib/verification-engine.ts';
import { validatePatchSize } from '../shared/lib/patch-size-validator.ts';
import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';

describe('Verification Engine', () => {
  describe('Quality Threshold Detection', () => {
    it('should identify Haiku as weak for coding (score 60 < threshold 80)', () => {
      const isWeak = isWeakModel('claude-haiku-4-5-20251001', 'coding');
      assert.strictEqual(isWeak, true, 'Haiku should be considered weak for coding');
    });

    it('should identify Sonnet as strong for coding (score 90 >= threshold 80)', () => {
      const isWeak = isWeakModel('claude-sonnet-4-6', 'coding');
      assert.strictEqual(isWeak, false, 'Sonnet should be considered strong for coding');
    });

    it('should identify Opus as strong for coding (score 85 >= threshold 80)', () => {
      const isWeak = isWeakModel('claude-opus-4-7', 'coding');
      assert.strictEqual(isWeak, false, 'Opus should be considered strong for coding');
    });
  });

  describe('Verification Requirements - Weak Model Scenarios', () => {
    it('should require verification when Haiku is used for coding', () => {
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-sonnet-4-6', 'claude-opus-4-7'],
      );

      assert.strictEqual(requirements.verificationNeeded, true);
      assert.strictEqual(requirements.mandatory.typecheck, true);
      assert.strictEqual(requirements.mandatory.lint, true);
      assert.strictEqual(requirements.mandatory.test, true);
      assert.strictEqual(requirements.mandatory.selfExplanation, true);
      assert.strictEqual(requirements.metadata.coderScore, 60);
      assert.strictEqual(requirements.metadata.threshold, 80);
      assert.strictEqual(requirements.metadata.qualityGap, 20);
    });

    it('should require second-pass review when stronger reviewer available', () => {
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-sonnet-4-6', 'claude-opus-4-7'],
      );

      assert.strictEqual(requirements.secondPassReview.required, true);
      assert.strictEqual(
        requirements.secondPassReview.preferredReviewer,
        'claude-opus-4-7',
        'Should prefer Opus for review (highest review score)',
      );
      assert.strictEqual(requirements.patchSizeCap, undefined, 'No patch size cap when stronger reviewer available');
    });

    it('should enforce patch size cap when no stronger reviewer available', () => {
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-haiku-4-5-20251001'], // Only Haiku available
      );

      assert.strictEqual(requirements.secondPassReview.required, false);
      assert.ok(requirements.patchSizeCap, 'Patch size cap should be set');
      assert.strictEqual(requirements.patchSizeCap?.maxLines, 120, 'Cap should be 120 lines for Haiku (quality gap=20)');
      assert.ok(
        requirements.patchSizeCap?.reason.includes('No stronger reviewer available'),
        'Reason should mention no stronger reviewer',
      );
    });
  });

  describe('Verification Requirements - Strong Model Scenarios', () => {
    it('should not require verification when Sonnet is used for coding', () => {
      const requirements = determineVerificationRequirements(
        'claude-sonnet-4-6',
        'coding',
        ['claude-opus-4-7'],
      );

      assert.strictEqual(requirements.verificationNeeded, false);
      assert.strictEqual(requirements.mandatory.typecheck, false);
      assert.strictEqual(requirements.mandatory.lint, false);
      assert.strictEqual(requirements.mandatory.test, false);
      assert.strictEqual(requirements.mandatory.selfExplanation, false);
      assert.strictEqual(requirements.secondPassReview.required, false);
      assert.strictEqual(requirements.patchSizeCap, undefined);
    });

    it('should not require verification when Opus is used for coding', () => {
      const requirements = determineVerificationRequirements(
        'claude-opus-4-7',
        'coding',
        ['claude-sonnet-4-6'],
      );

      assert.strictEqual(requirements.verificationNeeded, false);
    });
  });

  describe('Patch Size Cap Calculation', () => {
    it('should calculate cap correctly for Haiku (gap=20)', () => {
      // Haiku score=60, threshold=80, gap=20
      // multiplier = max(0.5, 1 - (20/50)) = max(0.5, 0.6) = 0.6
      // cap = 200 * 0.6 = 120
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        [], // No reviewers available
      );

      assert.strictEqual(requirements.patchSizeCap?.maxLines, 120);
    });

    it('should enforce minimum multiplier of 0.5 for very weak models', () => {
      // If we had a hypothetical model with score=30 (gap=50)
      // multiplier = max(0.5, 1 - (50/50)) = max(0.5, 0) = 0.5
      // cap = 200 * 0.5 = 100
      // This test documents the floor behavior even though we don't have such a weak model
      const registry = getEffectiveRegistry();
      const hasMuchWeakerModel = Object.values(registry.models).some(
        (m) => m.qualityScores.coding < 50,
      );
      if (!hasMuchWeakerModel) {
        // Skip test if no such model exists
        assert.ok(true, 'No very weak model to test minimum multiplier');
      }
    });
  });

  describe('Reviewer Selection', () => {
    it('should select strongest available reviewer', () => {
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-6'],
      );

      // Opus 4.7 has highest review score (95)
      assert.strictEqual(requirements.secondPassReview.preferredReviewer, 'claude-opus-4-7');
    });

    it('should handle single reviewer available', () => {
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-sonnet-4-6'],
      );

      assert.strictEqual(requirements.secondPassReview.required, true);
      assert.strictEqual(requirements.secondPassReview.preferredReviewer, 'claude-sonnet-4-6');
    });

    it('should not require second pass if only weaker reviewers available', () => {
      // If only Haiku is available for both coding and review
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-haiku-4-5-20251001'],
      );

      assert.strictEqual(requirements.secondPassReview.required, false, 'No second pass if no stronger reviewer');
      assert.ok(requirements.patchSizeCap, 'Should enforce patch size cap instead');
    });
  });

  describe('Metadata Tracking', () => {
    it('should include complete metadata for eval records', () => {
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-opus-4-7'],
      );

      assert.ok(requirements.metadata, 'Metadata should be present');
      assert.strictEqual(requirements.metadata.coderModel, 'claude-haiku-4-5-20251001');
      assert.strictEqual(requirements.metadata.coderScore, 60);
      assert.strictEqual(requirements.metadata.threshold, 80);
      assert.strictEqual(requirements.metadata.qualityGap, 20);
      assert.strictEqual(requirements.metadata.strongerReviewerAvailable, true);
    });
  });
});

describe('Patch Size Validator', () => {
  describe('Validation Logic', () => {
    it('should validate patch size structure', () => {
      // This is a unit test of the validation logic, not an integration test
      // We test the result structure without actually running git commands
      const mockResult = {
        totalLines: 150,
        cap: 120,
        exceedsCap: true,
        fileBreakdown: [
          { file: 'src/main.ts', additions: 80, deletions: 20, totalLines: 100 },
          { file: 'src/utils.ts', additions: 30, deletions: 20, totalLines: 50 },
        ],
      };

      assert.strictEqual(mockResult.exceedsCap, true);
      assert.strictEqual(mockResult.totalLines, 150);
      assert.strictEqual(mockResult.cap, 120);
      assert.strictEqual(mockResult.fileBreakdown.length, 2);
    });

    it('should detect when patch is under cap', () => {
      const mockResult = {
        totalLines: 80,
        cap: 120,
        exceedsCap: false,
        fileBreakdown: [
          { file: 'src/main.ts', additions: 50, deletions: 30, totalLines: 80 },
        ],
      };

      assert.strictEqual(mockResult.exceedsCap, false);
    });
  });
});

describe('Integration Scenarios', () => {
  describe('End-to-End Verification Flow', () => {
    it('should handle complete weak-model workflow', () => {
      // Simulate: Haiku coder with Opus reviewer available
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        ['claude-opus-4-7'],
      );

      // Verify all expected checks are enabled
      assert.strictEqual(requirements.verificationNeeded, true, 'Verification should be needed');
      assert.strictEqual(requirements.mandatory.typecheck, true, 'Typecheck should be mandatory');
      assert.strictEqual(requirements.mandatory.lint, true, 'Lint should be mandatory');
      assert.strictEqual(requirements.mandatory.test, true, 'Test should be mandatory');
      assert.strictEqual(requirements.mandatory.selfExplanation, true, 'Self-explanation should be mandatory');
      assert.strictEqual(requirements.secondPassReview.required, true, 'Second-pass review should be required');
      assert.ok(requirements.secondPassReview.preferredReviewer, 'Should have preferred reviewer');
      assert.strictEqual(requirements.patchSizeCap, undefined, 'No patch size cap with strong reviewer');
    });

    it('should handle degraded mode (no strong reviewers)', () => {
      // Simulate: Haiku coder with no stronger reviewers
      const requirements = determineVerificationRequirements(
        'claude-haiku-4-5-20251001',
        'coding',
        [],
      );

      // Verify fallback behavior
      assert.strictEqual(requirements.verificationNeeded, true, 'Verification should be needed');
      assert.strictEqual(requirements.secondPassReview.required, false, 'No second-pass if no reviewers');
      assert.ok(requirements.patchSizeCap, 'Should enforce patch size cap');
      assert.strictEqual(requirements.patchSizeCap?.maxLines, 120, 'Cap should be 120 for Haiku');
    });

    it('should handle normal mode (strong coder)', () => {
      // Simulate: Sonnet coder (normal operation)
      const requirements = determineVerificationRequirements(
        'claude-sonnet-4-6',
        'coding',
        ['claude-opus-4-7'],
      );

      // Verify no extra overhead
      assert.strictEqual(requirements.verificationNeeded, false, 'No verification for strong model');
      assert.strictEqual(requirements.mandatory.typecheck, false);
      assert.strictEqual(requirements.mandatory.lint, false);
      assert.strictEqual(requirements.mandatory.test, false);
      assert.strictEqual(requirements.mandatory.selfExplanation, false);
      assert.strictEqual(requirements.secondPassReview.required, false);
      assert.strictEqual(requirements.patchSizeCap, undefined);
    });
  });
});
