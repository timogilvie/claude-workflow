import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFindings, parseArgs, redactObserverText, syncIncidentsToLinear, writeServiceHeartbeat } from './observer.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import { createIncidentDraft } from '../shared/lib/wavemill-incident-model.ts';

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

function markerFixture(
  markerName: '.coding-complete' | '.plan-approved',
  ageSeconds: number,
  stateAgeSeconds?: number,
  phase: 'coding' | 'planning' = markerName === '.coding-complete' ? 'coding' : 'planning',
  status = 'running',
) {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-marker-repo-'));
  const worktree = mkdtempSync(join(tmpdir(), 'observer-marker-worktree-'));
  const slug = 'marker-fixture';
  const featureDir = join(worktree, 'features', slug);
  const marker = join(featureDir, markerName);
  const now = Date.now();
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(marker, '');
  const markerTime = new Date(now - ageSeconds * 1000);
  utimesSync(marker, markerTime, markerTime);

  return {
    repoDir,
    worktree,
    marker,
    snapshot: {
      timestamp: new Date(now).toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        stateMtime: stateAgeSeconds === undefined ? undefined : new Date(now - stateAgeSeconds * 1000).toISOString(),
        tasks: [{
          issue: 'HOK-2794',
          slug,
          phase,
          status,
          worktree,
        }],
      }],
    },
    cleanup() {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    },
  };
}

test('fresh coding marker within grace period does not produce ignored-marker finding', () => {
  const fixture = markerFixture('.coding-complete', 30, 5);
  try {
    const findings = buildFindings(fixture.snapshot, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2794'), false);
  } finally {
    fixture.cleanup();
  }
});

test('fresh coding marker with unknown state mtime is suppressed by age threshold', () => {
  const fixture = markerFixture('.coding-complete', 30);
  try {
    const findings = buildFindings(fixture.snapshot, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2794'), false);
  } finally {
    fixture.cleanup();
  }
});

test('old coding marker with stale state produces urgent ignored-marker finding with age evidence', () => {
  const fixture = markerFixture('.coding-complete', 15 * 60, 15 * 60);
  try {
    const findings = buildFindings(fixture.snapshot, defaultObserverOptions());
    const finding = findings.find((candidate) => candidate.id === 'coding-marker-ignored-HOK-2794');

    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.match(finding.title, /15 minutes/);
    assert.match(finding.recommendation, /still polling/);
    assert.ok(finding.evidence.includes('statePhase=coding'));
    assert.ok(finding.evidence.includes(`marker=${fixture.marker}`));
    assert.ok(finding.evidence.some((line) => line.startsWith('markerMtime=')));
    assert.ok(finding.evidence.some((line) => line.startsWith('stateMtime=')));
    assert.ok(finding.evidence.includes('thresholdMinutes=10'));
    const markerAgeLine = finding.evidence.find((line) => line.startsWith('markerAgeSeconds='));
    assert.ok(markerAgeLine);
    const markerAgeSeconds = Number(markerAgeLine.slice('markerAgeSeconds='.length));
    assert.ok(markerAgeSeconds >= 890);
  } finally {
    fixture.cleanup();
  }
});

test('old coding marker is suppressed while workflow state is freshly newer than marker', () => {
  const fixture = markerFixture('.coding-complete', 15 * 60, 60);
  try {
    const findings = buildFindings(fixture.snapshot, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2794'), false);
  } finally {
    fixture.cleanup();
  }
});

test('old coding marker with newer but stale state still produces hard stalled recommendation', () => {
  const fixture = markerFixture('.coding-complete', 40 * 60, 20 * 60);
  try {
    const findings = buildFindings(fixture.snapshot, defaultObserverOptions());
    const finding = findings.find((candidate) => candidate.id === 'coding-marker-ignored-HOK-2794');

    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.match(finding.title, /40 minutes/);
    assert.match(finding.recommendation, /hung monitor child/);
  } finally {
    fixture.cleanup();
  }
});

test('planning marker uses same grace period and stale threshold evidence', () => {
  const freshFixture = markerFixture('.plan-approved', 30, 5);
  try {
    const findings = buildFindings(freshFixture.snapshot, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'plan-marker-ignored-HOK-2794'), false);
  } finally {
    freshFixture.cleanup();
  }

  const oldFixture = markerFixture('.plan-approved', 15 * 60, 15 * 60);
  try {
    const findings = buildFindings(oldFixture.snapshot, defaultObserverOptions());
    const finding = findings.find((candidate) => candidate.id === 'plan-marker-ignored-HOK-2794');

    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.match(finding.title, /15 minutes/);
    assert.ok(finding.evidence.includes('statePhase=planning'));
    assert.ok(finding.evidence.some((line) => line.startsWith('markerAgeSeconds=')));
    assert.ok(finding.evidence.some((line) => line.startsWith('stateMtime=')));
  } finally {
    oldFixture.cleanup();
  }
});

test('terminal task status suppresses ignored marker finding', () => {
  const fixture = markerFixture('.coding-complete', 40 * 60, 40 * 60, 'coding', 'merged');
  try {
    const findings = buildFindings(fixture.snapshot, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2794'), false);
  } finally {
    fixture.cleanup();
  }
});

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

test('duplicate observer panes produce one high-severity operational finding', () => {
  const findings = buildFindings({
    timestamp: '2026-08-22T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [
      { session: 'wavemill', windowIndex: '1', paneIndex: '1', windowName: 'backstage', active: false, pid: 101, command: 'npm', title: 'Wavemill Observer' },
      { session: 'wavemill', windowIndex: '1', paneIndex: '2', windowName: 'backstage', active: false, pid: 201, command: 'npm', title: 'Wavemill Observer' },
      { session: 'wavemill', windowIndex: '1', paneIndex: '3', windowName: 'backstage', active: false, pid: 301, command: 'npm', title: 'Wavemill Observer' },
    ],
    processes: [
      { pid: 101, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
      { pid: 102, ppid: 101, stat: 'S', elapsedSeconds: 10, command: 'node tools/observer.ts --loop --session wavemill' },
      { pid: 201, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
      { pid: 301, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
    ],
    repos: [{ session: 'wavemill', repoDir: '/tmp/repo', tasks: [] }],
  }, defaultObserverOptions());

  const duplicate = findings.find((finding) => finding.id === 'duplicate-observer-wavemill');
  assert.ok(duplicate);
  assert.equal(duplicate.severity, 'high');
  assert.equal(duplicate.category, 'operational');
  assert.equal(duplicate.confidence, 'high');
  assert.match(duplicate.title, /3 Observer loops are running/);
  assert.ok(duplicate.evidence.some((line) => line.includes('1.1') && line.includes('1.3')));
  assert.ok(duplicate.evidence.some((line) => line.includes('101') && line.includes('301')));
});

test('single observer pane does not produce duplicate finding', () => {
  const findings = buildFindings({
    timestamp: '2026-08-22T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [
      { session: 'wavemill', windowIndex: '1', paneIndex: '1', windowName: 'backstage', active: false, pid: 101, command: 'npm', title: 'Wavemill Observer' },
    ],
    processes: [
      { pid: 101, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
      { pid: 102, ppid: 101, stat: 'S', elapsedSeconds: 10, command: 'node tools/observer.ts --loop --session wavemill' },
    ],
    repos: [{ session: 'wavemill', repoDir: '/tmp/repo', tasks: [] }],
  }, defaultObserverOptions());

  assert.equal(findings.some((finding) => finding.id === 'duplicate-observer-wavemill'), false);
});

test('duplicate observer finding respects pane title override', () => {
  const previous = process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE;
  process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE = 'Custom Observer';
  try {
    const findings = buildFindings({
      timestamp: '2026-08-22T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [
        { session: 'wavemill', windowIndex: '1', paneIndex: '1', windowName: 'backstage', active: false, pid: 101, command: 'npm', title: 'Custom Observer' },
        { session: 'wavemill', windowIndex: '1', paneIndex: '2', windowName: 'backstage', active: false, pid: 201, command: 'npm', title: 'Custom Observer' },
      ],
      processes: [],
      repos: [{ session: 'wavemill', repoDir: '/tmp/repo', tasks: [] }],
    }, defaultObserverOptions());

    assert.ok(findings.some((finding) => finding.id === 'duplicate-observer-wavemill'));
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE;
    } else {
      process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE = previous;
    }
  }
});

test('service heartbeat is parseable and stores redacted finding counts only', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-heartbeat-'));
  try {
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({
      services: {
        observer: {
          status: 'healthy',
          instanceCount: 1,
        },
      },
    }));

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
    assert.equal(parsed.services.observer.instanceCount, 1);
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

test('incident sync caps live incident processing per pass', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-incident-cap-'));
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    for (let i = 0; i < 40; i += 1) {
      await store.upsert(createIncidentDraft({
        taskId: `HOK-${1000 + i}`,
        category: 'product_defect',
        severity: 'high',
        confidence: 'definite',
        lifecycle: 'active',
        rootCauseClass: 'observer_crash',
        summary: `Observer crashed ${i}.`,
        operatorAction: 'Fix parser.',
        evidence: [{
          type: 'log_excerpt',
          source: `mill-${i}.log`,
          timestamp: '2026-08-04T12:00:00.000Z',
          redactedData: `ERROR ${i}`,
          key: `error-${i}`,
        }],
        metadata: { thresholdTriggered: true },
      }));
    }

    const snapshot = await syncIncidentsToLinear({
      timestamp: '2026-08-04T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
      findings: [],
    }, {
      ...defaultObserverOptions(),
      fileIncidents: true,
    });

    assert.equal(snapshot.incidentSync?.totalProcessed, 10);
    assert.equal(snapshot.incidentSync?.skipped, 40);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
