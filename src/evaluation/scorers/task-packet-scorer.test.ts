import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTaskPacketFeatures } from './task-packet-feature-extractor.ts';
import { scoreTaskPacket } from './task-packet-scorer.ts';
import { auc, mannWhitneyU } from './task-packet-stats.ts';

const packet = `## 1. Objective\nShip the scorer.\n## 2. Technical Context\n- \`src/example.ts\`\n## 3. Implementation Approach\nImplement it.\n## 4. Success Criteria\n- [REQ-F1] Works\n## 5. Implementation Constraints\nNo dependencies.\n## 6. Validation Steps\nValidation scenario: run unit test.\n\`\`\`bash\nnpm test -- scorer\n\`\`\`\n## 7. Definition of Done\n- [ ] Done\n## 8. Rollback Plan\nRevert.\n## 9. Release Readiness\nNone.\n## 10. Proposed Labels\nRisk: Low`;

test('extracts structured features and scores a complete packet', () => {
  const features = extractTaskPacketFeatures(packet);
  assert.equal(features.sections_present, 10); assert.equal(typeof features.difficulty, 'number');
  assert.equal(scoreTaskPacket(features).decision, 'run');
});
test('flags large scope for split and legacy packets for return', () => {
  const large = extractTaskPacketFeatures(`${packet}\n${Array.from({ length: 45 }, (_, i) => `- \`src/file-${i}.ts\` (new)`).join('\n')}${' x'.repeat(25000)}`);
  assert.equal(scoreTaskPacket(large).decision, 'split');
  assert.equal(scoreTaskPacket(extractTaskPacketFeatures('Make it better.')).decision, 'return');
});
test('statistics handle known ranking', () => {
  assert.equal(auc([.1, .9], [0, 1]), 1); assert.ok(mannWhitneyU([1, 2, 3], [9, 10, 11]).p < .1);
});
