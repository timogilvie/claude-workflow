import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFindings, parseArgs, redactObserverText, syncIncidentsToLinear, writeServiceHeartbeat } from './observer.ts';

function defaultObserverOptions() {
  return {
    loop: false,
    once: true,
    json: false,
    intervalSeconds: 120,
    staleMinutes: 10,
    hungMinutes: 10,
    fileLinear: false,
    fileIncidents: false,
    dryRun: false,
    incidentsDryRun: false,
    maxLogLines: 240,
    printPrompt: false,
    incidentDetector: true,
  };
}

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
      fileIncidents: false,
      dryRun: false,
      incidentsDryRun: false,
      maxLogLines: 240,
      printPrompt: false,
      incidentDetector: true,
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

test('degraded queue health returns structured finding without throwing', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-degraded-'));
  try {
    const findings = buildFindings({
      timestamp: '2026-08-10T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'dependency_planning_failed',
          episodeStartedAt: '2026-08-10T00:00:00Z',
          failureCount: 3,
          retryBackoffSeconds: 60,
          lastAttemptAt: '2026-08-10T00:05:00Z',
          diagnostics: { stderrExcerpt: 'plan_queue_failed exit 143' },
        },
        tasks: [],
      }],
    }, defaultObserverOptions());

    const degraded = findings.find((finding) => finding.id.startsWith('queue-health-degraded-'));
    assert.ok(degraded);
    assert.equal(degraded.severity, 'medium');
    assert.equal(degraded.category, 'warning');
    assert.match(degraded.title, /dependency_planning_failed/);
    assert.ok(degraded.evidence.includes('failureCount=3'));
    assert.ok(degraded.evidence.includes('stderr=plan_queue_failed exit 143'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('degraded queue health suppresses only generic queue analysis warning', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-warning-suppressed-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '12:01:02 [status] WARN queue analysis unavailable; using flat fallback',
    '12:02:03 [status] WARN task handoff timed out',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-08-10T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'plan_queue_failed',
          episodeStartedAt: '2026-08-10T00:00:00Z',
          failureCount: 5,
        },
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.ok(findings.some((finding) => finding.id.startsWith('queue-health-degraded-')));
    assert.equal(findings.some((finding) => (
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /queue analysis unavailable/i.test(line))
    )), false);
    assert.ok(findings.some((finding) => (
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /task handoff timed out/i.test(line))
    )));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('healthy queue health keeps generic queue analysis warning', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-warning-healthy-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, '12:01:02 [status] WARN queue analysis unavailable; using flat fallback\n');

  try {
    const findings = buildFindings({
      timestamp: '2026-08-10T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        queueHealth: { status: 'ok' },
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('queue-health-degraded-')), false);
    assert.ok(findings.some((finding) => (
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /queue analysis unavailable/i.test(line))
    )));
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
      fileIncidents: false,
      dryRun: true,
      incidentsDryRun: false,
      maxLogLines: 240,
      printPrompt: false,
      incidentDetector: true,
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

test('incident Linear flags imply filing mode and parse replay/policy controls', () => {
  const options = parseArgs([
    '--file-incidents',
    '--incidents-dry-run',
    '--incidents-replay',
    'abc123',
    '--incidents-policy',
    '{"external_transient_dependency":{"strategy":"threshold","threshold":5}}',
  ]);
  assert.equal(options.fileIncidents, true);
  assert.equal(options.incidentsDryRun, true);
  assert.equal(options.incidentsReplay, 'abc123');
  assert.match(options.incidentsPolicy ?? '', /external_transient_dependency/);
});

test('incident sync snapshot is omitted when incident filing is disabled', async () => {
  const snapshot = await syncIncidentsToLinear({
    timestamp: '2026-08-04T12:00:00.000Z',
    sessions: [],
    panes: [],
    processes: [],
    repos: [],
    findings: [],
  }, {
    loop: false,
    once: true,
    json: false,
    intervalSeconds: 120,
    staleMinutes: 10,
    hungMinutes: 10,
    fileLinear: false,
    fileIncidents: false,
    dryRun: false,
    incidentsDryRun: false,
    maxLogLines: 240,
    printPrompt: false,
    incidentDetector: true,
  });
  assert.equal(snapshot.incidentSync, undefined);
});
