/**
 * Tests for artifact-diagnostics.ts (HOK-2260)
 *
 * Covers: tolerant loaders, six drift checks, and the diagnoseArtifacts()
 * entry point. Uses temp-dir fixtures created by Node test helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseArtifacts, type DiagnosticsResult } from './artifact-diagnostics.ts';

// ────────────────────────────────────────────────────────────────
// Fixture helpers
// ────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-diag-test-'));
  mkdirSync(join(dir, '.wavemill', 'evals'), { recursive: true });
  mkdirSync(join(dir, 'features'), { recursive: true });
  return dir;
}

function makeFeatureDir(repoDir: string, slug = 'test-feature'): string {
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

function writeWorkflowState(
  repoDir: string,
  tasks: Record<string, unknown>,
): void {
  writeFileSync(
    join(repoDir, '.wavemill', 'workflow-state.json'),
    JSON.stringify({ tasks }, null, 2),
    'utf-8',
  );
}

function writeTaskContract(featureDir: string, contract: Record<string, unknown>): void {
  writeFileSync(
    join(featureDir, 'task-contract.json'),
    JSON.stringify(contract, null, 2),
    'utf-8',
  );
}

function writeFeatureState(featureDir: string, state: Record<string, unknown>): void {
  writeFileSync(
    join(featureDir, 'feature-state.json'),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

function writeTraceEvents(featureDir: string, events: Record<string, unknown>[]): void {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(featureDir, 'trace.jsonl'), lines, 'utf-8');
}

function writeEvalRecord(repoDir: string, record: Record<string, unknown>): void {
  const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  writeFileSync(evalsPath, JSON.stringify(record) + '\n', 'utf-8');
}

function writeMarker(featureDir: string, name: string): void {
  writeFileSync(join(featureDir, name), '', 'utf-8');
}

function writeSelectedTask(featureDir: string, taskId: string): void {
  writeFileSync(
    join(featureDir, 'selected-task.json'),
    JSON.stringify({ taskId, featureName: 'test-feature' }),
    'utf-8',
  );
}

function writeTraceContext(featureDir: string, traceId: string, issueId: string): void {
  writeFileSync(
    join(featureDir, '.trace-context.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      traceId,
      issueId,
      slug: 'test-feature',
      createdAt: new Date().toISOString(),
    }),
    'utf-8',
  );
}

function cleanup(dirs: string[]): void {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
}

function findFindings(result: DiagnosticsResult, check: string) {
  return result.findings.filter((f) => f.check === check);
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('diagnoseArtifacts — missing repoDir', () => {
  it('returns a coverage finding when repoDir does not exist', async () => {
    const result = await diagnoseArtifacts({
      repoDir: '/tmp/nonexistent-wavemill-test-repo-9999',
      featureDir: '/tmp/nonexistent-feature',
    });
    assert.equal(result.summary.coverage, 1);
    assert.equal(result.summary.mismatch, 0);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'coverage');
  });
});

describe('diagnoseArtifacts — no artifacts present', () => {
  it('returns only coverage findings when no artifacts exist', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      assert.equal(result.summary.mismatch, 0, 'no mismatch expected when all artifacts are absent');
      assert.equal(result.summary.malformed, 0, 'no malformed expected');
      assert.ok(result.summary.coverage > 0, 'at least some coverage findings expected');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('checkContractHashMatch', () => {
  it('emits ok when all contract source hashes match', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      // Write a real source file and compute its hash
      const { createHash } = await import('node:crypto');
      const content = 'Hello task packet';
      writeFileSync(join(featureDir, 'task-packet.md'), content, 'utf-8');
      const sha256 = createHash('sha256').update(Buffer.from(content)).digest('hex');

      writeTaskContract(featureDir, {
        schemaVersion: '1.0.0',
        issueId: null,
        slug: 'test',
        sources: [{ path: 'task-packet.md', exists: true, sha256 }],
        fields: {},
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const hashFindings = findFindings(result, 'contract-hash-match');
      assert.ok(hashFindings.length > 0, 'should have at least one finding');
      assert.equal(hashFindings[0].severity, 'ok');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits mismatch when source hash changed', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      // Write the file with different content than the recorded hash
      writeFileSync(join(featureDir, 'task-packet.md'), 'modified content', 'utf-8');

      writeTaskContract(featureDir, {
        schemaVersion: '1.0.0',
        issueId: null,
        slug: 'test',
        sources: [{ path: 'task-packet.md', exists: true, sha256: 'aaaa0000' + 'a'.repeat(56) }],
        fields: {},
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const hashFindings = findFindings(result, 'contract-hash-match');
      const mismatch = hashFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected a mismatch finding for changed source hash');
      assert.ok(mismatch.detail?.recordedHash, 'detail should include recordedHash');
      assert.ok(mismatch.detail?.currentHash, 'detail should include currentHash');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits stale when source recorded as existing but now missing', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeTaskContract(featureDir, {
        schemaVersion: '1.0.0',
        issueId: null,
        slug: 'test',
        sources: [{ path: 'task-packet.md', exists: true, sha256: 'abc123' + 'a'.repeat(58) }],
        fields: {},
      });
      // task-packet.md is NOT written

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const hashFindings = findFindings(result, 'contract-hash-match');
      const stale = hashFindings.find((f) => f.severity === 'stale');
      assert.ok(stale, 'expected a stale finding for missing source');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits coverage when task-contract.json is missing', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const hashFindings = findFindings(result, 'contract-hash-match');
      assert.ok(hashFindings.length > 0);
      assert.equal(hashFindings[0].severity, 'coverage');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('checkOutcomeVsWorkflowState', () => {
  it('emits ok when feature-state phase matches workflow-state phase', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeSelectedTask(featureDir, 'HOK-1234');
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'completed',
        evidence: [],
        blockers: [],
      });
      writeWorkflowState(repo, {
        'HOK-1234': { phase: 'coding', branch: 'task/test', pr: 100 },
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir, issueId: 'HOK-1234' });
      const stateFindings = findFindings(result, 'outcome-vs-workflow-state');
      const ok = stateFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok finding when phases agree');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits mismatch when feature-state phase differs from workflow-state phase', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeSelectedTask(featureDir, 'HOK-1234');
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'review',
        normalizedState: 'running',
        evidence: [],
        blockers: [],
      });
      writeWorkflowState(repo, {
        'HOK-1234': { phase: 'coding', branch: 'task/test', pr: 100 },
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir, issueId: 'HOK-1234' });
      const stateFindings = findFindings(result, 'outcome-vs-workflow-state');
      const mismatch = stateFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected mismatch when phases disagree');
      assert.ok(
        mismatch.detail?.outcomePhase === 'review' && mismatch.detail?.workflowPhase === 'coding',
        'detail should carry both phases',
      );
    } finally {
      cleanup([repo]);
    }
  });

  it('emits coverage when feature-state.json is absent', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeWorkflowState(repo, { 'HOK-1234': { phase: 'coding' } });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir, issueId: 'HOK-1234' });
      const stateFindings = findFindings(result, 'outcome-vs-workflow-state');
      assert.ok(stateFindings.some((f) => f.severity === 'coverage'));
    } finally {
      cleanup([repo]);
    }
  });
});

describe('checkCodingCompleteEvidence', () => {
  it('emits mismatch when .coding-complete exists but no passing coding evidence', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeMarker(featureDir, '.coding-complete');
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'completed',
        evidence: [],
        blockers: [],
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const ccFindings = findFindings(result, 'coding-complete-evidence');
      const mismatch = ccFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected mismatch when no coding evidence in feature-state');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits ok when .coding-complete and feature-state has passing coding evidence', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeMarker(featureDir, '.coding-complete');
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'completed',
        evidence: [
          { kind: 'stage_completion', label: 'coding_stage', status: 'pass' },
        ],
        blockers: [],
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const ccFindings = findFindings(result, 'coding-complete-evidence');
      const ok = ccFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok when coding evidence is present');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits coverage when .coding-complete exists but feature-state.json is absent', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeMarker(featureDir, '.coding-complete');

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const ccFindings = findFindings(result, 'coding-complete-evidence');
      const cov = ccFindings.find((f) => f.severity === 'coverage');
      assert.ok(cov, 'expected coverage when feature-state is absent');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits ok when .coding-complete does not exist', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      // no .coding-complete marker
      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const ccFindings = findFindings(result, 'coding-complete-evidence');
      const ok = ccFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok when coding is not marked complete');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('checkEvalWithoutOutcome', () => {
  it('emits mismatch when eval record exists but feature-state.json does not', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeEvalRecord(repo, {
        issueId: 'HOK-5678',
        modelId: 'claude-sonnet-4-6',
        score: 0.8,
        timestamp: new Date().toISOString(),
        rationale: 'good work',
      });

      const result = await diagnoseArtifacts({
        repoDir: repo,
        featureDir,
        issueId: 'HOK-5678',
      });
      const evalFindings = findFindings(result, 'eval-without-outcome');
      const mismatch = evalFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected mismatch when eval exists without feature-state');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits ok when both eval record and feature-state exist', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeEvalRecord(repo, {
        issueId: 'HOK-5678',
        modelId: 'claude-sonnet-4-6',
        score: 0.8,
        timestamp: new Date().toISOString(),
        rationale: 'good work',
      });
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'done',
        normalizedState: 'completed',
        evidence: [],
        blockers: [],
      });

      const result = await diagnoseArtifacts({
        repoDir: repo,
        featureDir,
        issueId: 'HOK-5678',
      });
      const evalFindings = findFindings(result, 'eval-without-outcome');
      const ok = evalFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok when both eval and feature-state are present');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits ok when neither eval record nor feature-state exist', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      const result = await diagnoseArtifacts({
        repoDir: repo,
        featureDir,
        issueId: 'HOK-9999',
      });
      const evalFindings = findFindings(result, 'eval-without-outcome');
      const ok = evalFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok when both are absent');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('checkTraceIdPropagation', () => {
  it('emits mismatch when trace context exists but eval record lacks traceId', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeTraceContext(featureDir, 'trc_00000001_abcdef0123456789', 'HOK-1111');
      writeEvalRecord(repo, {
        issueId: 'HOK-1111',
        modelId: 'claude-sonnet-4-6',
        score: 0.9,
        timestamp: new Date().toISOString(),
        rationale: 'great',
        // no traceId
      });

      const result = await diagnoseArtifacts({
        repoDir: repo,
        featureDir,
        issueId: 'HOK-1111',
      });
      const traceFindings = findFindings(result, 'traceid-propagation');
      const mismatch = traceFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected mismatch when eval lacks traceId');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits ok when trace context traceId matches eval record', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    const traceId = 'trc_00000001_abcdef0123456789';
    try {
      writeTraceContext(featureDir, traceId, 'HOK-1111');
      writeEvalRecord(repo, {
        issueId: 'HOK-1111',
        modelId: 'claude-sonnet-4-6',
        score: 0.9,
        timestamp: new Date().toISOString(),
        rationale: 'great',
        traceId,
      });

      const result = await diagnoseArtifacts({
        repoDir: repo,
        featureDir,
        issueId: 'HOK-1111',
      });
      const traceFindings = findFindings(result, 'traceid-propagation');
      const ok = traceFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok when traceId is propagated');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits coverage when no trace context exists', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      const result = await diagnoseArtifacts({ repoDir: repo, featureDir, issueId: 'HOK-2222' });
      const traceFindings = findFindings(result, 'traceid-propagation');
      const cov = traceFindings.find((f) => f.severity === 'coverage');
      assert.ok(cov, 'expected coverage when no trace context');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('checkTraceEventsUnreflected', () => {
  it('emits mismatch when check_failed events exist but feature-state has no blockers', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeTraceEvents(featureDir, [
        {
          schemaVersion: '1.0',
          traceId: 'trc_00000001_abcdef0123456789',
          issueId: 'HOK-3333',
          slug: 'test',
          timestamp: new Date().toISOString(),
          phase: 'coding',
          event: 'check_failed',
          status: 'failed',
        },
      ]);
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'completed',
        evidence: [{ kind: 'stage_completion', label: 'coding_stage', status: 'pass' }],
        blockers: [],
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const traceEvFindings = findFindings(result, 'trace-events-unreflected');
      const mismatch = traceEvFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected mismatch when check_failed not reflected in blockers');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits ok when check_failed events correlate with blockers in feature-state', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeTraceEvents(featureDir, [
        {
          schemaVersion: '1.0',
          traceId: 'trc_00000001_abcdef0123456789',
          issueId: 'HOK-3333',
          slug: 'test',
          timestamp: new Date().toISOString(),
          phase: 'coding',
          event: 'check_failed',
          status: 'failed',
        },
      ]);
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'failed',
        evidence: [{ kind: 'stage_completion', label: 'coding_stage', status: 'fail' }],
        blockers: [{ code: 'coding_blocked', stage: 'coding' }],
      });

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const traceEvFindings = findFindings(result, 'trace-events-unreflected');
      const ok = traceEvFindings.find((f) => f.severity === 'ok');
      assert.ok(ok, 'expected ok when check_failed events are reflected via blockers');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits coverage when trace.jsonl is absent', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const traceEvFindings = findFindings(result, 'trace-events-unreflected');
      const cov = traceEvFindings.find((f) => f.severity === 'coverage');
      assert.ok(cov, 'expected coverage when trace.jsonl missing');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits mismatch when check_failed events exist but feature-state is absent', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeTraceEvents(featureDir, [
        {
          schemaVersion: '1.0',
          traceId: 'trc_00000001_abcdef0123456789',
          issueId: 'HOK-3333',
          slug: 'test',
          timestamp: new Date().toISOString(),
          phase: 'coding',
          event: 'check_failed',
        },
      ]);
      // no feature-state.json

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const traceEvFindings = findFindings(result, 'trace-events-unreflected');
      const mismatch = traceEvFindings.find((f) => f.severity === 'mismatch');
      assert.ok(mismatch, 'expected mismatch when feature-state absent with check_failed events');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('malformed artifact handling', () => {
  it('emits malformed finding for contract with invalid JSON', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeFileSync(join(featureDir, 'task-contract.json'), '{invalid json}', 'utf-8');

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const hashFindings = findFindings(result, 'contract-hash-match');
      const malformed = hashFindings.find((f) => f.severity === 'malformed');
      assert.ok(malformed, 'expected malformed finding for invalid JSON contract');
      assert.ok(malformed.filePath?.includes('task-contract.json'), 'should include filePath');
      assert.ok(malformed.message.includes('malformed'), 'message should mention malformed');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits malformed finding for zero-byte contract file', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeFileSync(join(featureDir, 'task-contract.json'), '', 'utf-8');

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const hashFindings = findFindings(result, 'contract-hash-match');
      const malformed = hashFindings.find((f) => f.severity === 'malformed');
      assert.ok(malformed, 'expected malformed finding for empty file');
      assert.ok(malformed.message.includes('malformed'), 'message should mention malformed');
    } finally {
      cleanup([repo]);
    }
  });

  it('emits malformed finding for feature-state with invalid JSON', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeFileSync(join(featureDir, 'feature-state.json'), '{bad}', 'utf-8');

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const stateFindings = findFindings(result, 'outcome-vs-workflow-state');
      const malformed = stateFindings.find((f) => f.severity === 'malformed');
      assert.ok(malformed, 'expected malformed finding for invalid feature-state JSON');
      assert.ok(malformed.filePath?.includes('feature-state.json'), 'should include filePath');
    } finally {
      cleanup([repo]);
    }
  });

  it('reports malformed trace lines as skipped without crashing', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      // Write 2 valid lines and 1 invalid line
      const traceFile = join(featureDir, 'trace.jsonl');
      writeFileSync(
        traceFile,
        [
          JSON.stringify({ schemaVersion: '1.0', traceId: 'trc_1', issueId: 'HOK-0', slug: 'x', timestamp: 't', phase: 'coding', event: 'phase_started' }),
          '{this is not valid json',
          JSON.stringify({ schemaVersion: '1.0', traceId: 'trc_1', issueId: 'HOK-0', slug: 'x', timestamp: 't', phase: 'coding', event: 'phase_completed' }),
        ].join('\n') + '\n',
        'utf-8',
      );

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir });
      const malformedTrace = result.findings.find(
        (f) => f.check === 'trace-load' && f.severity === 'malformed',
      );
      assert.ok(malformedTrace, 'expected malformed finding for skipped trace lines');
      assert.ok(malformedTrace.detail?.skippedLines === 1, 'should report 1 skipped line');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('read-only verification', () => {
  it('does not modify any fixture files after running diagnoseArtifacts', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      writeTaskContract(featureDir, {
        schemaVersion: '1.0.0',
        issueId: 'HOK-0001',
        slug: 'test',
        sources: [],
        fields: {},
      });
      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'running',
        evidence: [],
        blockers: [],
      });
      writeTraceEvents(featureDir, []);

      // Capture file contents and mtimes before
      const contractPath = join(featureDir, 'task-contract.json');
      const statePath = join(featureDir, 'feature-state.json');
      const tracePath = join(featureDir, 'trace.jsonl');

      const contractBefore = readFileSync(contractPath, 'utf-8');
      const stateBefore = readFileSync(statePath, 'utf-8');
      const traceBefore = readFileSync(tracePath, 'utf-8');
      const contractMtimeBefore = statSync(contractPath).mtimeMs;
      const stateMtimeBefore = statSync(statePath).mtimeMs;
      const traceMtimeBefore = statSync(tracePath).mtimeMs;

      await diagnoseArtifacts({ repoDir: repo, featureDir });

      // Assert no mutations
      assert.equal(readFileSync(contractPath, 'utf-8'), contractBefore, 'task-contract.json must not be modified');
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore, 'feature-state.json must not be modified');
      assert.equal(readFileSync(tracePath, 'utf-8'), traceBefore, 'trace.jsonl must not be modified');
      assert.equal(statSync(contractPath).mtimeMs, contractMtimeBefore, 'task-contract.json mtime must not change');
      assert.equal(statSync(statePath).mtimeMs, stateMtimeBefore, 'feature-state.json mtime must not change');
      assert.equal(statSync(tracePath).mtimeMs, traceMtimeBefore, 'trace.jsonl mtime must not change');
    } finally {
      cleanup([repo]);
    }
  });
});

describe('all artifacts present and consistent', () => {
  it('returns only ok findings when all artifacts are valid and consistent', async () => {
    const repo = makeTempRepo();
    const featureDir = makeFeatureDir(repo);
    try {
      const issueId = 'HOK-7777';
      writeSelectedTask(featureDir, issueId);
      writeMarker(featureDir, '.coding-complete');

      writeFeatureState(featureDir, {
        schemaVersion: '1.0',
        currentPhase: 'coding',
        normalizedState: 'completed',
        evidence: [
          { kind: 'stage_completion', label: 'coding_stage', status: 'pass' },
        ],
        blockers: [],
      });
      writeWorkflowState(repo, {
        [issueId]: { phase: 'coding', branch: 'task/test', pr: 100 },
      });
      writeTaskContract(featureDir, {
        schemaVersion: '1.0.0',
        issueId,
        slug: 'test-feature',
        sources: [],
        fields: {},
      });
      writeTraceEvents(featureDir, [
        {
          schemaVersion: '1.0',
          traceId: 'trc_00000001_abcdef0123456789',
          issueId,
          slug: 'test-feature',
          timestamp: new Date().toISOString(),
          phase: 'coding',
          event: 'phase_completed',
          status: 'ok',
        },
      ]);

      const result = await diagnoseArtifacts({ repoDir: repo, featureDir, issueId });
      const problems = result.findings.filter(
        (f) => f.severity === 'mismatch' || f.severity === 'stale',
      );
      assert.equal(problems.length, 0, `unexpected mismatch/stale: ${JSON.stringify(problems)}`);
    } finally {
      cleanup([repo]);
    }
  });
});
