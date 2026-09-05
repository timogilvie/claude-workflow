import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { selectChallengeComparisonEvalEvidence } from './challenge-comparison-eval-evidence.ts';

const pairId = 'PAIR-COMPARE';
const primaryUrl = 'https://github.example/acme/wavemill/pull/10';
const challengerUrl = 'https://github.example/acme/wavemill/pull/11';
const primaryHead = 'a'.repeat(40);
const challengerHead = 'b'.repeat(40);

function row(input: Partial<EvalRecord>): EvalRecord {
  return {
    id: 'default', challengePairId: pairId, challengeSide: 'primary',
    prUrl: primaryUrl, evaluatedPrHeadSha: primaryHead, score: 0.8,
    timestamp: '2026-09-01T00:00:00.000Z', ...input,
  } as EvalRecord;
}

function select(records: EvalRecord[]) {
  return selectChallengeComparisonEvalEvidence({
    records, pairId,
    primary: { prUrl: primaryUrl, prNumber: '10', headSha: primaryHead },
    challenger: { prUrl: challengerUrl, prNumber: '11', headSha: challengerHead },
  });
}

describe('compare-prs current-head evidence', () => {
  it('makes readiness and execution consume the same current-head eval IDs', () => {
    const evidence = select([
      row({ id: 'primary-old-first', evaluatedPrHeadSha: 'c'.repeat(40) }),
      row({ id: 'primary-current-later', timestamp: '2026-09-02T00:00:00.000Z' }),
      row({ id: 'challenger-current', challengeSide: 'challenger', prUrl: challengerUrl,
        evaluatedPrHeadSha: challengerHead }),
    ]);
    assert.equal(evidence.hasRequiredEvalRecords, true);
    assert.equal(evidence.primary.ok, true);
    assert.equal(evidence.challenger.ok, true);
    if (evidence.primary.ok && evidence.challenger.ok) {
      // compare-prs reads these same objects after --check-only returns.
      assert.equal(evidence.primary.evalId, 'primary-current-later');
      assert.equal(evidence.challenger.evalId, 'challenger-current');
    }
  });

  it('refuses current-head absence before comparison side effects', () => {
    const evidence = select([
      row({ id: 'primary-old', evaluatedPrHeadSha: 'c'.repeat(40) }),
      row({ id: 'challenger-current', challengeSide: 'challenger', prUrl: challengerUrl,
        evaluatedPrHeadSha: challengerHead }),
    ]);
    assert.equal(evidence.hasRequiredEvalRecords, false);
    assert.equal(evidence.primary.ok, false);
    if (!evidence.primary.ok) assert.equal(evidence.primary.reason, 'old_head_only');
  });
});
