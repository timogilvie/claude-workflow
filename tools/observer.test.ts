import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFindings, parseArgs, redactObserverText, syncIncidentsToLinear, writeServiceHeartbeat } from './observer.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import { createIncidentDraft } from '../shared/lib/wavemill-incident-model.ts';
import { isLogNoiseFinding } from '../shared/lib/observer-status-renderer.ts';
import { clearConfigCache } from '../shared/lib/config.ts';
import { clearConfigIntegrityCache } from '../shared/lib/config-integrity.ts';

const CANONICAL_SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'wavemill-config.schema.json',
);
const OBSERVER_TS = resolve(dirname(fileURLToPath(import.meta.url)), 'observer.ts');

function seedWorktreeSchema(repoDir: string, options: { corrupt?: boolean } = {}): string {
  const target = join(repoDir, 'wavemill-config.schema.json');
  copyFileSync(CANONICAL_SCHEMA_PATH, target);
  if (options.corrupt) {
    const original = readFileSync(target, 'utf-8');
    const injectAt = 500;
    writeFileSync(target, `${original.slice(0, injectAt)}},BREAK\n${original.slice(injectAt)}`);
  }
  return target;
}

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

function createMarkerFixture(markerName: '.coding-complete' | '.plan-approved', markerMtime: Date) {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-marker-'));
  const slug = 'observer-marker-fixture';
  const featureDir = join(repoDir, 'features', slug);
  const markerPath = join(featureDir, markerName);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(markerPath, '{}\n');
  utimesSync(markerPath, markerMtime, markerMtime);
  return { repoDir, slug, markerPath };
}

function markerSnapshot({
  repoDir,
  slug,
  phase,
  issue = 'HOK-2848',
  stateMtime,
}: {
  repoDir: string;
  slug: string;
  phase: 'coding' | 'planning';
  issue?: string;
  stateMtime?: string;
}) {
  return {
    timestamp: new Date().toISOString(),
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir,
      workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
      tasks: [{
        issue,
        phase,
        status: 'running',
        slug,
        worktree: repoDir,
      }],
      stateMtime,
    }],
  };
}

function markerAgeSeconds(finding: { evidence: string[] }): number {
  const evidence = finding.evidence.find((line) => line.startsWith('markerAgeSeconds='));
  assert.ok(evidence);
  return Number(evidence.slice('markerAgeSeconds='.length));
}

test('fresh coding marker does not produce marker-ignored finding', () => {
  const markerMtime = new Date(Date.now() - 30_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
    }), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('old coding marker produces urgent marker-ignored finding with age evidence', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const stateMtime = new Date(markerMtime.getTime() - 60_000).toISOString();
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      stateMtime,
    }), defaultObserverOptions());

    const finding = findings.find((candidate) => candidate.id === 'coding-marker-ignored-HOK-2848');
    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.equal(finding.category, 'stuck');
    assert.equal(finding.issue, 'HOK-2848');
    assert.match(finding.title, /still in coding \d+ minutes after \.coding-complete appeared/);
    assert.ok(finding.evidence.includes('statePhase=coding'));
    assert.ok(finding.evidence.includes(`marker=${fixture.markerPath}`));
    assert.ok(finding.evidence.some((line) => line.startsWith('markerMtime=')));
    assert.ok(markerAgeSeconds(finding) >= 1700);
    assert.ok(finding.evidence.includes(`stateMtime=${stateMtime}`));
    assert.match(finding.recommendation, /hung monitor child/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('newer workflow state modulates the coding marker finding but does not suppress it', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const stateMtime = new Date(markerMtime.getTime() + 60_000).toISOString();
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      stateMtime,
    }), defaultObserverOptions());

    // A newer workflow-state.json must NOT hide a genuinely wedged task: in a
    // multi-task mill, state is rewritten constantly for other tasks.
    const finding = findings.find((entry) => entry.id === 'coding-marker-ignored-HOK-2848');
    assert.ok(finding, 'expected the marker-ignored finding to still be produced');
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.ok(finding.evidence.includes('stateNewerThanMarker=true'));
    assert.match(finding.recommendation, /still writing workflow state but has not advanced this task/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('older workflow state keeps the hung-monitor recommendation', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const stateMtime = new Date(markerMtime.getTime() - 60_000).toISOString();
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      stateMtime,
    }), defaultObserverOptions());

    const finding = findings.find((entry) => entry.id === 'coding-marker-ignored-HOK-2848');
    assert.ok(finding, 'expected the marker-ignored finding to be produced');
    assert.ok(finding.evidence.includes('stateNewerThanMarker=false'));
    assert.match(finding.recommendation, /hung monitor child process/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('coding marker-ignored threshold follows stale minutes option', () => {
  const markerMtime = new Date(Date.now() - 3 * 60_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const snapshot = markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
    });

    const strictFindings = buildFindings(snapshot, { ...defaultObserverOptions(), staleMinutes: 2 });
    assert.ok(strictFindings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2848'));

    const defaultFindings = buildFindings(snapshot, { ...defaultObserverOptions(), staleMinutes: 10 });
    assert.equal(defaultFindings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('planning marker mirrors coding marker grace behavior', () => {
  const freshMarkerMtime = new Date(Date.now() - 30_000);
  const oldMarkerMtime = new Date(Date.now() - 30 * 60_000);
  const freshFixture = createMarkerFixture('.plan-approved', freshMarkerMtime);
  const oldFixture = createMarkerFixture('.plan-approved', oldMarkerMtime);

  try {
    const freshFindings = buildFindings(markerSnapshot({
      repoDir: freshFixture.repoDir,
      slug: freshFixture.slug,
      phase: 'planning',
    }), defaultObserverOptions());
    assert.equal(freshFindings.some((finding) => finding.id === 'plan-marker-ignored-HOK-2848'), false);

    const oldFindings = buildFindings(markerSnapshot({
      repoDir: oldFixture.repoDir,
      slug: oldFixture.slug,
      phase: 'planning',
    }), defaultObserverOptions());
    const finding = oldFindings.find((candidate) => candidate.id === 'plan-marker-ignored-HOK-2848');
    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.equal(finding.category, 'stuck');
    assert.match(finding.title, /still in planning \d+ minutes after \.plan-approved appeared/);
    assert.ok(markerAgeSeconds(finding) >= 1700);
    assert.ok(finding.evidence.some((line) => line.startsWith('markerMtime=')));
    assert.ok(finding.evidence.includes('stateMtime=unknown'));
  } finally {
    rmSync(freshFixture.repoDir, { recursive: true, force: true });
    rmSync(oldFixture.repoDir, { recursive: true, force: true });
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

test('structured log scanning aggregates repeated errors and ignores prose false positives', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-log-scanner-'));
  const fixtureLogPath = join(process.cwd(), 'tests', 'fixtures', 'observer', 'test-log.txt');
  const variantLogPath = join(repoDir, 'variant.log');
  writeFileSync(variantLogPath, '12:45:01 [error] Monitor command failed pid=42 tmp=/tmp/wavemill-plan-c stderr=Error: EAGAIN\n');

  try {
    const findings = buildFindings({
      timestamp: '2026-08-24T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: fixtureLogPath,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'dependency_planning_failed',
          episodeStartedAt: '2026-08-24T00:00:00Z',
          failureCount: 4,
        },
        tasks: [{
          issue: 'HOK-1892',
          phase: 'ready',
          status: 'running',
          pr: '437',
        }],
      }],
    }, defaultObserverOptions());

    const errorFindings = findings.filter((finding) => finding.id.startsWith('log-error-'));
    assert.equal(errorFindings.length, 1);
    const error = errorFindings[0];
    assert.equal(error.severity, 'high');
    assert.equal(error.confidence, 'high');
    assert.equal(error.occurrenceCount, 2);
    assert.ok(error.evidence.includes('occurrences=2'));
    assert.ok(error.evidence.includes('normalizedMessage=Monitor command failed pid=<pid> tmp=<tmp> stderr=Error: EAGAIN'));
    assert.equal(error.evidence.some((line) => /error detection|error handling/.test(line)), false);

    const variantFindings = buildFindings({
      timestamp: '2026-08-24T12:01:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: variantLogPath,
        tasks: [],
      }],
    }, defaultObserverOptions());
    const variantError = variantFindings.find((finding) => finding.id.startsWith('log-error-'));
    assert.ok(variantError);
    assert.equal(variantError.id, error.id);

    const warningFindings = findings.filter((finding) => finding.id.startsWith('log-warning-'));
    assert.equal(warningFindings.length, 1);
    const warning = warningFindings[0];
    assert.equal(warning.severity, 'low');
    assert.equal(warning.confidence, 'high');
    assert.equal(warning.occurrenceCount, 1);
    assert.ok(warning.evidence.some((line) => /task handoff timed out/.test(line)));
    assert.equal(warning.evidence.some((line) => /queue analysis unavailable|ready watchdog/.test(line)), false);
    assert.ok(findings.some((finding) => finding.id.startsWith('queue-health-degraded-')));
    assert.ok(findings.some((finding) => finding.id.startsWith('repeated-ready-watchdog-')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('degraded queue health suppresses only generic queue analysis warning', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-warning-suppressed-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '12:01:02 [warn] queue analysis unavailable; using flat fallback',
    '12:02:03 [warn] task handoff timed out',
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
  writeFileSync(logPath, '12:01:02 [warn] queue analysis unavailable; using flat fallback\n');

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

test('rejected eval quarantine files produce operator-visible finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-rejected-evals-'));
  const rejectedDir = join(repoDir, '.wavemill', 'evals', 'rejected');
  mkdirSync(rejectedDir, { recursive: true });
  writeFileSync(join(rejectedDir, '2026-08-22T00-00-00-000Z-HOK-1-primary.json'), '{}\n');
  writeFileSync(join(rejectedDir, '2026-08-23T00-00-00-000Z-HOK-2-challenger.json'), '{}\n');
  writeFileSync(join(rejectedDir, 'ignored.txt'), 'not json');

  try {
    const findings = buildFindings({
      timestamp: '2026-08-23T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [],
      }],
    }, defaultObserverOptions());

    const finding = findings.find((candidate) => candidate.id.startsWith('eval-rejected-records-'));
    assert.ok(finding);
    assert.equal(finding.severity, 'medium');
    assert.equal(finding.category, 'warning');
    assert.equal(finding.confidence, 'high');
    assert.match(finding.title, /2 eval records rejected/);
    assert.ok(finding.evidence.includes('count=2'));
    assert.ok(finding.evidence.some((line) => line.includes('newest=2026-08-23T00-00-00-000Z-HOK-2-challenger.json')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('missing rejected eval quarantine directory produces no finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-no-rejected-evals-'));
  try {
    const findings = buildFindings({
      timestamp: '2026-08-23T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.some((candidate) => candidate.id.startsWith('eval-rejected-records-')), false);
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

test('stale active challenge arm with no live pane or process is surfaced', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stale-arm-'));
  const worktree = join(repoDir, 'worktrees', 'demo-challenger');
  mkdirSync(worktree, { recursive: true });
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        stateMtime: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        tasks: [{
          issue: 'HOK-2846_c',
          slug: 'demo-challenger',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          challengeRole: 'challenger',
        }],
      }],
    }, defaultObserverOptions());

    const stuck = findings.find((finding) => finding.id === 'stale-active-task-no-live-process-wavemill-HOK-2846_c');
    assert.ok(stuck);
    assert.equal(stuck.severity, 'high');
    assert.equal(stuck.category, 'stuck');
    assert.equal(stuck.confidence, 'high');
    assert.equal(stuck.issue, 'HOK-2846_c');
    assert.match(stuck.title, /no live pane or process evidence/);
    assert.ok(stuck.evidence.includes(`worktree=${worktree}`));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('fresh active challenge arm is not surfaced as stale', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-fresh-arm-'));
  const worktree = join(repoDir, 'worktrees', 'fresh-challenger');
  mkdirSync(worktree, { recursive: true });
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [{
          issue: 'HOK-2846_c',
          slug: 'fresh-challenger',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          challengeRole: 'challenger',
        }],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('stale-active-task-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
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

test('repeated failed-ready re-checks surface a stuck loop finding with the blocking reason', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-recheck-'));
  const slug = 'ready-recheck-fixture';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'failed',
    failureReason: 'PR #1260 removes files from #1240 without explicit acknowledgement.',
  }));

  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '09:52:17 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
    '09:52:37 [status] ⛔ HOK-2888 → Cross-PR revert guard blocked ready phase for PR #1260',
    '09:53:31 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
    '09:54:04 [status] ⛔ HOK-2888 → Cross-PR revert guard blocked ready phase for PR #1260',
    '09:55:49 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-08-27T14:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [{
          issue: 'HOK-2888',
          slug,
          phase: 'ready',
          status: 'active',
          pr: '1260',
          worktree: repoDir,
        }],
      }],
    }, defaultObserverOptions());

    const loop = findings.find((finding) => finding.id.startsWith('ready-recheck-loop-'));
    assert.ok(loop);
    assert.equal(loop.severity, 'high');
    assert.equal(loop.category, 'stuck');
    assert.equal(loop.issue, 'HOK-2888');
    assert.equal(loop.evidence[0], 'occurrences=3');
    assert.equal(loop.evidence[1], 'pr=#1260');
    assert.match(loop.evidence[2], /without explicit acknowledgement/);
    assert.match(loop.recommendation, /no retry ceiling/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a single failed-ready re-check stays below the loop threshold', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-recheck-once-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '09:52:17 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
    '09:52:57 [status] ↻ HOK-2889 → Re-running failed ready checks for PR #1261',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-08-27T14:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.filter((finding) => finding.id.startsWith('ready-recheck-loop-')).length, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Config-integrity detector + correlation + degraded-mode startup
// ─────────────────────────────────────────────────────────────────────────

test('broken worktree schema surfaces an urgent, actionable config-integrity finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-config-integrity-'));
  seedWorktreeSchema(repoDir, { corrupt: true });
  clearConfigCache(repoDir);
  clearConfigIntegrityCache();

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
    }, defaultObserverOptions());

    const finding = findings.find((entry) => entry.id.startsWith('config-integrity-'));
    assert.ok(finding, 'expected a config-integrity finding');
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.category, 'operational');
    assert.equal(finding.confidence, 'high');
    assert.equal(finding.repoDir, repoDir);
    assert.match(finding.title, /Config integrity failure in wavemill-config\.schema\.json: schema-parse/);
    assert.ok(finding.evidence.some((line) => line.startsWith('file=')));
    assert.ok(finding.evidence.some((line) => line.startsWith('kind=schema-parse')));
    assert.ok(finding.evidence.some((line) => line.startsWith('line=')));
    assert.ok(finding.evidence.some((line) => line.startsWith('column=')));
    assert.ok(finding.evidence.some((line) => line.startsWith('excerpt=')));
    assert.match(finding.recommendation, /Every wavemill TS entrypoint exits 1 until this file parses/);
    // Renderer must treat this as actionable, not log-noise.
    assert.equal(isLogNoiseFinding(finding.id), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    clearConfigCache(repoDir);
    clearConfigIntegrityCache();
  }
});

test('config-integrity finding absorbs downstream watchdog/model/eval log noise into its evidence', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-config-downstream-'));
  seedWorktreeSchema(repoDir, { corrupt: true });
  const logPath = join(repoDir, 'mill.log');
  writeFileSync(logPath, [
    "13:00:01 [error] challenge aborted because selected coding model 'claude-opus-4-7' failed validation (model selector is not valid for this repo)",
    "13:00:02 [error] challenge aborted because selected coding model 'claude-opus-4-7' failed validation (model selector is not valid for this repo)",
    "13:00:03 [error] ready watchdog tick failed: Error: Unexpected non-whitespace character after JSON at position 500",
    "13:00:04 [error] Post-completion eval: failed (workflow unaffected)",
    "13:00:05 [warn] queue analysis unavailable; using flat fallback",
  ].join('\n'));
  clearConfigCache(repoDir);
  clearConfigIntegrityCache();

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, millLogPath: logPath, tasks: [] }],
    }, defaultObserverOptions());

    const integrity = findings.find((entry) => entry.id.startsWith('config-integrity-'));
    assert.ok(integrity, 'expected config-integrity finding');
    const downstream = integrity.evidence.filter((line) => line.startsWith('downstream='));
    assert.ok(downstream.length >= 3, `expected at least 3 downstream signatures, got ${downstream.join(' | ')}`);
    assert.ok(downstream.some((line) => /failed validation/.test(line)));
    assert.ok(downstream.some((line) => /ready watchdog tick failed/.test(line)));
    assert.ok(downstream.some((line) => /Post-completion eval: failed/.test(line)));

    // The absorbed downstream messages must NOT also appear as independent
    // log-error/log-warning findings.
    const independentDownstream = findings.filter((entry) => {
      if (!/^log-(error|warning)-/.test(entry.id)) return false;
      const text = entry.evidence.join(' ');
      return /failed validation|ready watchdog tick failed|Post-completion eval: failed/.test(text);
    });
    assert.equal(independentDownstream.length, 0, `expected downstream messages to be absorbed, got ${independentDownstream.map((f) => f.id).join(', ')}`);

    // Unrelated messages remain independent (queue analysis warning here is
    // filtered by the existing queueHealth suppression only when degraded;
    // this fixture has no queueHealth, so it should fall through as its own
    // finding rather than being wrongly absorbed).
    assert.ok(findings.some((entry) => (
      /^log-warning-/.test(entry.id) &&
      entry.evidence.some((line) => /queue analysis unavailable/i.test(line))
    )));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    clearConfigCache(repoDir);
    clearConfigIntegrityCache();
  }
});

test('silent model downgrade above threshold emits its own high-severity finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-model-downgrade-'));
  const logPath = join(repoDir, 'mill.log');
  writeFileSync(logPath, [
    "13:00:01 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    "13:00:02 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    "13:00:03 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    // Distinct legitimate variant that must never match.
    "13:00:04 [warn]   'deep' looks like a depth tag, not a model",
    // Unrelated warning that should still fall through.
    "13:00:05 [warn] queue analysis unavailable; using flat fallback",
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, millLogPath: logPath, tasks: [] }],
    }, defaultObserverOptions());

    const downgrade = findings.find((entry) => entry.id.startsWith('model-downgrade-'));
    assert.ok(downgrade, 'expected a model-downgrade finding');
    assert.equal(downgrade.severity, 'high');
    assert.equal(downgrade.category, 'operational');
    assert.equal(downgrade.confidence, 'high');
    assert.equal(downgrade.occurrenceCount, 3);
    assert.match(downgrade.title, /coding 'claude-sonnet-5' to 'claude-opus-4-7' \(3 launches\)/);
    assert.ok(downgrade.evidence.includes('stage=coding'));
    assert.ok(downgrade.evidence.includes('requestedModel=claude-sonnet-5'));
    assert.ok(downgrade.evidence.includes('fallbackModel=claude-opus-4-7'));
    assert.match(downgrade.recommendation, /correctness regression/);

    // Same lines must not also appear as generic log-warning noise.
    const downgradeInWarning = findings.filter((entry) => (
      entry.id.startsWith('log-warning-') &&
      entry.evidence.some((line) => /Invalid coding model 'claude-sonnet-5'/.test(line))
    ));
    assert.equal(downgradeInWarning.length, 0);

    // Unrelated warning still surfaces via generic scrape.
    assert.ok(findings.some((entry) => (
      entry.id.startsWith('log-warning-') &&
      entry.evidence.some((line) => /queue analysis unavailable/i.test(line))
    )));
    // The 'looks like a depth tag' variant must never be treated as a downgrade.
    const spuriousDowngrade = findings.some((entry) => (
      entry.id.startsWith('model-downgrade-') &&
      entry.evidence.some((line) => /looks like a depth tag/.test(line))
    ));
    assert.equal(spuriousDowngrade, false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('model downgrade below threshold does not emit a model-downgrade finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-model-downgrade-below-'));
  const logPath = join(repoDir, 'mill.log');
  writeFileSync(logPath, [
    "13:00:01 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    "13:00:02 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, millLogPath: logPath, tasks: [] }],
    }, defaultObserverOptions());

    assert.equal(findings.some((entry) => entry.id.startsWith('model-downgrade-')), false);
    // Below the threshold the lines still surface via the generic warning scrape.
    assert.ok(findings.some((entry) => (
      entry.id.startsWith('log-warning-') &&
      entry.evidence.some((line) => /Invalid coding model 'claude-sonnet-5'/.test(line))
    )));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('config-integrity finding annotates concurrent model-downgrade finding with probable root cause', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-config-annotates-downgrade-'));
  seedWorktreeSchema(repoDir, { corrupt: true });
  const logPath = join(repoDir, 'mill.log');
  writeFileSync(logPath, [
    "13:00:01 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    "13:00:02 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    "13:00:03 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
  ].join('\n'));
  clearConfigCache(repoDir);
  clearConfigIntegrityCache();

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, millLogPath: logPath, tasks: [] }],
    }, defaultObserverOptions());

    const downgrade = findings.find((entry) => entry.id.startsWith('model-downgrade-'));
    assert.ok(downgrade);
    assert.ok(downgrade.evidence.some((line) => line.startsWith('probableRootCause=config-integrity')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    clearConfigCache(repoDir);
    clearConfigIntegrityCache();
  }
});

test('observer --once exits 0 and still reports config-independent findings when the schema is malformed', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-degraded-startup-'));
  seedWorktreeSchema(repoDir, { corrupt: true });

  // Config-independent problem: a >stale coding marker.
  const slug = 'degraded-fixture';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  const markerPath = join(featureDir, '.coding-complete');
  writeFileSync(markerPath, '{}\n');
  const staleTime = new Date(Date.now() - 30 * 60_000);
  utimesSync(markerPath, staleTime, staleTime);

  const stateDir = join(repoDir, '.wavemill');
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2908_c': {
        slug,
        phase: 'coding',
        status: 'active',
        worktree: repoDir,
        updated: staleTime.toISOString(),
      },
    },
  }));

  try {
    const result = spawnSync(
      'npx',
      ['tsx', OBSERVER_TS, '--once', '--json', '--repo-dir', repoDir],
      { encoding: 'utf-8', timeout: 60_000 },
    );

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`);
    assert.ok(result.stdout.length > 0, 'expected non-empty JSON snapshot');
    const snapshot = JSON.parse(result.stdout) as {
      findings: Array<{ id: string; severity: string; repoDir?: string }>;
      incidents?: unknown[];
    };

    const configIntegrity = snapshot.findings.find((entry) => entry.id.startsWith('config-integrity-'));
    assert.ok(configIntegrity, 'expected a config-integrity finding');
    assert.equal(configIntegrity.severity, 'urgent');

    const markerFinding = snapshot.findings.find((entry) => entry.id.startsWith('coding-marker-ignored-'));
    assert.ok(markerFinding, 'expected the config-independent marker finding to still be produced');

    // Incident reconciliation must have been skipped gracefully — no crash,
    // and an `incidents` array is present (empty when config load skipped).
    assert.ok(Array.isArray(snapshot.incidents), 'incidents array must be present after degraded startup');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
