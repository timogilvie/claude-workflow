import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  countDistinctNoise,
  isLogNoiseFinding,
  renderObserverStatus,
  type RenderableFinding,
} from './observer-status-renderer.ts';

function finding(overrides: Partial<RenderableFinding> & { id: string }): RenderableFinding {
  return {
    severity: 'medium',
    title: 'a finding',
    recommendation: 'do something',
    evidence: [],
    ...overrides,
  };
}

test('log-scrape findings are recognized as noise', () => {
  assert.equal(isLogNoiseFinding(finding({ id: 'log-error-wavemill-3qzf6b' })), true);
  assert.equal(isLogNoiseFinding(finding({ id: 'log-warning-wavemill-8g0hsy' })), true);
  assert.equal(isLogNoiseFinding(finding({ id: 'plan-marker-ignored-HOK-2881' })), false);
  assert.equal(isLogNoiseFinding(finding({ id: 'dead-pane-HOK-2882_c' })), false);
});

test('log-error with high severity and recurring occurrences surfaces as actionable', () => {
  const out = renderObserverStatus({
    findings: [
      finding({
        id: 'log-error-wavemill-repeat',
        severity: 'high',
        title: 'HOK-2893_c: challenge aborted because selected coding model failed validation',
        recommendation: 'repair the selector',
        occurrenceCount: 4,
      }),
    ],
  });

  assert.match(out, /challenge aborted because selected coding model failed validation/);
  assert.match(out, /repair the selector/);
  assert.equal(/log noise:/.test(out), false);
});

test('log-error with low severity and single occurrence stays in the noise rollup', () => {
  const out = renderObserverStatus({
    findings: [
      finding({
        id: 'log-error-wavemill-single',
        severity: 'low',
        title: 'one-off task-local failure',
        occurrenceCount: 1,
      }),
    ],
  });

  assert.match(out, /log noise: 1 finding\(s\)/);
  assert.equal(/one-off task-local failure/.test(out), false);
});

test('log-error title carries the normalized message in the pane output', () => {
  const message = 'HOK-2894_c: challenge aborted because selected review model failed validation';
  const out = renderObserverStatus({
    findings: [
      finding({
        id: 'log-error-wavemill-message',
        severity: 'high',
        title: message,
        occurrenceCount: 3,
      }),
    ],
  });

  assert.match(out, new RegExp(message));
});

test('noise is rolled into one counted line instead of listed', () => {
  const findings = [
    finding({ id: 'plan-marker-ignored-HOK-2881', severity: 'high', title: 'still in planning' }),
    ...Array.from({ length: 15 }, (_unused, index) =>
      finding({ id: `log-warning-wavemill-${index}`, title: 'Recent mill log contains a warning' })),
  ];

  const out = renderObserverStatus({ timestamp: '2026-08-25T12:00:00Z', findings });

  assert.match(out, /still in planning/);
  assert.match(out, /log noise: 15 finding\(s\)/);
  // The 15 noise findings must not each get their own line.
  assert.equal(out.split('\n').filter((line) => line.includes('Recent mill log')).length, 0);
});

test('distinct noise count collapses the same message at different timestamps', () => {
  const noise = [
    finding({ id: 'log-warning-a', evidence: ['08:06:11 [warn] tend loop stalled'] }),
    finding({ id: 'log-warning-b', evidence: ['09:14:02 [warn] tend loop stalled'] }),
    finding({ id: 'log-warning-c', evidence: ['10:22:53 [warn] something else'] }),
  ];

  assert.equal(countDistinctNoise(noise), 2);
});

test('findings are ordered by severity and only urgent/high carry a recommendation line', () => {
  const findings = [
    finding({ id: 'a-low', severity: 'low', title: 'low thing', recommendation: 'low rec' }),
    finding({ id: 'b-urgent', severity: 'urgent', title: 'urgent thing', recommendation: 'urgent rec' }),
    finding({ id: 'c-medium', severity: 'medium', title: 'medium thing', recommendation: 'medium rec' }),
  ];

  const lines = renderObserverStatus({ findings }).trim().split('\n');

  const urgentAt = lines.findIndex((line) => line.includes('urgent thing'));
  const mediumAt = lines.findIndex((line) => line.includes('medium thing'));
  const lowAt = lines.findIndex((line) => line.includes('low thing'));
  assert.ok(urgentAt < mediumAt && mediumAt < lowAt, 'expected urgent < medium < low ordering');

  assert.ok(lines.some((line) => line.includes('urgent rec')), 'urgent finding should show its recommendation');
  assert.equal(lines.some((line) => line.includes('medium rec')), false, 'medium should stay one line');
  assert.equal(lines.some((line) => line.includes('low rec')), false, 'low should stay one line');
});

test('an all-clear snapshot says so rather than printing an empty block', () => {
  const out = renderObserverStatus({ timestamp: '2026-08-25T12:00:00Z', findings: [] });
  assert.match(out, /no actionable findings/);
});

test('a snapshot of pure noise still reports all-clear plus the rollup', () => {
  const out = renderObserverStatus({
    findings: [finding({ id: 'log-error-x', evidence: ['08:00:00 [error] boom'] })],
  });
  assert.match(out, /no actionable findings/);
  assert.match(out, /log noise: 1 finding\(s\), 1 distinct/);
});

test('lines are truncated to the pane width', () => {
  const out = renderObserverStatus(
    { findings: [finding({ id: 'dead-pane-x', severity: 'high', title: 'x'.repeat(300) })] },
    { width: 40 },
  );
  for (const line of out.split('\n')) {
    assert.ok(line.length <= 40, `line exceeded width: ${line.length}`);
  }
});

test('includeNoise lists the log tier instead of rolling it up', () => {
  const out = renderObserverStatus(
    { findings: [finding({ id: 'log-warning-a', title: 'Recent mill log contains a warning' })] },
    { includeNoise: true },
  );
  assert.match(out, /Recent mill log contains a warning/);
  assert.equal(/log noise:/.test(out), false);
});

test('overflow beyond maxFindings is reported, not silently dropped', () => {
  const findings = Array.from({ length: 20 }, (_unused, index) =>
    finding({ id: `dead-pane-${index}`, severity: 'high', title: `finding ${index}` }));

  const out = renderObserverStatus({ findings }, { maxFindings: 5 });
  assert.match(out, /\.\.\. 15 more finding\(s\)/);
});
