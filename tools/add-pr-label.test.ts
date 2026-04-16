import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { addPrLabelDeps, addPrLabels } from './add-pr-label.ts';

afterEach(() => {
  mock.restoreAll();
});

describe('addPrLabels', () => {
  it('adds only labels that are not already present', async () => {
    const getMock = mock.method(addPrLabelDeps, 'getPullRequest', () => ({
      number: 229,
      title: 'Fix label flow',
      body: '',
      state: 'OPEN',
      author: 'octocat',
      headRefName: 'task/label-fix',
      baseRefName: 'main',
      labels: [{ name: 'existing' }],
      url: 'https://github.com/acme/widgets/pull/229',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
    }));
    const addMock = mock.method(addPrLabelDeps, 'addLabelsToPullRequest', async () => ({
      number: 229,
      title: 'Fix label flow',
      body: '',
      state: 'OPEN',
      author: 'octocat',
      headRefName: 'task/label-fix',
      baseRefName: 'main',
      labels: [{ name: 'existing' }, { name: 'new label' }],
      url: 'https://github.com/acme/widgets/pull/229',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
    }));
    const logMock = mock.method(addPrLabelDeps, 'log', () => undefined);

    try {
      await addPrLabels('229', ['existing', 'new label', 'new label'], 'acme/widgets');

      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 1);
      assert.deepEqual(addMock.mock.calls[0].arguments, [229, ['new label'], { repo: 'acme/widgets' }]);
      assert.equal(logMock.mock.callCount(), 2);
    } finally {
      logMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('logs and exits when all labels already exist', async () => {
    const getMock = mock.method(addPrLabelDeps, 'getPullRequest', () => ({
      number: 12,
      title: 'Fix label flow',
      body: '',
      state: 'OPEN',
      author: 'octocat',
      headRefName: 'task/label-fix',
      baseRefName: 'main',
      labels: [{ name: 'existing' }],
      url: 'https://github.com/acme/widgets/pull/12',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
    }));
    const addMock = mock.method(addPrLabelDeps, 'addLabelsToPullRequest', async () => {
      throw new Error('should not be called');
    });
    const logMock = mock.method(addPrLabelDeps, 'log', () => undefined);

    try {
      await addPrLabels('12', ['existing'], undefined);

      assert.equal(addMock.mock.callCount(), 0);
      assert.equal(logMock.mock.callCount(), 2);
      assert.match(String(logMock.mock.calls[1].arguments[0]), /already exist/);
    } finally {
      logMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('requires a PR number and at least one label', async () => {
    await assert.rejects(
      async () => addPrLabels('', [], undefined),
      /PR number and at least one label name are required/
    );
  });
});
