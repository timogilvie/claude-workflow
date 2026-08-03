import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFindings, parseArgs, redactObserverText, writeServiceHeartbeat } from './observer.ts';

test('repeated ready watchdog auto-recoveries escalate to actionable stuck finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-watchdog-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '23:18:54 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 15m while PR #437 is clean and green.',
    '23:31:13 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 11m while PR #437 is clean and green.',
    '00:01:47 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 17m while PR #437 is clean and green.',
    '00:41:56 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 21m while PR #437 is clean and green.',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-05-29T13:00:02.545Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [{
          issue: 'HOK-1892',
          phase: 'ready',
          status: 'running',
          pr: '437',
        }],
      }],
    }, {
      loop: false,
      once: true,
      json: false,
      intervalSeconds: 120,
      staleMinutes: 10,
      hungMinutes: 10,
      fileLinear: false,
      dryRun: false,
      maxLogLines: 240,
      printPrompt: false,
      incidents: false,
    });

    const stuck = findings.find((finding) => finding.id.startsWith('repeated-ready-watchdog-'));
    assert.ok(stuck);
    assert.equal(stuck.severity, 'high');
    assert.equal(stuck.category, 'stuck');
    assert.equal(stuck.confidence, 'high');
    assert.equal(stuck.issue, 'HOK-1892');
    assert.match(stuck.title, /repeatedly triggers ready watchdog auto-recovered/);
    assert.equal(stuck.evidence[0], 'occurrences=4');
    assert.equal(findings.filter((finding) => finding.title === 'Recent mill log contains a warning').length, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('service mode rejects Linear filing', () => {
  const previous = process.env.WAVEMILL_OBSERVER_SERVICE;
  process.env.WAVEMILL_OBSERVER_SERVICE = '1';
  try {
    assert.throws(() => parseArgs(['--loop', '--file-linear']), /--file-linear is not allowed/);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_OBSERVER_SERVICE;
    } else {
      process.env.WAVEMILL_OBSERVER_SERVICE = previous;
    }
  }
});

test('service heartbeat is parseable and stores redacted finding counts only', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-heartbeat-'));
  try {
    await writeServiceHeartbeat({
      timestamp: '2026-08-03T12:00:00.000Z',
      sessions: ['wavemill-test'],
      panes: [],
      processes: [],
      repos: [],
      findings: [{
        id: 'secret-finding',
        severity: 'high',
        category: 'warning',
        confidence: 'high',
        title: 'Secret in log',
        evidence: ['OPENAI_API_KEY=sk-secret prompt=do the hidden task'],
        recommendation: 'Inspect redacted evidence',
      }],
    }, {
      loop: true,
      once: false,
      json: true,
      intervalSeconds: 120,
      staleMinutes: 10,
      hungMinutes: 10,
      fileLinear: false,
      dryRun: true,
      maxLogLines: 240,
      printPrompt: false,
      incidents: false,
      repoDir,
      session: 'wavemill-test',
      serviceMode: true,
    });

    const raw = readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.services.observer.status, 'healthy');
    assert.equal(parsed.services.observer.heartbeatAt, '2026-08-03T12:00:00.000Z');
    assert.equal(parsed.services.observer.findingCounts.high, 1);
    assert.doesNotMatch(raw, /sk-secret|hidden task/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('observer redaction removes credentials and prompt-like evidence', () => {
  assert.equal(
    redactObserverText('OPENAI_API_KEY=sk-test token=abc123 prompt=full task'),
    'OPENAI_API_KEY=[redacted] token=[redacted] prompt=[redacted]',
  );
});

test('observer parses incidents flags', () => {
  const parsed = parseArgs(['--incidents', '--incident-thresholds-config', '/tmp/thresholds.json']);
  assert.equal(parsed.incidents, true);
  assert.equal(parsed.incidentThresholdsConfig, '/tmp/thresholds.json');
});

test('observer --incidents emits JSON incidents and keeps findings array', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-incidents-'));
  try {
    const featureDir = join(repoDir, 'features', 'detect-failure');
    writeJson(join(repoDir, '.wavemill', 'workflow-state.json'), {
      tasks: {
        'HOK-2595': { slug: 'detect-failure', worktree: repoDir, phase: 'planning', status: 'running', agent: 'codex' },
      },
    });
    writeJson(join(featureDir, '.planning-result.json'), {
      stage: 'planning',
      status: 'failed',
      startedAt: '2026-08-03T12:00:00.000Z',
      finishedAt: '2026-08-03T12:05:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      notes: '',
      failureReason: 'turn_limit',
      artifacts: { type: 'planning', planArtifactValid: false, bounds: { maxTurns: 5 }, usage: { turnsCompleted: 5 } },
    });

    const output = execFileSync('npx', [
      'tsx',
      resolve('tools/observer.ts'),
      '--once',
      '--json',
      '--incidents',
      '--repo-dir',
      repoDir,
    ], { encoding: 'utf-8', cwd: resolve('.') });
    const snapshot = JSON.parse(output);
    assert.equal(Array.isArray(snapshot.findings), true);
    assert.equal(Array.isArray(snapshot.incidents), true);
    assert.equal(snapshot.incidents[0].normalizedRootCauseClass, 'native_planning_turn_limit');
    assert.equal(snapshot.incidents[0].issue, 'HOK-2595');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
