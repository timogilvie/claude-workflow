import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import * as prStateLabels from './pr-state-labels.ts';

function buildPullRequest(labelNames: string[]) {
  return {
    number: 229,
    title: 'Add label helpers',
    body: '',
    state: 'OPEN',
    author: 'octocat',
    headRefName: 'task/labels',
    headRefOid: 'head-229',
    baseRefName: 'main',
    labels: labelNames.map((name) => ({ name })),
    url: 'https://github.com/acme/widgets/pull/229',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe('setWavemillReady', () => {
  it('is a no-op when the pull request is already ready', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () => {
      throw new Error('should not add labels');
    });
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () => {
      throw new Error('should not remove labels');
    });

    try {
      const result = prStateLabels.setWavemillReady(229);
      assert.equal(result.number, 229);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 0);
      assert.equal(removeMock.mock.callCount(), 0);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('adds ready and removes conflicting states', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.blocked]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () =>
      buildPullRequest([]),
    );

    try {
      const result = prStateLabels.setWavemillReady(229, { repo: 'acme/widgets' });
      assert.equal(result.labels[0]?.name, prStateLabels.WM_LABELS.ready);
      assert.equal(getMock.mock.callCount(), 1);
      assert.deepEqual(removeMock.mock.calls[0]?.arguments, [229, prStateLabels.WM_LABELS.blocked, { repo: 'acme/widgets' }]);
      assert.deepEqual(addMock.mock.calls[0]?.arguments, [229, [prStateLabels.WM_LABELS.ready], { repo: 'acme/widgets' }]);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('removes blocked when ready is already present', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready, prStateLabels.WM_LABELS.blocked]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () => {
      throw new Error('should not add existing ready label');
    });
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );

    try {
      const result = prStateLabels.setWavemillReady(229);
      assert.deepEqual(result.labels.map((label) => label.name), [prStateLabels.WM_LABELS.ready]);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 0);
      assert.deepEqual(removeMock.mock.calls[0]?.arguments, [229, prStateLabels.WM_LABELS.blocked, {}]);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('does not attempt to remove missing conflicting labels', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () => {
      throw new Error('should not remove missing labels');
    });

    try {
      prStateLabels.setWavemillReady(229);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 1);
      assert.equal(removeMock.mock.callCount(), 0);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });
});

describe('setWavemillMerged', () => {
  it('adds merged and clears active states', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([
        prStateLabels.WM_LABELS.ready,
        prStateLabels.WM_LABELS.blocked,
        prStateLabels.WM_LABELS.merging,
      ]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.merged]),
    );
    const removed: string[] = [];
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', (_prNumber: number | string, label: string) => {
      removed.push(label);
      return buildPullRequest([prStateLabels.WM_LABELS.merged]);
    });

    try {
      const result = prStateLabels.setWavemillMerged(229);
      assert.equal(result.labels[0]?.name, prStateLabels.WM_LABELS.merged);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 1);
      assert.deepEqual(removed, [
        prStateLabels.WM_LABELS.ready,
        prStateLabels.WM_LABELS.blocked,
        prStateLabels.WM_LABELS.merging,
      ]);
      assert.equal(removeMock.mock.callCount(), 3);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });
});

describe('clearWavemillState', () => {
  it('removes only labels that are present on the pull request', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([
        prStateLabels.WM_LABELS.wavemill,
        prStateLabels.WM_LABELS.approved,
        prStateLabels.WM_LABELS.merged,
        'external-label',
      ]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () => {
      throw new Error('should not add labels');
    });
    const removed: string[] = [];
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', (_prNumber: number | string, label: string) => {
      removed.push(label);
      return buildPullRequest(['external-label']);
    });

    try {
      const result = prStateLabels.clearWavemillState(229);
      assert.deepEqual(result.labels, [{ name: 'external-label' }]);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 0);
      assert.deepEqual(removed, [
        prStateLabels.WM_LABELS.wavemill,
        prStateLabels.WM_LABELS.merged,
        prStateLabels.WM_LABELS.approved,
      ]);
      assert.equal(removeMock.mock.callCount(), 3);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });
});

describe('PR state marker lifecycle', () => {
  it('writes the active label state against the supplied head SHA', () => {
    const markerRoot = mkdtempSync(join(tmpdir(), 'wavemill-pr-marker-'));
    mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () => buildPullRequest([]));
    mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.blocked]));
    try {
      prStateLabels.setWavemillBlocked(229, { headSha: 'head-explicit' }, { markerRoot });
      const payload = JSON.parse(readFileSync(
        prStateLabels.getPrStateMarkerHandle(229, markerRoot).path,
        'utf-8',
      )) as { headSha: string; detail: { activeLabels: string[] } };
      assert.equal(payload.headSha, 'head-explicit');
      assert.deepEqual(payload.detail.activeLabels, [prStateLabels.WM_LABELS.blocked]);
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  it('reports stale and contradicted label sidecars through the read helper', async () => {
    const markerRoot = mkdtempSync(join(tmpdir(), 'wavemill-pr-marker-'));
    try {
      prStateLabels.writePrStateMarker(229, {
        headSha: 'head-old',
        activeLabels: [prStateLabels.WM_LABELS.blocked],
        markerRoot,
      });
      const stale = await prStateLabels.readPrStateMarker(229, {
        currentHead: 'head-new',
        markerRoot,
        deriveCondition: () => true,
      });
      assert.equal(stale.status, 'stale-sha');

      prStateLabels.writePrStateMarker(229, {
        headSha: 'head-new',
        activeLabels: [prStateLabels.WM_LABELS.blocked],
        markerRoot,
      });
      const contradicted = await prStateLabels.readPrStateMarker(229, {
        currentHead: 'head-new',
        markerRoot,
        deriveCondition: () => false,
      });
      assert.equal(contradicted.status, 'contradicted');
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  it('clears the transient sidecar when the PR reaches merged state', () => {
    const markerRoot = mkdtempSync(join(tmpdir(), 'wavemill-pr-marker-'));
    mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]));
    mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () => buildPullRequest([]));
    mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.merged]));
    try {
      prStateLabels.writePrStateMarker(229, {
        headSha: 'head-229',
        activeLabels: [prStateLabels.WM_LABELS.ready],
        markerRoot,
      });
      prStateLabels.setWavemillMerged(229, { markerRoot });
      assert.equal(existsSync(prStateLabels.getPrStateMarkerHandle(229, markerRoot).path), false);
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });
});
