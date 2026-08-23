import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { scoreTaskPacket, testMonotonicity } from './task-packet-scorer.ts';
import type { TaskPacketFeatures } from './task-packet-feature-extractor.ts';

// Minimal valid feature vector
const MINIMAL_FEATURES: TaskPacketFeatures = {
  totalChars: 500,
  totalLines: 20,
  hasQuickReferenceHeader: false,
  sectionPresent1: true,
  sectionPresent2: true,
  sectionPresent3: true,
  sectionPresent4: true,
  sectionPresent5: true,
  sectionPresent6: true,
  sectionPresent7: false,
  sectionPresent8: false,
  sectionPresent9: false,
  sectionPresent10: false,
  sectionPresent11: false,
  sectionCount: 6,
  sectionLength1: 50,
  sectionLength2: 50,
  sectionLength3: 100,
  sectionLength4: 100,
  sectionLength5: 50,
  sectionLength6: 50,
  sectionLength7: 0,
  sectionLength8: 0,
  sectionLength9: 0,
  sectionLength10: 0,
  sectionLength11: 0,
  keyFileCount: 3,
  keyFilesMarkedNew: 0,
  reqTagCount: 3,
  validationScenarioCount: 2,
  validationCommandCount: 1,
  checkboxCount: 3,
  implementationStepCount: 5,
  scopeOutItems: 2,
  vaguenessMarkerCount: 0,
  hedgeWordRatio: 2,
  hasReleaseReadiness: false,
  proposedRisk: 'low',
  difficultyHeuristic: 1,
  complexityBand: 2,
  taskType: 'feature',
  descriptionWordCount: 150,
};

describe('task-packet-scorer', () => {
  describe('scoreTaskPacket', () => {
    it('returns a valid result with all required fields', () => {
      const result = scoreTaskPacket(MINIMAL_FEATURES);

      assert.strictEqual(typeof result.decision, 'string');
      assert.strictEqual(['run', 'expand', 'split', 'return'].includes(result.decision), true);
      assert.strictEqual(typeof result.confidence, 'number');
      assert.strictEqual(result.confidence >= 0 && result.confidence <= 1, true);
      assert.strictEqual(typeof result.explanation, 'string');
      assert.strictEqual(result.explanation.length > 0, true);
      assert.strictEqual(typeof result.interventionProbability, 'number');
      assert.strictEqual(result.interventionProbability >= 0 && result.interventionProbability <= 1, true);
      assert.strictEqual(typeof result.scorerId, 'string');
      assert.strictEqual(typeof result.modelVersion, 'string');
      assert.strictEqual(Array.isArray(result.topFeatures), true);
      assert.strictEqual(typeof result.scoredAt, 'string');
    });

    it('flags invalid packets', () => {
      const result = scoreTaskPacket(MINIMAL_FEATURES, { text: 'not a packet' });

      assert.strictEqual(result.decision, 'return');
      assert.strictEqual(result.confidence > 0.9, true);
    });

    it('flags packets with many missing sections', () => {
      const sparse = { ...MINIMAL_FEATURES, sectionCount: 1, sectionPresent1: true };
      const result = scoreTaskPacket(sparse);

      assert.strictEqual(
        ['return', 'expand'].includes(result.decision),
        true,
      );
      assert.strictEqual(result.interventionProbability > 0.5, true);
    });

    it('flags packets with high vagueness', () => {
      const vague = { ...MINIMAL_FEATURES, vaguenessMarkerCount: 10 };
      const result = scoreTaskPacket(vague);

      assert.strictEqual(result.interventionProbability > 0.5, true);
    });

    it('recommends split for large tasks', () => {
      const large = { ...MINIMAL_FEATURES, keyFileCount: 15, implementationStepCount: 20 };
      const result = scoreTaskPacket(large, { text: '## Objective\nBig task' });

      if (result.interventionProbability > 0.6) {
        assert.strictEqual(result.decision, 'split');
      }
    });

    it('recommends run for complete small packets', () => {
      const complete = {
        ...MINIMAL_FEATURES,
        sectionPresent7: true,
        sectionPresent8: true,
        sectionLength7: 100,
        sectionLength8: 100,
        sectionCount: 8,
      };
      const result = scoreTaskPacket(complete, { text: '## Objective\n' + 'x'.repeat(500) });

      assert.strictEqual(['run'].includes(result.decision), true);
    });

    it('confidence is low for borderline cases', () => {
      const borderline = { ...MINIMAL_FEATURES, vaguenessMarkerCount: 3 };
      const result = scoreTaskPacket(borderline);

      // Low confidence when intervention prob is near 0.5
      const isNearBoundary = Math.abs(result.interventionProbability - 0.5) < 0.1;
      if (isNearBoundary) {
        assert.strictEqual(result.confidence < 0.3, true);
      }
    });

    it('maintains monotonic relationship with vagueness', () => {
      assert.strictEqual(testMonotonicity(MINIMAL_FEATURES), true);
    });

    it('produces deterministic results', () => {
      const result1 = scoreTaskPacket(MINIMAL_FEATURES);
      const result2 = scoreTaskPacket(MINIMAL_FEATURES);

      assert.strictEqual(result1.decision, result2.decision);
      assert.strictEqual(result1.confidence, result2.confidence);
      assert.strictEqual(result1.interventionProbability, result2.interventionProbability);
    });

    it('handles extreme feature values gracefully', () => {
      const extreme = {
        ...MINIMAL_FEATURES,
        totalChars: 100000,
        keyFileCount: 100,
        vaguenessMarkerCount: 100,
      };
      const result = scoreTaskPacket(extreme);

      assert.strictEqual(['run', 'expand', 'split', 'return'].includes(result.decision), true);
    });
  });
});
