import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndRepairJsonFromLlm } from './json-repair.ts';

describe('parseAndRepairJsonFromLlm', () => {
  it('passes through valid JSON', () => {
    const result = parseAndRepairJsonFromLlm<{ score: number }>('{ "score": 0.9 }');
    assert.equal(result.ok, true);
    assert.equal(result.value.score, 0.9);
    assert.equal(result.repaired, false);
  });

  it('repairs malformed string content inside wrappers', () => {
    const result = parseAndRepairJsonFromLlm<{ rationale: string }>(
      '```json\n{"score":0.6,"rationale":"Line one\nHe said "ship it" yesterday.","interventionFlags":[]}\n```'
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.rationale, 'Line one\nHe said "ship it" yesterday.');
    assert.equal(result.repaired, true);
  });

  it('rejects unrecoverable garbage', () => {
    const result = parseAndRepairJsonFromLlm('not json at all');
    assert.equal(result.ok, false);
    assert.match(result.errorSummary, /No JSON object found|Unexpected/);
  });
});
