import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLabelsToPr,
  removeLabelFromPr,
  setLabelsOnPr,
  githubDeps,
} from './github.ts';

describe('addLabelsToPr', () => {
  it('adds labels through gh api using default repo placeholders', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => '');

    try {
      await addLabelsToPr(229, ['HOK-1305', 'Bug']);

      assert.equal(execMock.mock.callCount(), 1);
      const [command] = execMock.mock.calls[0].arguments;
      assert.match(String(command), /repos\/\{owner\}\/\{repo\}\/issues\/229\/labels/);
      assert.match(String(command), /--method' 'POST'/);
      assert.match(String(command), /\{"labels":\["HOK-1305","Bug"\]\}/);
    } finally {
      execMock.mock.restore();
    }
  });

  it('uses explicit repo when provided', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => '');

    try {
      await addLabelsToPr(10, ['triage'], { repo: 'octocat/hello-world' });

      assert.equal(execMock.mock.callCount(), 1);
      const [command] = execMock.mock.calls[0].arguments;
      assert.match(String(command), /repos\/octocat\/hello-world\/issues\/10\/labels/);
    } finally {
      execMock.mock.restore();
    }
  });

  it('is a no-op for an empty label array', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => '');

    try {
      await addLabelsToPr(10, []);
      assert.equal(execMock.mock.callCount(), 0);
    } finally {
      execMock.mock.restore();
    }
  });

  it('rejects invalid PR numbers', async () => {
    await assert.rejects(() => addLabelsToPr(0, ['bug']), /positive integer/);
  });

  it('rejects invalid repo format', async () => {
    await assert.rejects(
      () => addLabelsToPr(10, ['bug'], { repo: 'invalid' }),
      /owner\/name format/,
    );
  });

  it('maps authentication failures to a clear error', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => {
      throw new Error('HTTP 401 Requires authentication');
    });

    try {
      await assert.rejects(
        () => addLabelsToPr(10, ['bug']),
        /GitHub CLI \(gh\) is not authenticated/,
      );
    } finally {
      execMock.mock.restore();
    }
  });

  it('maps missing PR errors to a not found error', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => {
      throw new Error('HTTP 404 Not Found');
    });

    try {
      await assert.rejects(() => addLabelsToPr(987, ['bug']), /Pull request #987 not found/);
    } finally {
      execMock.mock.restore();
    }
  });

  it('preserves network/API errors with operation context', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => {
      throw new Error('network timeout');
    });

    try {
      await assert.rejects(
        () => addLabelsToPr(10, ['bug']),
        /Failed to add labels for pull request #10: network timeout/,
      );
    } finally {
      execMock.mock.restore();
    }
  });
});

describe('removeLabelFromPr', () => {
  it('removes a label and URL-encodes label name', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => '');

    try {
      await removeLabelFromPr(229, 'needs triage');

      assert.equal(execMock.mock.callCount(), 1);
      const [command] = execMock.mock.calls[0].arguments;
      assert.match(String(command), /--method' 'DELETE'/);
      assert.match(
        String(command),
        /repos\/\{owner\}\/\{repo\}\/issues\/229\/labels\/needs%20triage/,
      );
    } finally {
      execMock.mock.restore();
    }
  });

  it('requires a non-empty label name', async () => {
    await assert.rejects(() => removeLabelFromPr(1, '   '), /Label is required/);
  });
});

describe('setLabelsOnPr', () => {
  it('replaces labels using PUT and accepts empty arrays', async () => {
    const execMock = mock.method(githubDeps, 'execShellCommand', () => '');

    try {
      await setLabelsOnPr(229, ['a', 'b', 'a']);
      await setLabelsOnPr(229, []);

      assert.equal(execMock.mock.callCount(), 2);

      const [firstCommand] = execMock.mock.calls[0].arguments;
      assert.match(String(firstCommand), /--method' 'PUT'/);
      assert.match(String(firstCommand), /\{"labels":\["a","b"\]\}/);

      const [secondCommand] = execMock.mock.calls[1].arguments;
      assert.match(String(secondCommand), /\{"labels":\[\]\}/);
    } finally {
      execMock.mock.restore();
    }
  });
});
