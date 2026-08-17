import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildNativeCodingHandoff, firstNonEmpty } from './launch-native-review.ts';

describe('launch-native-review helpers', () => {
  it('ignores blank launcher context so required defaults remain available', () => {
    assert.equal(firstNonEmpty('', '   ', undefined, 'main'), 'main');
    assert.equal(firstNonEmpty('', undefined), undefined);
  });

  it('builds a compact native coding handoff from completion artifacts', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    try {
      writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
        stage: 'coding',
        status: 'completed',
        artifacts: {
          type: 'coding',
          filesChanged: 2,
          commitCount: 1,
        },
      }, null, 2));
      writeFileSync(join(featureDir, '.coding-complete'), '{"stage":"coding","confidence":"high"}\n');

      const handoff = buildNativeCodingHandoff(featureDir);

      assert.match(handoff, /Coding Stage Result/);
      assert.match(handoff, /"status": "completed"/);
      assert.match(handoff, /"commitCount": 1/);
      assert.match(handoff, /Coding Completion Marker/);
      assert.match(handoff, /Confidence: high/);
      assert.match(handoff, /```json/);
      assert.match(handoff, /"confidence":"high"/);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('includes blocked-completion handoff details when present', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    try {
      writeFileSync(join(featureDir, '.coding-blocked-completion.json'), JSON.stringify({
        schemaVersion: 1,
        stage: 'coding',
        status: 'blocked',
        reason: 'verification_blocked',
      }, null, 2));

      const handoff = buildNativeCodingHandoff(featureDir);

      assert.match(handoff, /Blocked Completion Handoff/);
      assert.match(handoff, /verification_blocked/);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });
});
