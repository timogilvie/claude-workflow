import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { diagnoseArtifacts } from './artifact-diagnostics.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'artifact-diagnostics-test-'));
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

function writeTaskContract(featureDir: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    schemaVersion: '1.0.0',
    issueId: 'HOK-9999',
    slug: 'test-feature',
    sources: [],
    fields: {},
    routingHints: {},
    warnings: [],
  };
  writeFileSync(
    join(featureDir, 'task-contract.json'),
    JSON.stringify({ ...defaults, ...overrides }, null, 2),
    'utf-8',
  );
}

function writeFeatureState(featureDir: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    schemaVersion: '1.0',
    derivedAt: new Date().toISOString(),
    issueId: 'HOK-9999',
    slug: 'test-feature',
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
  const merged = deepMerge(defaults, overrides);
  writeFileSync(
    join(featureDir, 'feature-state.json'),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val) &&
        typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function writeTraceEvent(featureDir: string, event: Record<string, unknown>): void {
  const line = JSON.stringify({
    schemaVersion: '1.0',
    traceId: 'trc_test_1234',
    issueId: 'HOK-9999',
    slug: 'test-feature',
    timestamp: new Date().toISOString(),
    phase: 'coding',
    event: 'phase_started',
    ...event,
  });
  const tracePath = join(featureDir, 'trace.jsonl');
  writeFileSync(tracePath, line + '\n', { flag: 'a' });
}

function writeTraceContext(featureDir: string, traceId = 'trc_test_1234'): void {
  writeFileSync(
    join(featureDir, '.trace-context.json'),
    JSON.stringify({ schemaVersion: '1.0', traceId, issueId: 'HOK-9999', slug: 'test-feature', createdAt: new Date().toISOString() }),
    'utf-8',
  );
}

function writeWorkflowState(repoDir: string, tasks: Record<string, unknown>): void {
  writeFileSync(
    join(repoDir, '.wavemill', 'workflow-state.json'),
    JSON.stringify({ tasks }),
    'utf-8',
  );
}

function writeEvalRecord(repoDir: string, record: Record<string, unknown>): void {
  const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  const defaults = {
    id: 'eval-001',
    schemaVersion: '1.29.0',
    originalPrompt: 'task prompt',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6',
    score: 0.8,
    scoreBand: 'good',
    timeSeconds: 120,
    timestamp: new Date().toISOString(),
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'good work',
  };
  const line = JSON.stringify({ ...defaults, ...record });
  writeFileSync(evalsPath, line + '\n', { flag: 'a' });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('diagnoseArtifacts', () => {
  let repoDir: string;
  const tempDirs: string[] = [];

  before(() => {
    repoDir = makeTempRepo();
    tempDirs.push(repoDir);
  });

  after(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('1. present and valid — no warning/error findings', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'valid-feature';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0001', slug);

    // Write task contract with source that matches current file
    const taskPacketContent = '# Task Packet\n## Objective\nDo something.\n';
    writeFileSync(join(featureDir, 'task-packet.md'), taskPacketContent, 'utf-8');

    const hash = createHash('sha256').update(readFileSync(join(featureDir, 'task-packet.md'))).digest('hex');

    writeTaskContract(featureDir, {
      issueId: 'HOK-0001',
      slug,
      sources: [
        { path: 'task-packet.md', exists: true, sha256: hash },
      ],
    });

    writeFeatureState(featureDir, {
      issueId: 'HOK-0001',
      slug,
      currentPhase: 'coding',
      normalizedState: 'running',
    });

    writeTraceContext(featureDir);
    writeTraceEvent(featureDir, { event: 'phase_started', phase: 'coding' });

    writeWorkflowState(tmpRepo, {
      'HOK-0001': { issue: 'HOK-0001', slug, phase: 'coding', status: 'running' },
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, taskId: 'HOK-0001' });

    const warnErrors = report.findings.filter(f => f.severity === 'warn' || f.severity === 'error');
    assert.equal(warnErrors.length, 0, `Expected no warn/error findings, got: ${JSON.stringify(warnErrors, null, 2)}`);
    assert.equal(report.summary.warn, 0);
    assert.equal(report.summary.error, 0);
    assert.equal(report.artifacts.taskContract.present, true);
    assert.equal(report.artifacts.featureState.present, true);
    assert.equal(report.artifacts.trace.present, true);
  });

  it('2. missing artifacts — coverage_gap info findings, no errors', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'missing-artifacts';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0002', slug);
    writeWorkflowState(tmpRepo, {
      'HOK-0002': { issue: 'HOK-0002', slug, phase: 'coding', status: 'running' },
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, taskId: 'HOK-0002' });

    assert.equal(report.summary.error, 0, 'Expected no errors');
    const gapFindings = report.findings.filter(f => f.code === 'coverage_gap');
    const gapCodes = gapFindings.map(f => f.message);
    assert.ok(gapCodes.some(m => m.includes('task-contract.json')), 'Expected gap finding for task-contract.json');
    assert.ok(gapCodes.some(m => m.includes('feature-state.json')), 'Expected gap finding for feature-state.json');
    assert.ok(gapCodes.some(m => m.includes('trace.jsonl')), 'Expected gap finding for trace.jsonl');
    assert.equal(report.artifacts.taskContract.present, false);
    assert.equal(report.artifacts.featureState.present, false);
    assert.equal(report.artifacts.trace.present, false);
  });

  it('3. stale hash — contract_hash_drift warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'stale-hash';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0003', slug);

    // Write task-packet.md with one content, store hash of original in contract
    writeFileSync(join(featureDir, 'task-packet.md'), 'original content', 'utf-8');
    const origHash = createHash('sha256').update('original content').digest('hex');

    writeTaskContract(featureDir, {
      issueId: 'HOK-0003',
      slug,
      sources: [
        { path: 'task-packet.md', exists: true, sha256: origHash },
      ],
    });

    // Now change the file
    writeFileSync(join(featureDir, 'task-packet.md'), 'changed content — this is different', 'utf-8');

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });

    const driftFindings = report.findings.filter(f => f.code === 'contract_hash_drift');
    assert.ok(driftFindings.length > 0, 'Expected contract_hash_drift finding');
    assert.equal(driftFindings[0].severity, 'warn');
    assert.equal(driftFindings[0].gateId, 'contract_source_hash_mismatch');
    assert.match(driftFindings[0].expected || '', /^hash /);
    assert.match(driftFindings[0].actual || '', /^hash /);
    assert.ok(driftFindings[0].recommendedAction);
    assert.ok(driftFindings[0].details?.sourcePath === 'task-packet.md');
    assert.ok(typeof driftFindings[0].details?.storedSha256 === 'string');
    assert.ok(typeof driftFindings[0].details?.currentSha256 === 'string');
    assert.notEqual(driftFindings[0].details?.storedSha256, driftFindings[0].details?.currentSha256);
  });

  it('4. state mismatch — feature_outcome_state_mismatch warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'state-mismatch';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0004', slug);

    // Workflow says coding/running, feature-state says ready/completed
    writeWorkflowState(tmpRepo, {
      'HOK-0004': { issue: 'HOK-0004', slug, phase: 'coding', status: 'running' },
    });
    writeFeatureState(featureDir, {
      issueId: 'HOK-0004',
      slug,
      currentPhase: 'ready',
      normalizedState: 'completed',
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, taskId: 'HOK-0004' });

    const mismatchFindings = report.findings.filter(f => f.code === 'feature_outcome_state_mismatch');
    assert.ok(mismatchFindings.length > 0, 'Expected feature_outcome_state_mismatch finding');
    assert.equal(mismatchFindings[0].severity, 'warn');
  });

  it('5. malformed artifacts — malformed error findings with file path', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'malformed';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0005', slug);

    // Write invalid JSON to task-contract.json and feature-state.json
    writeFileSync(join(featureDir, 'task-contract.json'), '{ not valid json }', 'utf-8');
    writeFileSync(join(featureDir, 'feature-state.json'), '{ also: invalid }', 'utf-8');

    // Write trace with one invalid line
    writeFileSync(join(featureDir, 'trace.jsonl'),
      '{"valid": true}\n{invalid json line\n{"also": "valid"}\n',
      'utf-8',
    );

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });

    const malformedFindings = report.findings.filter(f => f.code === 'malformed');
    assert.ok(malformedFindings.length >= 3, `Expected at least 3 malformed findings, got ${malformedFindings.length}`);

    const contractMalformed = malformedFindings.find(f => f.file?.includes('task-contract.json'));
    assert.ok(contractMalformed, 'Expected malformed finding for task-contract.json');
    assert.equal(contractMalformed.severity, 'error');
    assert.ok(contractMalformed.reason);

    const traceMalformed = malformedFindings.filter(f => f.file?.includes('trace.jsonl'));
    assert.ok(traceMalformed.length > 0, 'Expected malformed finding for trace.jsonl');
    assert.ok(traceMalformed[0].details?.line, 'Expected line number in trace malformed finding');

    assert.equal(report.artifacts.taskContract.malformed, true);
    assert.equal(report.artifacts.featureState.malformed, true);
    assert.ok(report.artifacts.trace.malformedLines > 0);
  });

  it('6. coding complete without evidence — coding_complete_without_evidence warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'coding-no-evidence';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0006', slug);

    // Create .coding-complete marker
    writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');

    // Feature state with only legacy_marker evidence and no positive outcome
    writeFeatureState(featureDir, {
      issueId: 'HOK-0006',
      slug,
      currentPhase: 'coding',
      normalizedState: 'completed',
      evidence: [
        { kind: 'legacy_marker', label: '.coding-complete', status: 'pass' },
      ],
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
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });

    const evidenceFindings = report.findings.filter(f => f.code === 'coding_complete_without_evidence');
    assert.ok(evidenceFindings.length > 0, 'Expected coding_complete_without_evidence finding');
    assert.equal(evidenceFindings[0].severity, 'warn');
  });

  it('7. eval without final outcome — eval_without_outcome warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'eval-no-outcome';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0007', slug);

    // Write an eval record matching the task
    writeEvalRecord(tmpRepo, { issueId: 'HOK-0007', score: 0.75 });

    // Feature state is non-final
    writeFeatureState(featureDir, {
      issueId: 'HOK-0007',
      slug,
      currentPhase: 'coding',
      normalizedState: 'running',
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
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, taskId: 'HOK-0007' });

    const evalFindings = report.findings.filter(f => f.code === 'eval_without_outcome');
    assert.ok(evalFindings.length > 0, 'Expected eval_without_outcome finding');
    assert.equal(evalFindings[0].severity, 'warn');
  });

  it('8. trace coverage and unreflected events — trace_id_missing and trace_event_unreflected', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'trace-coverage';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0008', slug);

    // Write trace context and events
    writeTraceContext(featureDir, 'trc_test_0008');
    writeTraceEvent(featureDir, { event: 'route_assigned', phase: 'launch', traceId: 'trc_test_0008' });
    writeTraceEvent(featureDir, { event: 'fallback_used', phase: 'coding', traceId: 'trc_test_0008' });
    writeTraceEvent(featureDir, { event: 'check_failed', phase: 'coding', traceId: 'trc_test_0008' });

    // Route artifact without traceId
    writeFileSync(
      join(featureDir, '.initial-route.json'),
      JSON.stringify({ coder: 'claude', codeDepth: 'medium', reviewer: 'claude' }),
      'utf-8',
    );

    // Stage result without traceId
    writeFileSync(
      join(featureDir, '.coding-result.json'),
      JSON.stringify({ stage: 'coding', status: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z' }),
      'utf-8',
    );

    // Feature state without route/blockers
    writeFeatureState(featureDir, {
      issueId: 'HOK-0008',
      slug,
      currentPhase: 'coding',
      normalizedState: 'running',
      route: null,
      blockers: [],
      failureReason: null,
      evidence: [],
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });

    const traceIdFindings = report.findings.filter(f => f.code === 'trace_id_missing');
    assert.ok(traceIdFindings.length > 0, 'Expected trace_id_missing findings');

    const unreflectedFindings = report.findings.filter(f => f.code === 'trace_event_unreflected');
    assert.ok(unreflectedFindings.length > 0, 'Expected trace_event_unreflected findings');

    // All trace findings should be info severity
    for (const f of [...traceIdFindings, ...unreflectedFindings]) {
      assert.equal(f.severity, 'info');
    }
  });

  it('9. route artifact hash mismatch — route_contract_mismatch warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'route-contract-mismatch';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0009', slug);

    writeFileSync(join(featureDir, 'task-packet.md'), 'contract source content', 'utf-8');
    const packetHash = createHash('sha256').update('contract source content').digest('hex');

    writeTaskContract(featureDir, {
      issueId: 'HOK-0009',
      slug,
      sources: [
        { path: 'task-packet.md', exists: true, sha256: packetHash },
      ],
    });

    writeFileSync(
      join(featureDir, '.post-expansion-route.json'),
      JSON.stringify({
        coder: 'claude-opus-4-6',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'normal',
        provenance: {
          inputPath: join(featureDir, 'task-packet.md'),
          inputHash: 'f'.repeat(64),
          source: 'expanded',
          routerMode: 'normal',
        },
      }),
      'utf-8',
    );

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });
    const findings = report.findings.filter((finding) => finding.code === 'route_contract_mismatch');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gateId, 'route_contract_mismatch');
    assert.match(findings[0].expected || '', /task-packet\.md/);
    assert.match(findings[0].actual || '', /route provenance/);
  });

  it('10. ready pass disagreement — ready_inconsistency warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'ready-inconsistency';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0010', slug);

    writeFileSync(
      join(featureDir, '.ready-result.json'),
      JSON.stringify({
        stage: 'ready',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:10:00Z',
        agent: 'codex',
        model: 'claude-opus-4-6',
        notes: '',
        artifacts: { type: 'ready', verdict: 'pass', checksRun: 3, checksPassed: 3 },
      }),
      'utf-8',
    );

    writeFeatureState(featureDir, {
      issueId: 'HOK-0010',
      slug,
      currentPhase: 'done',
      normalizedState: 'completed',
      evidence: [
        { kind: 'ready_check', label: 'ready_verdict', status: 'fail', detail: 'stale state' },
      ],
      outcome: {
        completed: true,
        readyPassed: false,
      },
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });
    const findings = report.findings.filter((finding) => finding.code === 'ready_inconsistency');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gateId, 'ready_inconsistency');
    assert.match(findings[0].actual || '', /readyPassed=false/);
  });

  it('11. training-eligible eval with incomplete normalized outcome — eval_export_inconsistency warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'eval-export-inconsistency';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0011', slug);

    writeFileSync(
      join(featureDir, 'feature-state.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        derivedAt: new Date().toISOString(),
        issueId: 'HOK-0011',
        slug,
        currentPhase: 'done',
        normalizedState: 'completed',
        outcome: {
          completed: true,
          merged: true,
        },
      }),
      'utf-8',
    );
    writeTraceContext(featureDir, 'trc_test_0011');
    writeEvalRecord(tmpRepo, {
      id: 'eval-0011',
      issueId: 'HOK-0011',
      traceId: 'trc_test_0011',
      trainingEligible: true,
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });
    const findings = report.findings.filter((finding) => finding.code === 'eval_export_inconsistency');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gateId, 'eval_export_inconsistency');
    assert.match(findings[0].actual || '', /missing fields/);
  });

  it('11b. training-eligible eval with invalid normalized outcome field reports invalid fields', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'eval-export-invalid-field';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0011B', slug);

    writeFileSync(
      join(featureDir, 'feature-state.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        derivedAt: new Date().toISOString(),
        issueId: 'HOK-0011B',
        slug,
        currentPhase: 'done',
        normalizedState: 'completed',
        outcome: {
          completed: true,
          merged: 'yes',
          ciPassed: true,
          reviewPassed: true,
          readyPassed: true,
          manualIntervention: false,
          interventionCount: 0,
          evalScore: 0.9,
          costUsd: 1.2,
          durationSeconds: 30,
        },
      }),
      'utf-8',
    );
    writeTraceContext(featureDir, 'trc_test_0011b');
    writeEvalRecord(tmpRepo, {
      id: 'eval-0011b',
      issueId: 'HOK-0011B',
      traceId: 'trc_test_0011b',
      trainingEligible: true,
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });
    const findings = report.findings.filter((finding) => finding.code === 'eval_export_inconsistency');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gateId, 'eval_export_inconsistency');
    assert.match(findings[0].actual || '', /invalid fields merged/);
  });

  it('12. fallback without safeguards — fallback_verification_mismatch warning', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'fallback-verification-mismatch';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0012', slug);

    writeTraceContext(featureDir, 'trc_test_0012');
    writeTraceEvent(featureDir, { event: 'fallback_used', phase: 'coding', traceId: 'trc_test_0012' });
    writeFeatureState(featureDir, {
      issueId: 'HOK-0012',
      slug,
      blockers: [],
      failureReason: null,
      evidence: [],
    });

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });
    const findings = report.findings.filter((finding) => finding.code === 'fallback_verification_mismatch');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].gateId, 'fallback_verification_mismatch');
  });

  it('no feature dir resolved — returns repo-level coverage gap, no throw', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);

    // No features/ subdirectories, no identity provided
    const report = diagnoseArtifacts({ repoDir: tmpRepo });

    assert.equal(report.featureDir, null);
    assert.ok(report.findings.length > 0);
    const coverageGap = report.findings.find(f => f.code === 'coverage_gap');
    assert.ok(coverageGap, 'Expected coverage_gap finding');
  });

  it('summary counts match findings', () => {
    const tmpRepo = makeTempRepo();
    tempDirs.push(tmpRepo);
    const slug = 'summary-test';
    const featureDir = makeFeatureDir(tmpRepo, slug);
    writeSelectedTask(featureDir, 'HOK-0099', slug);
    // No artifacts written — expect coverage gaps

    const report = diagnoseArtifacts({ repoDir: tmpRepo, featureDir });

    let expectedInfo = 0, expectedWarn = 0, expectedError = 0;
    for (const f of report.findings) {
      if (f.severity === 'info') expectedInfo++;
      else if (f.severity === 'warn') expectedWarn++;
      else if (f.severity === 'error') expectedError++;
    }
    assert.equal(report.summary.info, expectedInfo);
    assert.equal(report.summary.warn, expectedWarn);
    assert.equal(report.summary.error, expectedError);
  });
});
