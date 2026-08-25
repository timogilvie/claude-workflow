import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { WM_LABELS } from '../shared/lib/pr-state-labels.ts';
import { setPrReadyLabel, setPrReadyLabelDeps } from './set-pr-ready-label.ts';

function pullRequest(labelNames: string[]) {
  return {
    number: 304,
    title: 'Ready PR',
    body: '',
    state: 'OPEN',
    author: 'octocat',
    headRefName: 'task/ready-pr',
    baseRefName: 'main',
    labels: labelNames.map((name) => ({ name })),
    url: 'https://github.com/acme/widgets/pull/304',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe('setPrReadyLabel', () => {
  it('logs success only when ready is present and blocked is absent', () => {
    const labelsMock = mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequest([WM_LABELS.wavemill, WM_LABELS.ready]),
    );
    const logs: string[] = [];
    mock.method(setPrReadyLabelDeps, 'log', (line: string) => logs.push(line));

    setPrReadyLabel('304', 'acme/widgets');

    assert.deepEqual(labelsMock.mock.calls[0]?.arguments, ['304', { repo: 'acme/widgets' }]);
    assert.deepEqual(logs, ['Restored ready labels for PR #304']);
  });

  it('fails before logging when the blocked label remains', () => {
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequest([WM_LABELS.wavemill, WM_LABELS.ready, WM_LABELS.blocked]),
    );
    const logs: string[] = [];
    mock.method(setPrReadyLabelDeps, 'log', (line: string) => logs.push(line));

    assert.throws(
      () => setPrReadyLabel('304'),
      /Ready label reconciliation failed for PR #304: labels=\[wavemill, wm:blocked, wm:ready\]/,
    );
    assert.deepEqual(logs, []);
  });
});
