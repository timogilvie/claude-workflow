import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  commandToolsAfterToolCall,
  createRunFormatTool,
  createRunTestsTool,
  type RunCommandDetails,
} from './command-tools.ts';

const tempDirs = new Set<string>();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent command tools', () => {
  it('runs passing commands for run_tests and run_format', async () => {
    const repo = makeTempDir('command-tools-pass-');

    const runTests = createRunTestsTool(repo);
    const runFormat = createRunFormatTool(repo);

    const testResult = await runTests.execute('call-tests-pass', {
      command: `node -e console.log(String.fromCharCode(111,107))`,
    });
    const formatResult = await runFormat.execute('call-format-pass', {
      command: `node -e console.log(String.fromCharCode(102,109,116))`,
    });

    const testDetails = testResult.details as RunCommandDetails;
    const formatDetails = formatResult.details as RunCommandDetails;

    assert.equal(testDetails.ok, true);
    assert.equal(formatDetails.ok, true);

    if (testDetails.ok && formatDetails.ok) {
      assert.equal(testDetails.tool, 'run_tests');
      assert.equal(testDetails.kind, 'tests');
      assert.equal(testDetails.status, 'completed');
      assert.equal(testDetails.exitCode, 0);
      assert.equal(testDetails.cwd, repo);
      assert.equal(testDetails.commandClass, 'safe');
      assert.equal(testDetails.approval, 'approved');
      assert.equal(testDetails.truncated, false);
      assert.match(testDetails.stdout, /ok/);
      assert.equal(typeof testDetails.durationMs, 'number');
      assert.ok(testDetails.durationMs >= 0);
      assert.equal(testDetails.stdoutMeta.truncated, false);
      assert.equal(testDetails.stderrMeta.truncated, false);

      assert.equal(formatDetails.tool, 'run_format');
      assert.equal(formatDetails.kind, 'format');
      assert.equal(formatDetails.status, 'completed');
      assert.equal(formatDetails.exitCode, 0);
      assert.equal(formatDetails.cwd, repo);
      assert.equal(formatDetails.commandClass, 'safe');
      assert.equal(formatDetails.approval, 'approved');
      assert.equal(formatDetails.truncated, false);
      assert.match(formatDetails.stdout, /fmt/);
    }
  });

  it('preserves failing exit codes and stderr output', async () => {
    const repo = makeTempDir('command-tools-fail-');
    const runTests = createRunTestsTool(repo);

    const result = await runTests.execute('call-tests-fail', {
      command: `node -e process.stderr.write(String.fromCharCode(98,111,111,109)+'\\n');process.exit(2)`,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.status, 'completed');
      assert.equal(details.exitCode, 2);
      assert.equal(details.timedOut, false);
      assert.match(details.stderr, /boom/);
      const afterCall = await commandToolsAfterToolCall({
        toolCall: { name: 'run_tests' },
        result,
      });
      assert.equal(afterCall, undefined);
    }
  });

  it('reports timed out commands without treating them as rejections', async () => {
    const repo = makeTempDir('command-tools-timeout-');
    const runTests = createRunTestsTool(repo);

    const result = await Promise.race([
      runTests.execute('call-tests-timeout', {
        command: `node -e setTimeout(()=>{},5000)`,
        timeoutMs: 200,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout test hung')), 10_000);
      }),
    ]);

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.status, 'timed_out');
      assert.equal(details.timedOut, true);
      assert.equal(details.exitCode, null);
      assert.ok(details.durationMs >= 200);
      assert.ok(details.durationMs < 4000);
    }
  });

  it('middle-truncates output while preserving both head and tail markers', async () => {
    const repo = makeTempDir('command-tools-truncate-');
    const runTests = createRunTestsTool(repo);

    const largeResult = await runTests.execute('call-tests-truncate', {
      command:
        `node -e console.log('HEAD_MARKER');for(i=0;i<5000;i++)console.log('x'.repeat(50));console.log('TAIL_MARKER')`,
      maxOutputBytes: 1024,
    });

    const details = largeResult.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.truncated, true);
      assert.match(details.stdout, /HEAD_MARKER/);
      assert.match(details.stdout, /TAIL_MARKER/);
      assert.match(details.stdout, /\.\.\.\[truncated \d+ bytes from the middle\]\.\.\./);
      assert.ok(Buffer.byteLength(details.stdout, 'utf8') <= 1024);
      assert.ok(details.stdoutMeta.originalByteLength > 1024);
      assert.equal(details.stderrMeta.truncated, false);
    }

    const exactResult = await runTests.execute('call-tests-exact', {
      command: `node -e process.stdout.write('hello')`,
      maxOutputBytes: 5,
    });
    const exactDetails = exactResult.details as RunCommandDetails;
    assert.equal(exactDetails.ok, true);
    if (exactDetails.ok) {
      assert.equal(exactDetails.truncated, false);
      assert.equal(exactDetails.stdout, 'hello');
    }
  });

  it('rejects unsafe commands before spawn for both tools', async () => {
    const repo = makeTempDir('command-tools-unsafe-');
    let spawnCalls = 0;
    const spawnSpy = (file: string, args: readonly string[], options: any) => {
      spawnCalls += 1;
      return spawn(file, [...args], options);
    };

    const runTests = createRunTestsTool(repo, { spawnFn: spawnSpy });
    const runFormat = createRunFormatTool(repo, { spawnFn: spawnSpy });

    const testResult = await runTests.execute('call-tests-unsafe', {
      command: 'rm -rf /',
    });
    const formatResult = await runFormat.execute('call-format-unsafe', {
      command: 'sudo ls',
    });

    const testDetails = testResult.details as RunCommandDetails;
    const formatDetails = formatResult.details as RunCommandDetails;

    assert.equal(testDetails.ok, false);
    assert.equal(formatDetails.ok, false);
    if (!testDetails.ok && !formatDetails.ok) {
      assert.equal(testDetails.status, 'rejected');
      assert.equal(testDetails.error, 'unsafe_command');
      assert.equal(testDetails.commandClass, 'dangerous');
      assert.equal(testDetails.reason, 'dangerous-command-pattern');
      assert.ok(testDetails.retryHint);

      assert.equal(formatDetails.status, 'rejected');
      assert.equal(formatDetails.error, 'unsafe_command');
      assert.equal(formatDetails.commandClass, 'dangerous');
      assert.equal(formatDetails.reason, 'dangerous-command-pattern');
    }
    assert.equal(spawnCalls, 0);
  });

  it('includes required execution metadata on completed results', async () => {
    const repo = makeTempDir('command-tools-metadata-');
    const runTests = createRunTestsTool(repo);

    const result = await runTests.execute('call-tests-metadata', {
      command: `node -e console.log('meta')`,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.ok(Object.hasOwn(details, 'commandClass'));
      assert.ok(Object.hasOwn(details, 'approval'));
      assert.ok(Object.hasOwn(details, 'cwd'));
      assert.ok(Object.hasOwn(details, 'durationMs'));
      assert.ok(Object.hasOwn(details, 'exitCode'));
      assert.ok(Object.hasOwn(details, 'stdoutMeta'));
      assert.ok(Object.hasOwn(details, 'stderrMeta'));
    }
  });

  it('rejects empty commands without spawning', async () => {
    const repo = makeTempDir('command-tools-empty-');
    let spawnCalls = 0;
    const runTests = createRunTestsTool(repo, {
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    const result = await runTests.execute('call-tests-empty', {
      command: '',
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_input');
      assert.equal(details.reason, 'empty-command');
    }
    assert.equal(spawnCalls, 0);
  });

  it('rejects cwd outside the worktree before spawn', async () => {
    const repo = makeTempDir('command-tools-root-');
    const outside = makeTempDir('command-tools-outside-');
    let spawnCalls = 0;
    const runTests = createRunTestsTool(repo, {
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    const result = await runTests.execute('call-tests-outside', {
      command: `node -e console.log('x')`,
      cwd: outside,
    });

    const details = result.details as RunCommandDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'cwd_outside_allowed_roots');
      assert.equal(details.commandClass, 'safe');
      assert.equal(details.reason, 'cwd-outside-allowed-roots');
    }
    assert.equal(spawnCalls, 0);
  });

  it('marks only rejected tool calls as loop errors', async () => {
    const repo = makeTempDir('command-tools-after-');
    const runTests = createRunTestsTool(repo);

    const rejected = await runTests.execute('call-tests-rejected', {
      command: 'sudo ls',
    });
    const completed = await runTests.execute('call-tests-completed', {
      command: `node -e process.exit(3)`,
    });

    const rejectedAfter = await commandToolsAfterToolCall({
      toolCall: { name: 'run_tests' },
      result: rejected,
    });
    const completedAfter = await commandToolsAfterToolCall({
      toolCall: { name: 'run_tests' },
      result: completed,
    });

    assert.deepEqual(rejectedAfter, { isError: true });
    assert.equal(completedAfter, undefined);
  });

  it('stays on the shared substrate path', () => {
    const source = readFileSync(new URL('./command-tools.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('node:child_process'));
    assert.ok(!source.includes("require('child_process')"));
  });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}
