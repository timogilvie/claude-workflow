import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCodingArtifacts } from '../coding-artifacts.ts';
import { createIntendedFileTracker, intendedFilesAfterToolCall } from './intended-files.ts';

describe('intended file tracker', () => {
  it('normalizes, dedupes, and queries intended paths', () => {
    const tracker = createIntendedFileTracker();

    tracker.record(['src/app.ts', './src/app.ts', 'src//nested/file.ts', '../outside.ts', '']);

    assert.deepEqual(tracker.list(), ['src/app.ts', 'src/nested/file.ts']);
    assert.equal(tracker.isIntended('src/app.ts'), true);
    assert.equal(tracker.isIntended('./src/app.ts'), true);
    assert.equal(tracker.isIntended('src\\nested\\file.ts'), true);
    assert.equal(tracker.isIntended('../outside.ts'), false);
  });

  it('records successful mutation outputs through the after-tool-call hook', async () => {
    const tracker = createIntendedFileTracker();

    await intendedFilesAfterToolCall(
      {
        toolCall: { name: 'apply_patch' },
        result: {
          details: {
            ok: true,
            tool: 'apply_patch',
            atomic: true,
            appliedOperations: 1,
            changedFiles: ['src/app.ts'],
            fileChanges: [{ path: 'src/app.ts', linesAdded: 1, linesRemoved: 0 }],
            linesAdded: 1,
            linesRemoved: 0,
          },
        },
      },
      tracker,
    );

    await intendedFilesAfterToolCall(
      {
        toolCall: { name: 'write_artifact' },
        result: {
          details: {
            ok: true,
            tool: 'write_artifact',
            resolvedPath: 'features/demo/output.json',
            bytesWritten: 12,
          },
        },
      },
      tracker,
    );

    await intendedFilesAfterToolCall(
      {
        toolCall: { name: 'create_marker' },
        result: {
          details: {
            ok: false,
            tool: 'create_marker',
            error: 'io_error',
            message: 'failed',
          },
        },
      },
      tracker,
    );

    assert.deepEqual(tracker.list(), ['features/demo/output.json', 'src/app.ts']);
  });

  it('tracks commit count for CodingArtifacts', () => {
    const tracker = createIntendedFileTracker();

    assert.equal(tracker.recordCommit(), 1);
    assert.equal(tracker.recordCommit(), 2);
    assert.equal(tracker.commitCount, 2);

    const validation = validateCodingArtifacts({
      type: 'coding',
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 1,
      commitCount: tracker.commitCount,
    });

    assert.equal(validation.ok, true);
  });
});
