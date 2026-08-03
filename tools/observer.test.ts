import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFindings,
  parseArgs,
  redactedSnapshot,
  retainFindings,
  writeHeartbeat,
} from './observer.ts';

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
      retentionMaxEntries: 100,
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

test('observer service args capture context and reject Linear filing', () => {
  const options = parseArgs([
    '--loop',
    '--json',
    '--repo-dir',
    '/tmp/repo',
    '--session',
    'wavemill-test',
    '--interval',
    '7',
    '--heartbeat-file',
    '/tmp/heartbeat.json',
    '--findings-file',
    '/tmp/findings.json',
    '--retention-max-entries',
    '3',
  ]);

  assert.equal(options.loop, true);
  assert.equal(options.json, true);
  assert.equal(options.repoDir, '/tmp/repo');
  assert.equal(options.session, 'wavemill-test');
  assert.equal(options.intervalSeconds, 7);
  assert.equal(options.heartbeatFile, '/tmp/heartbeat.json');
  assert.equal(options.findingsFile, '/tmp/findings.json');
  assert.equal(options.retentionMaxEntries, 3);

  const previous = process.env.WAVEMILL_OBSERVER_SERVICE;
  process.env.WAVEMILL_OBSERVER_SERVICE = '1';
  try {
    assert.throws(() => parseArgs(['--file-linear']), /not allowed/);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_OBSERVER_SERVICE;
    } else {
      process.env.WAVEMILL_OBSERVER_SERVICE = previous;
    }
  }
});

test('observer service writes heartbeat and prunes retained findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'observer-service-'));
  const heartbeatFile = join(dir, 'observer-heartbeat.json');
  const findingsFile = join(dir, 'observer-findings.json');
  const options = parseArgs([
    '--once',
    '--repo-dir',
    dir,
    '--session',
    'wavemill-service',
    '--heartbeat-file',
    heartbeatFile,
    '--findings-file',
    findingsFile,
    '--retention-max-entries',
    '2',
  ]);

  try {
    for (const index of [1, 2, 3]) {
      const snapshot = {
        timestamp: `2026-08-03T00:00:0${index}.000Z`,
        sessions: ['wavemill-service'],
        panes: [],
        processes: [],
        repos: [],
        findings: [{
          id: `finding-${index}`,
          severity: 'low' as const,
          category: 'warning' as const,
          confidence: 'medium' as const,
          title: `Finding ${index}`,
          evidence: [`evidence-${index}`],
          recommendation: 'Inspect.',
        }],
      };
      await writeHeartbeat(options, snapshot, index);
      await retainFindings(options, snapshot);
    }

    const heartbeat = JSON.parse(readFileSync(heartbeatFile, 'utf8'));
    assert.equal(heartbeat.session, 'wavemill-service');
    assert.equal(heartbeat.repoDir, dir);
    assert.equal(heartbeat.cycle, 3);
    assert.equal(heartbeat.findingsCount, 1);

    const retained = JSON.parse(readFileSync(findingsFile, 'utf8'));
    assert.equal(retained.entries.length, 2);
    assert.equal(retained.entries[0].findings[0].id, 'finding-2');
    assert.equal(retained.entries[1].findings[0].id, 'finding-3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observer snapshots redact secret-looking evidence before output or retention', () => {
  const secret = 'ghp_1234567890abcdef1234567890abcdef1234';
  const snapshot = redactedSnapshot({
    timestamp: '2026-08-03T00:00:00.000Z',
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [],
    findings: [{
      id: 'secret-finding',
      severity: 'high',
      category: 'warning',
      confidence: 'high',
      title: 'Secret evidence',
      evidence: [`token=${secret}`],
      recommendation: 'Inspect.',
    }],
  });

  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  assert.match(snapshot.findings[0].evidence[0], /\[REDACTED:/);
});
