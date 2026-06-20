import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { runSoftGates } from './soft-gates.ts';

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'soft-gates-test-'));
  mkdirSync(join(repoDir, 'features'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  return repoDir;
}

function makeFeatureDir(repoDir: string, slug: string): string {
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

function writeSelectedTask(featureDir: string, taskId: string, slug: string): void {
  writeFileSync(
    join(featureDir, 'selected-task.json'),
    JSON.stringify({ taskId, featureName: slug, workflowType: 'feature' }),
    'utf-8',
  );
}

function writeTaskContract(featureDir: string, taskId: string, slug: string, sourcePath: string, sourceContent: string): void {
  writeFileSync(join(featureDir, sourcePath), sourceContent, 'utf-8');
  const hash = createHash('sha256').update(sourceContent).digest('hex');
  writeFileSync(
    join(featureDir, 'task-contract.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      issueId: taskId,
      slug,
      sources: [{ path: sourcePath, exists: true, sha256: hash }],
      fields: {},
      routingHints: {},
      warnings: [],
    }),
    'utf-8',
  );
}

function writeFeatureState(featureDir: string, taskId: string, slug: string, overrides: Record<string, unknown> = {}): void {
  const base = {
    schemaVersion: '1.0',
    derivedAt: new Date().toISOString(),
    issueId: taskId,
    slug,
    branch: null,
    prNumber: null,
    prUrl: null,
    currentPhase: 'coding',
    normalizedState: 'running',
    contract: null,
    route: null,
    stages: { planning: null, coding: null, review: null, ready: null },
    evidence: [],
    blockers: [],
    failureReason: null,
    outcome: {
      completed: false,
      merged: null,
      ciPassed: null,
      reviewPassed: null,
      readyPassed: null,
      manualIntervention: null,
      interventionCount: null,
      reverted: null,
      evalScore: null,
      costUsd: null,
      durationSeconds: null,
    },
    artifactSources: {
      stagesFromWorktree: false,
      stagesFromArchive: false,
      routeFromWorktree: false,
      routeFromArchive: false,
      evalRecordUsed: false,
    },
  };
  writeFileSync(join(featureDir, 'feature-state.json'), JSON.stringify(deepMerge(base, overrides), null, 2), 'utf-8');
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && result[key] !== null
      && typeof result[key] === 'object'
      && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function writeTraceContext(featureDir: string, taskId: string, slug: string, traceId: string): void {
  writeFileSync(
    join(featureDir, '.trace-context.json'),
    JSON.stringify({ schemaVersion: '1.0', traceId, issueId: taskId, slug, createdAt: new Date().toISOString() }),
    'utf-8',
  );
}

function writeTraceEvent(featureDir: string, taskId: string, slug: string, traceId: string, event: string): void {
  writeFileSync(
    join(featureDir, 'trace.jsonl'),
    `${JSON.stringify({ schemaVersion: '1.0', traceId, issueId: taskId, slug, timestamp: new Date().toISOString(), phase: 'coding', event })}\n`,
    { flag: 'a' },
  );
}

function writeEvalRecord(repoDir: string, record: Record<string, unknown>): void {
  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'evals.jsonl'),
    `${JSON.stringify({
      id: 'eval-default',
      schemaVersion: '1.30.0',
      originalPrompt: 'task prompt',
      modelId: 'claude-opus-4-6',
      modelVersion: 'claude-opus-4-6',
      score: 0.8,
      scoreBand: 'good',
      timeSeconds: 90,
      timestamp: new Date().toISOString(),
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'ok',
      ...record,
    })}\n`,
    { encoding: 'utf-8', flag: 'a' },
  );
}

class CaptureStream extends Writable {
  public output = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

describe('runSoftGates', () => {
  const tempDirs: string[] = [];

  before(() => undefined);

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits completion_without_evidence warnings', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const featureDir = makeFeatureDir(repoDir, 'completion-no-evidence');
    writeSelectedTask(featureDir, 'HOK-2001', 'completion-no-evidence');
    writeFeatureState(featureDir, 'HOK-2001', 'completion-no-evidence', {
      normalizedState: 'completed',
      evidence: [{ kind: 'legacy_marker', label: '.coding-complete', status: 'pass' }],
    });
    writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');

    const stderr = new CaptureStream();
    const result = runSoftGates({ repoDir, featureDir, stderr });

    assert.equal(result.emitted, 1);
    assert.equal(result.emittedWarnings[0].gate, 'completion_without_evidence');
    assert.match(stderr.output, /soft-gate\.warning issue=HOK-2001 gate=completion_without_evidence/);
  });

  it('emits contract_source_hash_mismatch warnings', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const featureDir = makeFeatureDir(repoDir, 'contract-hash-drift');
    writeSelectedTask(featureDir, 'HOK-2002', 'contract-hash-drift');
    writeTaskContract(featureDir, 'HOK-2002', 'contract-hash-drift', 'task-packet.md', 'original');
    writeFeatureState(featureDir, 'HOK-2002', 'contract-hash-drift');
    writeFileSync(join(featureDir, 'task-packet.md'), 'changed', 'utf-8');

    const result = runSoftGates({ repoDir, featureDir, dryRun: true });
    assert.equal(result.warnings[0].gate, 'contract_source_hash_mismatch');
  });

  it('emits trace_linkage_missing warnings', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const slug = 'trace-linkage-missing';
    const featureDir = makeFeatureDir(repoDir, slug);
    writeSelectedTask(featureDir, 'HOK-2003', slug);
    writeFeatureState(featureDir, 'HOK-2003', slug);
    writeTraceContext(featureDir, 'HOK-2003', slug, 'trc_test_2003');
    writeTraceEvent(featureDir, 'HOK-2003', slug, 'trc_test_2003', 'route_assigned');
    writeFileSync(
      join(featureDir, '.initial-route.json'),
      JSON.stringify({ coder: 'claude', codeDepth: 'medium', reviewer: 'claude', reviewMode: 'normal' }),
      'utf-8',
    );

    const result = runSoftGates({ repoDir, featureDir, dryRun: true });
    assert.ok(result.warnings.some((warning) => warning.gate === 'trace_linkage_missing'));
  });

  it('emits eval_export_inconsistency warnings', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const slug = 'eval-export-inconsistency';
    const featureDir = makeFeatureDir(repoDir, slug);
    writeSelectedTask(featureDir, 'HOK-2004', slug);
    writeTraceContext(featureDir, 'HOK-2004', slug, 'trc_test_2004');
    writeFileSync(
      join(featureDir, 'feature-state.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        derivedAt: new Date().toISOString(),
        issueId: 'HOK-2004',
        slug,
        currentPhase: 'done',
        normalizedState: 'completed',
        outcome: { completed: true, merged: true },
      }),
      'utf-8',
    );
    writeEvalRecord(repoDir, { id: 'eval-2004', issueId: 'HOK-2004', traceId: 'trc_test_2004', trainingEligible: true });

    const result = runSoftGates({ repoDir, featureDir, dryRun: true });
    assert.ok(result.warnings.some((warning) => warning.gate === 'eval_export_inconsistency'));
  });

  it('writes no log file on a happy path', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const slug = 'soft-gates-happy-path';
    const featureDir = makeFeatureDir(repoDir, slug);
    writeSelectedTask(featureDir, 'HOK-2005', slug);
    writeTaskContract(featureDir, 'HOK-2005', slug, 'task-packet.md', 'stable');
    writeFeatureState(featureDir, 'HOK-2005', slug, {
      evidence: [{ kind: 'ci_check', label: 'tests', status: 'pass' }],
      route: { activeRoute: { coder: 'claude', codeDepth: 'medium', reviewer: 'claude', reviewMode: 'normal' } },
      outcome: { completed: false, ciPassed: true },
    });
    writeTraceContext(featureDir, 'HOK-2005', slug, 'trc_test_2005');
    writeTraceEvent(featureDir, 'HOK-2005', slug, 'trc_test_2005', 'phase_started');

    const result = runSoftGates({ repoDir, featureDir });
    assert.equal(result.emitted, 0);
    assert.equal(result.checked, 0);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'logs', 'soft-gates.jsonl')), false);
  });

  it('suppresses duplicate warnings within the configured window', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const featureDir = makeFeatureDir(repoDir, 'dedup-test');
    writeSelectedTask(featureDir, 'HOK-2006', 'dedup-test');
    writeFeatureState(featureDir, 'HOK-2006', 'dedup-test');
    writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');

    const stderr = new CaptureStream();
    const first = runSoftGates({ repoDir, featureDir, suppressWindowSeconds: 3600, stderr });
    const second = runSoftGates({ repoDir, featureDir, suppressWindowSeconds: 3600, stderr });

    assert.equal(first.emitted, 1);
    assert.equal(second.emitted, 0);
    assert.equal(second.suppressed, 1);
    const logLines = readFileSync(join(repoDir, '.wavemill', 'logs', 'soft-gates.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    assert.equal(logLines.length, 1);
  });

  it('is best-effort on malformed or missing inputs', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const featureDir = makeFeatureDir(repoDir, 'best-effort');
    writeSelectedTask(featureDir, 'HOK-2007', 'best-effort');
    writeFileSync(join(featureDir, 'task-contract.json'), '{invalid', 'utf-8');

    const stderr = new CaptureStream();
    assert.doesNotThrow(() => runSoftGates({ repoDir, featureDir, stderr }));
    const result = runSoftGates({ repoDir, featureDir, stderr });
    assert.ok(result.warnings.some((warning) => warning.gate === 'artifact_malformed'));
  });
});
