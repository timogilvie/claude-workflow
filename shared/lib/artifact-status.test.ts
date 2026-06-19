import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';
import { summarizeArtifactStatus, formatArtifactStatus } from './artifact-status.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-status-test-'));
  mkdirSync(join(dir, 'features'), { recursive: true });
  return dir;
}

function makeFeatureDir(repoDir: string, slug: string): string {
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

function writeTaskContract(featureDir: string, overrides: Record<string, unknown> = {}): void {
  const defaults: Record<string, unknown> = {
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
  const defaults: Record<string, unknown> = {
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
  const merged = { ...defaults, ...overrides };
  writeFileSync(
    join(featureDir, 'feature-state.json'),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
}

function appendTraceEventLine(featureDir: string, event: Record<string, unknown>): void {
  const line = JSON.stringify(event) + '\n';
  appendFileSync(join(featureDir, 'trace.jsonl'), line, 'utf-8');
}

function writeTraceContextFile(featureDir: string, traceId: string, issueId: string, slug: string): void {
  writeFileSync(
    join(featureDir, '.trace-context.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      traceId,
      issueId,
      slug,
      createdAt: new Date().toISOString(),
    }),
    'utf-8',
  );
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const _dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(join(_dirname, '..', '..'));
const TOOL_PATH = join(REPO_DIR, 'tools', 'artifact-status.ts');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('summarizeArtifactStatus', () => {
  let repoDir: string;
  let featureDir: string;

  before(() => {
    repoDir = makeTempRepo();
    featureDir = makeFeatureDir(repoDir, 'test-feature');
  });

  after(() => {
    try { rmSync(repoDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns neutral summary for empty feature dir (legacy task)', () => {
    const emptyDir = makeFeatureDir(repoDir, 'empty-feature');
    const summary = summarizeArtifactStatus({ featureDir: emptyDir, repoDir });
    assert.equal(summary.artifactsPresent, false);
    assert.equal(summary.contract, 'missing');
    assert.equal(summary.outcome.state, null);
    assert.equal(summary.evidenceCount, null);
    assert.equal(summary.trace.traceId, null);
  });

  it('returns neutral summary for nonexistent dir', () => {
    const summary = summarizeArtifactStatus({
      featureDir: join(repoDir, 'does-not-exist'),
      repoDir,
    });
    assert.equal(summary.artifactsPresent, false);
  });

  it('never throws for any input', () => {
    // Should not throw for any scenario
    assert.doesNotThrow(() => summarizeArtifactStatus({ featureDir: '/nonexistent/path', repoDir: '/nonexistent' }));
  });

  describe('all artifacts present and consistent', () => {
    let fullDir: string;

    before(() => {
      fullDir = makeFeatureDir(repoDir, 'full-feature');
      writeTaskContract(fullDir, { issueId: 'HOK-1001', slug: 'full-feature' });
      writeFeatureState(fullDir, {
        issueId: 'HOK-1001',
        slug: 'full-feature',
        currentPhase: 'coding',
        normalizedState: 'running',
        evidence: [
          { kind: 'stage_completion', label: 'planning_stage', status: 'pass' },
          { kind: 'stage_completion', label: 'coding_stage', status: 'pass' },
        ],
      });
      writeFileSync(
        join(fullDir, 'trace.jsonl'),
        JSON.stringify({
          schemaVersion: '1.0',
          traceId: 'trc_test_001',
          issueId: 'HOK-1001',
          slug: 'full-feature',
          timestamp: new Date().toISOString(),
          phase: 'coding',
          event: 'phase_started',
          status: 'ok',
        }) + '\n',
        'utf-8',
      );
      writeTraceContextFile(fullDir, 'trc_test_001', 'HOK-1001', 'full-feature');
    });

    it('detects contract as present', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001', slug: 'full-feature' });
      assert.equal(summary.artifactsPresent, true);
      assert.equal(summary.contract, 'present');
    });

    it('reads outcome state from feature-state.json', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001' });
      assert.equal(summary.outcome.state, 'running');
    });

    it('counts evidence records', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001' });
      assert.equal(summary.evidenceCount, 2);
    });

    it('reads trace id from .trace-context.json', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001' });
      assert.equal(summary.trace.traceId, 'trc_test_001');
    });

    it('reads latest trace event phase and status', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001' });
      assert.equal(summary.trace.latestPhase, 'coding');
      assert.equal(summary.trace.latestStatus, 'ok');
    });

    it('has no route mismatch for consistent artifacts', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001' });
      assert.equal(summary.routeLinkage.mismatch, false);
    });

    it('formats to a compact line within default max width', () => {
      const summary = summarizeArtifactStatus({ featureDir: fullDir, repoDir, issueId: 'HOK-1001' });
      const line = formatArtifactStatus(summary);
      assert.ok(line.length > 0, 'formatted line should be non-empty');
      assert.ok(line.length <= 44, `formatted line length ${line.length} exceeds maxWidth 44`);
      assert.ok(line.includes('ctr=ok'), 'should include contract status');
    });
  });

  describe('partially missing artifacts', () => {
    let partialDir: string;

    before(() => {
      partialDir = makeFeatureDir(repoDir, 'partial-feature');
      writeTaskContract(partialDir, { issueId: 'HOK-1002', slug: 'partial-feature' });
      // No feature-state.json — only contract + trace
      writeFileSync(
        join(partialDir, 'trace.jsonl'),
        JSON.stringify({
          schemaVersion: '1.0',
          traceId: 'trc_test_002',
          issueId: 'HOK-1002',
          slug: 'partial-feature',
          timestamp: new Date().toISOString(),
          phase: 'planning',
          event: 'phase_completed',
          status: 'ok',
        }) + '\n',
        'utf-8',
      );
    });

    it('reports artifacts as present (some exist)', () => {
      const summary = summarizeArtifactStatus({ featureDir: partialDir, repoDir, issueId: 'HOK-1002' });
      assert.equal(summary.artifactsPresent, true);
    });

    it('has null outcome when feature-state.json is absent', () => {
      const summary = summarizeArtifactStatus({ featureDir: partialDir, repoDir, issueId: 'HOK-1002' });
      assert.equal(summary.outcome.state, null);
      assert.equal(summary.outcome.failureReason, null);
    });

    it('has null evidence count when feature-state.json is absent', () => {
      const summary = summarizeArtifactStatus({ featureDir: partialDir, repoDir, issueId: 'HOK-1002' });
      assert.equal(summary.evidenceCount, null);
    });

    it('still reads trace info', () => {
      const summary = summarizeArtifactStatus({ featureDir: partialDir, repoDir, issueId: 'HOK-1002' });
      assert.equal(summary.trace.latestPhase, 'planning');
    });

    it('does not throw', () => {
      assert.doesNotThrow(() =>
        summarizeArtifactStatus({ featureDir: partialDir, repoDir, issueId: 'HOK-1002' }),
      );
    });

    it('formats partial info with dashes for missing fields', () => {
      const summary = summarizeArtifactStatus({ featureDir: partialDir, repoDir, issueId: 'HOK-1002' });
      const line = formatArtifactStatus(summary);
      assert.ok(line.includes('out=-'), `expected out=- in "${line}"`);
      assert.ok(line.includes('ev=-'), `expected ev=- in "${line}"`);
    });
  });

  describe('stale contract (hash drift)', () => {
    let staleDir: string;

    before(() => {
      staleDir = makeFeatureDir(repoDir, 'stale-feature');
      // Write a source file
      writeFileSync(join(staleDir, 'plan.md'), 'original content', 'utf-8');
      const originalHash = sha256Hex('original content');

      // Write contract referencing the source file with its original hash
      writeTaskContract(staleDir, {
        issueId: 'HOK-1003',
        slug: 'stale-feature',
        sources: [
          { path: 'plan.md', exists: true, sha256: originalHash },
        ],
      });

      // Now change the source file so its hash no longer matches
      writeFileSync(join(staleDir, 'plan.md'), 'modified content — now different', 'utf-8');
    });

    it('detects contract as stale when source hash drifts', () => {
      const summary = summarizeArtifactStatus({ featureDir: staleDir, repoDir, issueId: 'HOK-1003', slug: 'stale-feature' });
      assert.equal(summary.contract, 'stale');
    });

    it('sets route linkage mismatch when contract is stale', () => {
      const summary = summarizeArtifactStatus({ featureDir: staleDir, repoDir, issueId: 'HOK-1003', slug: 'stale-feature' });
      assert.equal(summary.routeLinkage.mismatch, true);
    });

    it('includes stale marker in formatted output', () => {
      const summary = summarizeArtifactStatus({ featureDir: staleDir, repoDir, issueId: 'HOK-1003', slug: 'stale-feature' });
      const line = formatArtifactStatus(summary);
      assert.ok(line.includes('stale!'), `expected stale! in "${line}"`);
    });
  });

  describe('malformed artifacts', () => {
    let malformedDir: string;

    before(() => {
      malformedDir = makeFeatureDir(repoDir, 'malformed-feature');
      writeFileSync(join(malformedDir, 'task-contract.json'), '{not valid json', 'utf-8');
      writeFileSync(join(malformedDir, 'feature-state.json'), '   ', 'utf-8');
      writeFileSync(
        join(malformedDir, 'trace.jsonl'),
        'not json\n' + JSON.stringify({
          schemaVersion: '1.0',
          traceId: 'trc_mal',
          issueId: 'HOK-1004',
          slug: 'malformed-feature',
          timestamp: new Date().toISOString(),
          phase: 'coding',
          event: 'phase_started',
          status: 'ok',
        }) + '\n',
        'utf-8',
      );
    });

    it('does not throw on malformed artifacts', () => {
      assert.doesNotThrow(() =>
        summarizeArtifactStatus({ featureDir: malformedDir, repoDir, issueId: 'HOK-1004' }),
      );
    });

    it('reports artifacts as present', () => {
      const summary = summarizeArtifactStatus({ featureDir: malformedDir, repoDir, issueId: 'HOK-1004' });
      assert.equal(summary.artifactsPresent, true);
    });

    it('still reads valid trace events, ignoring malformed lines', () => {
      const summary = summarizeArtifactStatus({ featureDir: malformedDir, repoDir, issueId: 'HOK-1004' });
      assert.equal(summary.trace.latestPhase, 'coding');
    });

    it('produces bounded formatted output', () => {
      const summary = summarizeArtifactStatus({ featureDir: malformedDir, repoDir, issueId: 'HOK-1004' });
      const line = formatArtifactStatus(summary);
      assert.ok(line.length <= 44, `line length ${line.length} exceeds maxWidth`);
    });
  });

  describe('evidence count edge cases', () => {
    it('renders ev=0 when evidence array is empty (not ev=-)', () => {
      const emptyEvidenceDir = makeFeatureDir(repoDir, 'empty-ev-feature');
      writeFeatureState(emptyEvidenceDir, {
        issueId: 'HOK-1005',
        normalizedState: 'running',
        evidence: [],
      });
      writeTaskContract(emptyEvidenceDir);
      const summary = summarizeArtifactStatus({ featureDir: emptyEvidenceDir, repoDir });
      assert.equal(summary.evidenceCount, 0);
      const line = formatArtifactStatus(summary);
      assert.ok(line.includes('ev=0'), `expected ev=0 in "${line}"`);
    });
  });
});

describe('formatArtifactStatus', () => {
  it('returns empty string for non-present artifacts', () => {
    const summary = {
      contract: 'missing' as const,
      outcome: { state: null, failureReason: null },
      evidenceCount: null,
      trace: { traceId: null, latestPhase: null, latestStatus: null },
      routeLinkage: { known: false, mismatch: false, detail: null },
      artifactsPresent: false,
      malformed: false,
    };
    assert.equal(formatArtifactStatus(summary), '');
  });

  it('never exceeds maxWidth for long failure reasons', () => {
    const longReason = 'stage_failed_because_of_some_very_long_reason_string_here';
    const summary = {
      contract: 'present' as const,
      outcome: { state: 'failed', failureReason: longReason },
      evidenceCount: 5,
      trace: { traceId: 'trc_test', latestPhase: 'coding', latestStatus: 'ok' },
      routeLinkage: { known: false, mismatch: false, detail: null },
      artifactsPresent: true,
      malformed: false,
    };
    for (const maxWidth of [20, 30, 40, 44, 60]) {
      const line = formatArtifactStatus(summary, { maxWidth });
      assert.ok(
        line.length <= maxWidth,
        `line length ${line.length} exceeds maxWidth ${maxWidth}: "${line}"`,
      );
    }
  });

  it('includes route! marker when route linkage mismatch is set', () => {
    const summary = {
      contract: 'stale' as const,
      outcome: { state: 'running', failureReason: null },
      evidenceCount: 0,
      trace: { traceId: 'trc_test', latestPhase: 'review', latestStatus: 'ok' },
      routeLinkage: { known: true, mismatch: true, detail: 'contract_hash_drift' },
      artifactsPresent: true,
      malformed: false,
    };
    const line = formatArtifactStatus(summary, { maxWidth: 80 });
    assert.ok(line.includes('route!'), `expected route! in "${line}"`);
  });

  it('drops route! marker to fit within maxWidth', () => {
    const summary = {
      contract: 'stale' as const,
      outcome: { state: 'running', failureReason: null },
      evidenceCount: 2,
      trace: { traceId: 'trc_test', latestPhase: 'review', latestStatus: 'ok' },
      routeLinkage: { known: true, mismatch: true, detail: 'contract_hash_drift' },
      artifactsPresent: true,
      malformed: false,
    };
    // With maxWidth=44, should still fit within limit
    const line = formatArtifactStatus(summary, { maxWidth: 44 });
    assert.ok(line.length <= 44, `line length ${line.length} exceeds 44`);
  });

  it('renders tr=- when trace phase is null', () => {
    const summary = {
      contract: 'present' as const,
      outcome: { state: 'running', failureReason: null },
      evidenceCount: 1,
      trace: { traceId: null, latestPhase: null, latestStatus: null },
      routeLinkage: { known: false, mismatch: false, detail: null },
      artifactsPresent: true,
      malformed: false,
    };
    const line = formatArtifactStatus(summary, { maxWidth: 80 });
    assert.ok(line.includes('tr=-'), `expected tr=- in "${line}"`);
  });

  it('renders trace phase/status when available', () => {
    const summary = {
      contract: 'present' as const,
      outcome: { state: 'running', failureReason: null },
      evidenceCount: 1,
      trace: { traceId: 'trc_x', latestPhase: 'review', latestStatus: 'ok' },
      routeLinkage: { known: false, mismatch: false, detail: null },
      artifactsPresent: true,
      malformed: false,
    };
    const line = formatArtifactStatus(summary, { maxWidth: 80 });
    assert.ok(line.includes('tr=review/ok'), `expected tr=review/ok in "${line}"`);
  });
});

describe('artifact-status CLI tool', () => {
  let repoDir: string;

  before(() => {
    repoDir = makeTempRepo();
  });

  after(() => {
    try { rmSync(repoDir, { recursive: true }); } catch { /* ignore */ }
  });

  function runTool(args: string[]): { stdout: string; exitCode: number } {
    try {
      const stdout = execFileSync(
        'npx',
        ['tsx', TOOL_PATH, ...args],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
      );
      return { stdout, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; status?: number };
      return { stdout: execErr.stdout ?? '', exitCode: execErr.status ?? 1 };
    }
  }

  it('exits 0 for missing path', () => {
    const result = runTool(['--feature-dir', '/nonexistent/path/here']);
    assert.equal(result.exitCode, 0);
  });

  it('produces empty output for missing path', () => {
    const result = runTool(['--feature-dir', '/nonexistent/path/here']);
    assert.equal(result.stdout.trim(), '');
  });

  it('exits 0 for empty feature dir (legacy task)', () => {
    const emptyDir = makeFeatureDir(repoDir, 'cli-empty');
    const result = runTool(['--feature-dir', emptyDir]);
    assert.equal(result.exitCode, 0);
  });

  it('produces empty output for empty feature dir', () => {
    const emptyDir = makeFeatureDir(repoDir, 'cli-empty-2');
    const result = runTool(['--feature-dir', emptyDir]);
    assert.equal(result.stdout.trim(), '');
  });

  it('produces compact line when artifacts are present', () => {
    const dir = makeFeatureDir(repoDir, 'cli-full');
    writeTaskContract(dir, { issueId: 'HOK-2001', slug: 'cli-full' });
    writeFeatureState(dir, { issueId: 'HOK-2001', normalizedState: 'running', evidence: [] });
    const result = runTool(['--feature-dir', dir]);
    assert.equal(result.exitCode, 0);
    const line = result.stdout.trim();
    assert.ok(line.startsWith('art:'), `expected line starting with art:, got "${line}"`);
  });

  it('outputs valid JSON with --json flag', () => {
    const dir = makeFeatureDir(repoDir, 'cli-json');
    writeTaskContract(dir, { issueId: 'HOK-2002', slug: 'cli-json' });
    writeFeatureState(dir, { issueId: 'HOK-2002', normalizedState: 'completed', evidence: [] });
    const result = runTool(['--feature-dir', dir, '--json']);
    assert.equal(result.exitCode, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    const parsed = JSON.parse(result.stdout);
    assert.ok('artifactsPresent' in parsed);
    assert.equal(parsed.artifactsPresent, true);
  });

  it('respects --max-width', () => {
    const dir = makeFeatureDir(repoDir, 'cli-width');
    writeTaskContract(dir, { issueId: 'HOK-2003', slug: 'cli-width' });
    writeFeatureState(dir, {
      issueId: 'HOK-2003',
      normalizedState: 'running',
      evidence: [{ kind: 'stage_completion', label: 'planning_stage', status: 'pass' }],
    });
    const result = runTool(['--feature-dir', dir, '--max-width', '30']);
    assert.equal(result.exitCode, 0);
    const line = result.stdout.trim();
    if (line.length > 0) {
      assert.ok(line.length <= 30, `line length ${line.length} exceeds 30`);
    }
  });
});
