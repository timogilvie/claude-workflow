/**
 * Ready-remediation adapter → evaluator pipeline integration tests (HOK-2362_c, deliverable #3).
 *
 * Tests the full pipeline: adapter (fromStaleBaseCheck / fromMergeConflictResult)
 * feeds into evaluateReadyRemediation, driven by fixture data.
 *
 * Unlike ready-remediation.test.ts (which calls evaluateReadyRemediation directly),
 * these tests exercise the complete path a real caller would take:
 *   raw source data → adapter → ReadyRemediationClassification → evaluator → decision
 *
 * Fixture coverage:
 *   stale-base.json              — stale-base allowed (all edits in scope)
 *   stale-base-denied.json       — stale-base denied (out-of-scope edit)
 *   conflict.json                — merge-conflict allowed (subset of conflicted files)
 *   denied-unrelated-edit.json   — merge-conflict denied (unrelated feature file)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  evaluateReadyRemediation,
  fromMergeConflictResult,
  fromStaleBaseCheck,
  type EvaluateReadyRemediationInput,
  type ReadyRemediationDecision,
} from './ready-remediation.ts';
import type { MergeConflictResult } from '../../ready-stage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'ready');

// Fixture format shared by stale-base.json and conflict.json / denied-unrelated-edit.json
interface StandardFixture {
  description: string;
  input: EvaluateReadyRemediationInput;
  expected: ReadyRemediationDecision;
}

// Fixture format for stale-base-denied.json (raw source data + adapter path)
interface StaleBaseDeniedFixture {
  description: string;
  raw: { affectedFiles: string[]; source: string };
  proposedEdits: string[];
  expected: ReadyRemediationDecision;
}

function loadFixture<T>(name: string): T {
  const content = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf-8');
  return JSON.parse(content) as T;
}

function conflictedResult(affectedFiles: string[]): { result: MergeConflictResult; conflictedFiles: string[] } {
  return {
    result: { status: 'CONFLICTED', message: 'merge conflict detected', attempts: 1 },
    conflictedFiles: affectedFiles,
  };
}

// ---------------------------------------------------------------------------
// Stale-base pipeline: fromStaleBaseCheck → evaluateReadyRemediation
// ---------------------------------------------------------------------------

describe('ready-remediation-integration: stale-base adapter pipeline', () => {
  it('allowed: fromStaleBaseCheck(affectedFiles) → evaluateReadyRemediation → allowed decision (stale-base.json)', () => {
    const fixture = loadFixture<StandardFixture>('stale-base');

    // Build classification via adapter — this is what a real caller does
    const classification = fromStaleBaseCheck(
      fixture.input.classification.affectedFiles,
      fixture.input.classification.source,
    );

    assert.equal(classification.kind, 'stale_base', 'pipeline: adapter must produce stale_base kind');
    assert.deepEqual(
      classification.affectedFiles,
      fixture.input.classification.affectedFiles,
      'pipeline: adapter must preserve affectedFiles',
    );

    const decision = evaluateReadyRemediation({
      classification,
      proposedEdits: fixture.input.proposedEdits,
    });

    assert.deepEqual(decision, fixture.expected, 'pipeline: stale-base allowed decision must match fixture exactly');
    assert.equal(decision.decision, 'allowed', 'pipeline: stale-base in-scope edits must be allowed');
    assert.deepEqual(decision.rejectedEdits, [], 'pipeline: stale-base allowed path must have no rejected edits');
  });

  it('denied: fromStaleBaseCheck(affectedFiles) with out-of-scope edit → denied decision (stale-base-denied.json)', () => {
    const fixture = loadFixture<StaleBaseDeniedFixture>('stale-base-denied');

    // Build classification from raw source data via adapter
    const classification = fromStaleBaseCheck(
      fixture.raw.affectedFiles,
      fixture.raw.source,
    );

    assert.equal(classification.kind, 'stale_base', 'pipeline: adapter must produce stale_base kind for denied case');
    assert.deepEqual(
      classification.affectedFiles,
      fixture.raw.affectedFiles,
      'pipeline: adapter must preserve raw affectedFiles for denied case',
    );

    const decision = evaluateReadyRemediation({
      classification,
      proposedEdits: fixture.proposedEdits,
    });

    assert.equal(decision.decision, 'denied', 'pipeline: stale-base with out-of-scope edits must be denied');
    assert.equal(decision.classification, 'stale_base', 'pipeline: denied decision must identify stale_base classification');
    assert.deepEqual(
      decision.allowedScope,
      fixture.expected.allowedScope,
      'pipeline: allowedScope must match fixture expected',
    );
    assert.deepEqual(
      decision.rejectedEdits,
      fixture.expected.rejectedEdits,
      'pipeline: rejectedEdits must exactly name out-of-scope paths from fixture',
    );
    assert.ok(
      decision.rationale.includes(fixture.expected.rejectedEdits[0]),
      `pipeline: rationale must name the rejected path "${fixture.expected.rejectedEdits[0]}"`,
    );
    assert.ok(
      decision.rationale.includes('stale_base'),
      'pipeline: rationale must identify the stale_base classification',
    );

    // Verify the decision matches the fixture fully (rationale may have minor variation in wording but key parts match)
    assert.equal(decision.decision, fixture.expected.decision, 'pipeline: decision field must match fixture');
    assert.equal(decision.classification, fixture.expected.classification, 'pipeline: classification field must match fixture');
  });
});

// ---------------------------------------------------------------------------
// Merge-conflict pipeline: fromMergeConflictResult → evaluateReadyRemediation
// ---------------------------------------------------------------------------

describe('ready-remediation-integration: merge-conflict adapter pipeline', () => {
  it('allowed: fromMergeConflictResult(CONFLICTED) + subset edits → allowed decision (conflict.json)', () => {
    const fixture = loadFixture<StandardFixture>('conflict');
    const { result, conflictedFiles } = conflictedResult(fixture.input.classification.affectedFiles);

    const classification = fromMergeConflictResult(result, conflictedFiles);

    assert.equal(classification.kind, 'merge_conflict', 'pipeline: adapter must produce merge_conflict kind');
    assert.equal(classification.source, 'merge-conflict-result:CONFLICTED', 'pipeline: adapter must set CONFLICTED source label');
    assert.deepEqual(
      classification.affectedFiles,
      conflictedFiles,
      'pipeline: adapter must forward conflictedFiles as affectedFiles',
    );

    const decision = evaluateReadyRemediation({
      classification,
      proposedEdits: fixture.input.proposedEdits,
    });

    assert.deepEqual(decision, fixture.expected, 'pipeline: merge-conflict allowed decision must match fixture exactly');
    assert.equal(decision.decision, 'allowed', 'pipeline: proposed subset of conflicted files must be allowed');
    assert.deepEqual(decision.rejectedEdits, [], 'pipeline: allowed path must have no rejected edits');
    assert.ok(
      decision.allowedScope.length >= fixture.input.proposedEdits.length,
      'pipeline: allowedScope must include all proposed edits when allowed',
    );
  });

  it('denied: fromMergeConflictResult(CONFLICTED) + unrelated edit → denied decision (denied-unrelated-edit.json)', () => {
    const fixture = loadFixture<StandardFixture>('denied-unrelated-edit');
    const { result, conflictedFiles } = conflictedResult(fixture.input.classification.affectedFiles);

    const classification = fromMergeConflictResult(result, conflictedFiles);

    assert.equal(classification.kind, 'merge_conflict', 'pipeline: adapter must produce merge_conflict kind for denied case');

    const decision = evaluateReadyRemediation({
      classification,
      proposedEdits: fixture.input.proposedEdits,
    });

    assert.deepEqual(decision, fixture.expected, 'pipeline: merge-conflict denied decision must match fixture exactly');
    assert.equal(decision.decision, 'denied', 'pipeline: unrelated edit outside conflict scope must be denied');
    assert.equal(decision.classification, 'merge_conflict', 'pipeline: denied decision must identify merge_conflict classification');
    assert.ok(
      decision.rejectedEdits.length > 0,
      'pipeline: denied decision must name the rejected paths',
    );
    assert.ok(
      decision.rationale.includes('merge_conflict'),
      'pipeline: denied rationale must identify the merge_conflict classification',
    );
    for (const rejected of decision.rejectedEdits) {
      assert.ok(
        decision.rationale.includes(rejected),
        `pipeline: rationale must name rejected path "${rejected}"`,
      );
    }
  });

  it('unknown status: fromMergeConflictResult(CLEAN) → unknown classification → deny-all', () => {
    const result: MergeConflictResult = {
      status: 'CLEAN',
      message: 'no conflicts',
      attempts: 1,
    };
    const classification = fromMergeConflictResult(result, ['src/a.ts']);

    assert.equal(classification.kind, 'unknown', 'pipeline: CLEAN status must produce unknown classification');
    assert.deepEqual(classification.affectedFiles, [], 'pipeline: unknown classification must have empty affectedFiles');
    assert.ok(
      classification.source?.includes('CLEAN'),
      'pipeline: unknown source must label the non-CONFLICTED status',
    );

    const decision = evaluateReadyRemediation({
      classification,
      proposedEdits: ['src/a.ts'],
    });

    assert.equal(decision.decision, 'denied', 'pipeline: unknown classification must deny all edits');
    assert.deepEqual(decision.allowedScope, [], 'pipeline: unknown classification must have empty allowedScope');
    assert.ok(
      decision.rationale.includes('unknown'),
      'pipeline: denied rationale must mention unknown classification',
    );
  });
});
