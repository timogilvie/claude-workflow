import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
  createCreateMarkerTool,
  createUpdateStatusTool,
  createWriteArtifactTool,
  type CreateMarkerDetails,
  type UpdateStatusDetails,
  type WriteArtifactDetails,
} from './mutation-tools.ts';
import { createCleanupTracker } from '../cleanup.ts';
import { clearConfigCache } from '../../config.ts';

const dirsToClean = new Set<string>();

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent mutation tools', () => {
  it('exposes all coding mutation tools and path policy metadata', () => {
    const tools = createCodingMutationTools('/repo');
    assert.deepEqual(tools.map((tool) => tool.metadata.name), [
      'apply_patch',
      'write_artifact',
      'create_marker',
      'update_status',
    ]);
    assert.deepEqual(codingMutationPolicyConfig, {
      pathFieldsByTool: {
        write_artifact: ['path'],
        create_marker: ['path'],
      },
    });
  });

  it('writes artifacts to allowlisted paths', async () => {
    const repo = createRepo('mutation-artifact-success-');
    const tracker = createCleanupTracker();
    const tool = createWriteArtifactTool(repo, { recorder: tracker });

    const result = await tool.execute('call-1', {
      path: 'features/demo/output.json',
      content: '{"ok":true}\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.resolvedPath, 'features/demo/output.json');
      assert.equal(details.bytesWritten, Buffer.byteLength('{"ok":true}\n', 'utf-8'));
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), '{"ok":true}\n');
      assert.deepEqual(tracker.mutations, [{
        tool: 'write_artifact',
        status: 'completed',
        path: 'features/demo/output.json',
      }]);
    }
  });

  it('rejects whole-file writes to source paths with a retry hint', async () => {
    const repo = createRepo('mutation-artifact-source-denied-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-2', {
      path: 'src/app.ts',
      content: 'export const value = 1;\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'whole_file_source_write_denied');
      assert.equal(details.retryHint, 'use apply_patch for source edits');
      assert.match(details.message, /not generated or Wavemill-owned/);
    }
  });

  it('rejects artifact writes outside the worktree', async () => {
    const repo = createRepo('mutation-artifact-path-denied-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-3', {
      path: '../secret.txt',
      content: 'secret\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'path_denied');
      assert.match(details.message, /outside the active worktree/);
    }

    const afterCall = await codingMutationAfterToolCall({
      toolCall: { name: 'write_artifact' },
      result,
    });
    assert.deepEqual(afterCall, { isError: true });
  });

  it('creates marker files in allowlisted locations', async () => {
    const repo = createRepo('mutation-marker-success-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-4', {
      path: 'features/demo/.coding-complete',
      content: 'confidence=high\n',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.resolvedPath, 'features/demo/.coding-complete');
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), 'confidence=high\n');
    }
  });

  it('rejects invalid phase-boundary artifacts without writing them', async () => {
    const repo = createRepo('mutation-invalid-boundary-artifact-');
    const tracker = createCleanupTracker();
    const tool = createCreateMarkerTool(repo, { recorder: tracker });

    const result = await tool.execute('call-invalid-marker', {
      path: 'features/demo/.coding-complete',
      content: '{"commit":"abc123"}',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_artifact_content');
      assert.match(details.message, /missing_confidence/);
      assert.match(details.retryHint ?? '', /confidence=high\|medium\|low/);
      assert.deepEqual(tracker.mutations, [{
        tool: 'create_marker',
        status: 'failed',
        path: 'features/demo/.coding-complete',
        reason: details.message,
      }]);
    }
    assert.throws(() => readFileSync(path.join(repo, 'features/demo/.coding-complete'), 'utf-8'));
  });

  it('normalizes JSON .coding-complete content to key=value on disk', async () => {
    const repo = createRepo('mutation-normalize-complete-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-normalize-marker', {
      path: 'features/demo/.coding-complete',
      content: '{"confidence":"medium","commit":"abc123"}',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.normalizedFrom, 'json');
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), 'confidence=medium\ncommit=abc123\n');
      assert.match(result.content[0]!.text, /normalized from json/);
    }
  });

  it('normalizes YAML blocked-completion content to strict JSON on disk', async () => {
    const repo = createRepo('mutation-normalize-blocked-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-normalize-blocked', {
      path: 'features/demo/.coding-blocked-completion.json',
      content: [
        'stage: coding',
        'implementationComplete: true',
        'committed: true',
        'passingChecks: [npm test]',
        'blockingChecks:',
        '  - npm run typecheck',
        'blockingReason: baseline_tests_failing',
        'evidence: baseline failed',
        'recommendedAction: advance_to_review',
        '',
      ].join('\n'),
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.normalizedFrom, 'yaml');
      const saved = JSON.parse(readFileSync(path.join(repo, details.resolvedPath), 'utf-8')) as Record<string, unknown>;
      assert.equal(saved.stage, 'coding');
      assert.deepEqual(saved.passingChecks, ['npm test']);
      assert.deepEqual(saved.blockingChecks, ['npm run typecheck']);
    }
  });

  it('rejects markers outside the whole-file allowlist', async () => {
    const repo = createRepo('mutation-marker-denied-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-5', {
      path: 'src/.marker',
      content: 'x',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'whole_file_source_write_denied');
      assert.equal(details.retryHint, 'use apply_patch for source edits');
    }
  });

  it('writes durable status updates and leaves no temp files behind', async () => {
    const repo = createRepo('mutation-status-success-');
    const statusPath = path.join(repo, '.wavemill', 'status.json');
    const tracker = createCleanupTracker();
    const tool = createUpdateStatusTool(repo, { statusPath, recorder: tracker });

    const result = await tool.execute('call-6', {
      state: 'working',
      message: 'editing native tools',
      detail: 'phase 2',
    });

    const details = result.details as UpdateStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.statusPath, statusPath);
      const saved = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(saved.state, 'working');
      assert.equal(saved.event, 'update_status');
      assert.equal(saved.message, 'editing native tools');
      assert.equal(saved.detail, 'phase 2');
      assert.match(result.content[0]!.text, /"tool":"update_status"/);
      assert.deepEqual(
        readdirSync(path.dirname(statusPath)).filter((entry) => entry.endsWith('.tmp')),
        [],
      );
      assert.deepEqual(tracker.mutations, [{
        tool: 'update_status',
        status: 'completed',
        path: '.wavemill/status.json',
      }]);
    }
  });

  it('records patch snapshots for apply_patch success', async () => {
    const repo = createRepo('mutation-apply-patch-recorder-');
    const tracker = createCleanupTracker();
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 1;\n', 'utf8');
    const [tool] = createCodingMutationTools(repo, { recorder: tracker });

    const result = await tool.execute('call-patch', {
      patch: {
        version: 1,
        atomic: true,
        operations: [{
          op: 'edit',
          path: 'src.ts',
          oldText: 'const value = 1;\n',
          newText: 'const value = 2;\n',
        }],
      },
    });

    assert.equal((result.details as { ok: boolean }).ok, true);
    assert.equal(tracker.patchSnapshots.length, 1);
    assert.equal(tracker.patchSnapshots[0]?.path, 'src.ts');
    assert.equal(tracker.patchSnapshots[0]?.originalDiskText, 'const value = 1;\n');
    assert.equal(tracker.patchSnapshots[0]?.postImage, 'const value = 2;\n');
  });

  it('rejects invalid status states', async () => {
    const repo = createRepo('mutation-status-invalid-');
    const tool = createUpdateStatusTool(repo);

    const result = await tool.execute('call-7', {
      state: 'done' as any,
    });

    const details = result.details as UpdateStatusDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_input');
      assert.match(details.message, /state must be one of/);
    }
  });

  it('write_artifact redacts secrets from content before writing to disk', async () => {
    const repo = createRepo('mutation-artifact-redact-');
    const tool = createWriteArtifactTool(repo);
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

    const result = await tool.execute('call-redact', {
      path: 'features/demo/secret.json',
      content: `{"token": "${token}"}`,
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      const diskContent = readFileSync(path.join(repo, details.resolvedPath), 'utf-8');
      assert.ok(!diskContent.includes(token), 'original token must not appear on disk');
      assert.ok(diskContent.includes('[REDACTED:github_pat]'), 'redacted placeholder must appear');
    }
  });

  it('write_artifact redacts configured secret env values before writing to disk', async () => {
    const repo = createRepo('mutation-artifact-configured-redact-');
    writeFileSync(
      path.join(repo, '.wavemill-config.json'),
      JSON.stringify({ safety: { redaction: { secretEnvNames: ['HOKUSAI_TEST_SECRET'] } } }),
      'utf-8',
    );
    clearConfigCache(repo);
    process.env.HOKUSAI_TEST_SECRET = 'configured-value-without-known-pattern';
    const tool = createWriteArtifactTool(repo);

    try {
      const result = await tool.execute('call-configured-redact', {
        path: 'features/demo/configured-secret.txt',
        content: 'value=configured-value-without-known-pattern\n',
      });

      const details = result.details as WriteArtifactDetails;
      assert.equal(details.ok, true);
      if (details.ok) {
        const diskContent = readFileSync(path.join(repo, details.resolvedPath), 'utf-8');
        assert.ok(!diskContent.includes('configured-value-without-known-pattern'));
        assert.equal(diskContent, 'value=[REDACTED:configured_secret]\n');
      }
    } finally {
      delete process.env.HOKUSAI_TEST_SECRET;
      clearConfigCache(repo);
    }
  });
});

function createRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirsToClean.add(dir);
  return dir;
}
