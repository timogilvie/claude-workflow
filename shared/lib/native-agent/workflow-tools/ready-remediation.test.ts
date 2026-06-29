import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  computeRemediationScope,
  evaluateReadyRemediation,
  fromMergeConflictResult,
  fromStaleBaseCheck,
  type EvaluateReadyRemediationInput,
  type ReadyRemediationDecision,
} from './ready-remediation.ts';
import type { ReadyArtifacts } from '../../../stage-result.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'ready');

function loadFixture(name: string): { input: EvaluateReadyRemediationInput; expected: ReadyRemediationDecision } {
  const content = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf-8');
  return JSON.parse(content);
}

describe('ready-remediation: fixture-driven tests', () => {
  it('REQ-F1 stale-base allowed — fixture', () => {
    const { input, expected } = loadFixture('stale-base');
    const result = evaluateReadyRemediation(input);
    assert.deepEqual(result, expected);
  });

  it('REQ-F2 merge-conflict allowed — fixture (subset of conflicted files)', () => {
    const { input, expected } = loadFixture('conflict');
    const result = evaluateReadyRemediation(input);
    assert.deepEqual(result, expected);
  });

  it('REQ-F3 denied unrelated edit — fixture', () => {
    const { input, expected } = loadFixture('denied-unrelated-edit');
    const result = evaluateReadyRemediation(input);
    assert.deepEqual(result, expected);
    assert.equal(result.decision, 'denied');
    assert.ok(result.rejectedEdits.length > 0, 'rejectedEdits must be non-empty when denied');
    for (const rejected of result.rejectedEdits) {
      assert.ok(result.rationale.includes(rejected), `rationale must name rejected path ${rejected}`);
    }
  });
});

describe('ready-remediation: edge cases', () => {
  it('empty edit set → allowed with "no edits proposed" rationale', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'merge_conflict', affectedFiles: ['src/a.ts'] },
      proposedEdits: [],
    });
    assert.equal(result.decision, 'allowed');
    assert.equal(result.rationale, 'no edits proposed');
    assert.deepEqual(result.rejectedEdits, []);
  });

  it('REQ-F5 unknown classification → deny-all, empty scope', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'unknown', affectedFiles: [] },
      proposedEdits: ['src/anything.ts'],
    });
    assert.equal(result.decision, 'denied');
    assert.deepEqual(result.allowedScope, []);
    assert.ok(result.rejectedEdits.includes('src/anything.ts'));
    assert.ok(result.rationale.includes('src/anything.ts'));
  });

  it('unknown classification with empty edits → allowed (empty edit-set invariant)', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'unknown', affectedFiles: [] },
      proposedEdits: [],
    });
    assert.equal(result.decision, 'allowed');
    assert.equal(result.rationale, 'no edits proposed');
  });

  it('path traversal "../other/x.ts" → denied', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'merge_conflict', affectedFiles: ['src/a.ts'] },
      proposedEdits: ['src/a.ts', '../other/x.ts'],
    });
    assert.equal(result.decision, 'denied');
    assert.ok(result.rejectedEdits.includes('../other/x.ts'), 'traversal path must appear in rejectedEdits');
    assert.ok(result.rationale.includes('../other/x.ts'));
  });

  it('absolute path "/etc/passwd" → denied', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'merge_conflict', affectedFiles: ['src/a.ts'] },
      proposedEdits: ['/etc/passwd'],
    });
    assert.equal(result.decision, 'denied');
    assert.ok(result.rejectedEdits.includes('/etc/passwd'));
  });

  it('subset of conflict files → allowed', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'merge_conflict', affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
      proposedEdits: ['src/b.ts'],
    });
    assert.equal(result.decision, 'allowed');
    assert.deepEqual(result.rejectedEdits, []);
    assert.deepEqual(result.allowedScope, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('mixed in-scope and out-of-scope → only out-of-scope in rejectedEdits', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'merge_conflict', affectedFiles: ['src/a.ts'] },
      proposedEdits: ['src/a.ts', 'src/unrelated.ts', 'another.ts'],
    });
    assert.equal(result.decision, 'denied');
    assert.deepEqual(result.rejectedEdits.sort(), ['another.ts', 'src/unrelated.ts']);
    assert.ok(!result.rejectedEdits.includes('src/a.ts'), 'in-scope path must not appear in rejectedEdits');
  });

  it('stale_base with empty scope → deny all edits', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'stale_base', affectedFiles: [] },
      proposedEdits: ['x.ts'],
    });
    assert.equal(result.decision, 'denied');
    assert.deepEqual(result.allowedScope, []);
    assert.ok(result.rejectedEdits.includes('x.ts'));
  });

  it('stale_base with empty scope and empty edits → allowed (no-op rebase)', () => {
    const result = evaluateReadyRemediation({
      classification: { kind: 'stale_base', affectedFiles: [] },
      proposedEdits: [],
    });
    assert.equal(result.decision, 'allowed');
    assert.equal(result.rationale, 'no edits proposed');
  });
});

describe('ready-remediation: computeRemediationScope', () => {
  it('unknown → empty scope', () => {
    assert.deepEqual(computeRemediationScope({ kind: 'unknown', affectedFiles: ['x.ts'] }), []);
  });

  it('dedupes and sorts scope', () => {
    const scope = computeRemediationScope({
      kind: 'merge_conflict',
      affectedFiles: ['src/b.ts', 'src/a.ts', 'src/a.ts'],
    });
    assert.deepEqual(scope, ['src/a.ts', 'src/b.ts']);
  });

  it('filters unsafe paths from scope', () => {
    const scope = computeRemediationScope({
      kind: 'merge_conflict',
      affectedFiles: ['src/a.ts', '../escape.ts', '/absolute.ts'],
    });
    assert.deepEqual(scope, ['src/a.ts']);
  });
});

describe('ready-remediation: adapter helpers', () => {
  it('fromMergeConflictResult: CONFLICTED → merge_conflict classification', () => {
    const result = fromMergeConflictResult(
      { status: 'CONFLICTED', message: 'PR has merge conflicts', attempts: 1 },
      ['src/a.ts', 'src/b.ts']
    );
    assert.equal(result.kind, 'merge_conflict');
    assert.deepEqual(result.affectedFiles, ['src/a.ts', 'src/b.ts']);
    assert.equal(result.source, 'merge-conflict-result:CONFLICTED');
  });

  it('fromMergeConflictResult: non-CONFLICTED → unknown', () => {
    const result = fromMergeConflictResult(
      { status: 'CLEAN', message: 'No conflicts', attempts: 1 },
      []
    );
    assert.equal(result.kind, 'unknown');
    assert.equal(result.source, 'merge-conflict-result:CLEAN');
  });

  it('fromMergeConflictResult: UNKNOWN status → unknown classification', () => {
    const result = fromMergeConflictResult(
      { status: 'UNKNOWN', message: 'Still computing', attempts: 2 },
      []
    );
    assert.equal(result.kind, 'unknown');
  });

  it('fromStaleBaseCheck: returns stale_base classification', () => {
    const result = fromStaleBaseCheck(['alembic/versions/abc.py'], 'migration-base-freshness');
    assert.equal(result.kind, 'stale_base');
    assert.deepEqual(result.affectedFiles, ['alembic/versions/abc.py']);
    assert.equal(result.source, 'migration-base-freshness');
  });

  it('fromStaleBaseCheck: default source when omitted', () => {
    const result = fromStaleBaseCheck([]);
    assert.equal(result.kind, 'stale_base');
    assert.equal(result.source, 'stale-base-check');
  });
});

describe('REQ-F4: ReadyArtifacts stage-result wiring', () => {
  it('ReadyArtifacts accepts remediationDecision and survives JSON round-trip', () => {
    const decision: ReadyRemediationDecision = {
      decision: 'denied',
      classification: 'merge_conflict',
      allowedScope: ['src/a.ts'],
      rejectedEdits: ['src/feature-new.ts'],
      rationale: 'ready_remediation_denied: proposed edits are outside the merge_conflict remediation scope. Rejected: src/feature-new.ts',
    };

    const artifacts: ReadyArtifacts = {
      type: 'ready',
      verdict: 'fail',
      prNumber: 42,
      remediationDecision: decision,
    };

    const json = JSON.stringify(artifacts);
    const parsed = JSON.parse(json) as ReadyArtifacts;

    assert.deepEqual(parsed.remediationDecision, decision);
    assert.equal(parsed.verdict, 'fail');
    assert.equal(parsed.prNumber, 42);
  });

  it('ReadyArtifacts without remediationDecision remains backward-compatible', () => {
    const artifacts: ReadyArtifacts = {
      type: 'ready',
      verdict: 'pass',
    };
    assert.equal(artifacts.remediationDecision, undefined);
    const json = JSON.stringify(artifacts);
    const parsed = JSON.parse(json) as ReadyArtifacts;
    assert.equal(parsed.remediationDecision, undefined);
  });
});
