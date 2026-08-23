import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFeaturesFromText, extractTaskPacketFeatures, TaskPacketNotFoundError } from './task-packet-feature-extractor.ts';

const SAMPLE_PACKET = `# Task Scorer: predict whether a task packet is ready

## Objective

Build a scoring system to predict task readiness.

## Technical Context

This is the technical context section with implementation details.

## Implementation Approach

1. Step one
2. Step two
3. Step three

## Success Criteria

- [x] Criterion one
- [ ] Criterion two
- [x] Criterion three

## Constraints

The implementation must follow these constraints:
- Constraint A
- Constraint B

## Validation Steps

**Validation scenario:** Test scenario A

\`\`\`bash
npm test
\`\`\`

## Definition of Done

- [x] All requirements met
- [ ] Documentation complete

## Rollback Plan

Simple rollback process.

## Release Readiness

- database_change_risk: low
- manual_steps: none

## Proposed Labels

Risk: medium
Area: Feature
`;

const LEGACY_PACKET = `# Legacy Task

## 1. Objective

Build something.

## 2. Technical Context

Technical details here.

## 3. Implementation Approach

1. First step
2. Second step

## 4. Success Criteria

- [x] Success criterion

## 5. Constraints

Key constraints here.

## 6. Validation Steps

Test the implementation.

## 7. Definition of Done

Mark as done.

## 8. Rollback Plan

How to roll back.

## 9. Release Readiness

No changes needed.
`;

const PACKET_WITH_FENCED_COMMENTS = `# Task with Fenced Code

## Objective

Implement the feature.

\`\`\`bash
# 1. Lint passes
# 2. Build succeeds
npm run lint
\`\`\`

## Validation Steps

This heading should still be detected even though there are fenced code blocks above.
`;

describe('task-packet-feature-extractor', () => {
  describe('extractFeaturesFromText', () => {
    it('extracts features from current-format packet', () => {
      const features = extractFeaturesFromText(SAMPLE_PACKET);

      assert.strictEqual(typeof features.totalChars, 'number');
      assert.strictEqual(features.totalChars > 0, true);
      assert.strictEqual(typeof features.totalLines, 'number');
      assert.strictEqual(features.sectionCount > 0, true);
      assert.strictEqual(features.reqTagCount >= 0, true);
      assert.strictEqual(features.checkboxCount > 0, true);
      assert.strictEqual(features.implementationStepCount, 3);
      assert.strictEqual(features.hasReleaseReadiness, true);
      assert.strictEqual(features.proposedRisk, 'medium');
      assert.strictEqual(features.difficultyHeuristic >= 0 && features.difficultyHeuristic <= 3, true);
      assert.strictEqual(features.complexityBand >= 0 && features.complexityBand <= 4, true);
    });

    it('extracts features from legacy 9-section packet', () => {
      const features = extractFeaturesFromText(LEGACY_PACKET);

      assert.strictEqual(features.totalChars > 0, true);
      assert.strictEqual(features.sectionCount > 0, true);
      assert.strictEqual(features.sectionPresent1, true);
      assert.strictEqual(features.sectionPresent2, true);
      assert.strictEqual(features.sectionPresent9, true);
    });

    it('handles packet with fenced code comments', () => {
      const features = extractFeaturesFromText(PACKET_WITH_FENCED_COMMENTS);

      // Should not count lines within fenced blocks as headings
      assert.strictEqual(features.totalChars > 0, true);
      assert.strictEqual(features.sectionCount >= 2, true);
    });

    it('counts sections correctly', () => {
      const features = extractFeaturesFromText(SAMPLE_PACKET);

      const presentSections = [
        features.sectionPresent1,
        features.sectionPresent2,
        features.sectionPresent3,
        features.sectionPresent4,
        features.sectionPresent5,
        features.sectionPresent6,
        features.sectionPresent7,
        features.sectionPresent8,
        features.sectionPresent9,
        features.sectionPresent10,
        features.sectionPresent11,
      ].filter((b) => b).length;

      assert.strictEqual(presentSections, features.sectionCount);
    });

    it('extracts section lengths', () => {
      const features = extractFeaturesFromText(SAMPLE_PACKET);

      // Objective section should have some length
      assert.strictEqual(features.sectionLength1 > 0, true);
    });

    it('handles missing sections with zero length', () => {
      const minimalPacket = `# Task\n## Objective\nSimple task\n`;
      const features = extractFeaturesFromText(minimalPacket);

      // Missing sections should have zero length
      assert.strictEqual(features.sectionLength2, 0);
      assert.strictEqual(features.sectionLength3, 0);
    });

    it('returns a vector even for invalid packet', () => {
      const invalidPacket = 'just some random text with no sections';
      const features = extractFeaturesFromText(invalidPacket);

      // Should return a valid feature vector with all zero sections
      assert.strictEqual(features.sectionCount, 0);
      assert.strictEqual(features.totalChars > 0, true);
    });

    it('extracts complexity and difficulty controls', () => {
      const features = extractFeaturesFromText(SAMPLE_PACKET, {
        title: 'Sample Task',
      });

      assert.strictEqual(typeof features.difficultyHeuristic, 'number');
      assert.strictEqual(typeof features.complexityBand, 'number');
      assert.strictEqual(typeof features.taskType, 'string');
      assert.strictEqual(typeof features.descriptionWordCount, 'number');
    });
  });

  describe('extractTaskPacketFeatures', () => {
    it('throws TaskPacketNotFoundError for non-existent path', () => {
      assert.throws(
        () => extractTaskPacketFeatures('/nonexistent/path/to/packet.md'),
        TaskPacketNotFoundError,
      );
    });

    it('throws with correct error code', () => {
      try {
        extractTaskPacketFeatures('/nonexistent/path');
        assert.fail('Should have thrown');
      } catch (err) {
        if (err instanceof TaskPacketNotFoundError) {
          assert.strictEqual(err.code, 'ENOENT');
        } else {
          throw err;
        }
      }
    });

    it('rejects non-packet content', () => {
      const testFile = join(tmpdir(), `test-non-packet-${Date.now()}.txt`);
      writeFileSync(testFile, 'this is just random text\nnot a packet\n');

      try {
        assert.throws(() => extractTaskPacketFeatures(testFile), TaskPacketNotFoundError);
      } finally {
        unlinkSync(testFile);
      }
    });
  });
});
