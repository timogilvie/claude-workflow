import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { spawn } from 'node:child_process';

import { classifyCommand } from './command-classifier.ts';
import { runCommand } from './command-substrate.ts';
import { TranscriptWriter, parseTranscriptJsonl } from './transcript.ts';

const tempDirs: string[] = [];
const TEST_SECRET_KEY = 'WAVEMILL_TEST_SECRET';
const TRUNCATION_MARKER = '[output truncated]';
const TRANSCRIPT_BASE_OPTS = {
  sessionId: 'command-substrate-test',
  model: 'hokusai-mini',
  api: 'hokusai-mock',
  provider: 'hokusai',
};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  delete process.env[TEST_SECRET_KEY];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('command classifier reuse', () => {
  it('classifies safe string commands', () => {
    assert.deepEqual(classifyCommand('git status'), {
      commandClass: 'safe',
      normalizedCommand: 'git status',
    });
  });

  it('classifies dangerous string commands', () => {
    assert.deepEqual(classifyCommand('rm -rf /tmp/x'), {
      commandClass: 'dangerous',
      normalizedCommand: 'rm -rf /tmp/x',
      rejectionReason: 'dangerous-command-pattern',
    });
  });

  it('classifies safe argv commands', () => {
    assert.deepEqual(classifyCommand(['git', 'status']), {
      commandClass: 'safe',
      normalizedCommand: 'git status',
    });
  });

  it('classifies empty commands as dangerous', () => {
    assert.deepEqual(classifyCommand('   '), {
      commandClass: 'dangerous',
      normalizedCommand: '',
      rejectionReason: 'empty-command',
    });
  });

  it('does not introduce an independent dangerous-command dialect', () => {
    const classifierSource = readFileSync(new URL('./command-classifier.ts', import.meta.url), 'utf8');
    const substrateSource = readFileSync(new URL('./command-substrate.ts', import.meta.url), 'utf8');

    assert.ok(classifierSource.includes('isSafePattern'));
    assert.ok(!classifierSource.includes("'rm "));
    assert.ok(!classifierSource.includes("'sudo "));
    assert.ok(!substrateSource.includes("'rm "));
    assert.ok(!substrateSource.includes("'sudo "));
  });
});

describe('dangerous command rejection', () => {
  it('rejects dangerous commands before spawn', async () => {
    const cwd = makeTempDir('command-substrate-reject-');
    let spawnCalls = 0;

    const result = await runCommand({
      command: 'rm -rf /',
      cwd,
      allowedRoots: [cwd],
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    assert.equal(result.approval, 'rejected');
    assert.equal(result.rejectionReason, 'dangerous-command-pattern');
    assert.equal(spawnCalls, 0);
  });

  it('rejects sudo commands before spawn', async () => {
    const cwd = makeTempDir('command-substrate-sudo-');
    let spawnCalls = 0;

    const result = await runCommand({
      command: 'sudo ls',
      cwd,
      allowedRoots: [cwd],
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    assert.equal(result.approval, 'rejected');
    assert.equal(spawnCalls, 0);
  });

  it('approves safe commands and reaches spawn', async () => {
    const cwd = makeTempDir('command-substrate-approve-');
    let spawnCalls = 0;

    const result = await runCommand({
      command: ['ls', cwd],
      cwd,
      allowedRoots: [cwd],
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    assert.equal(result.approval, 'approved');
    assert.equal(result.commandClass, 'safe');
    assert.equal(spawnCalls, 1);
  });
});

describe('cwd lock', () => {
  it('rejects cwd outside allowed roots before spawn', async () => {
    const root = makeTempDir('command-substrate-root-');
    const cwd = makeTempDir('command-substrate-outside-');
    let spawnCalls = 0;

    const result = await runCommand({
      command: ['pwd'],
      cwd,
      allowedRoots: [root],
      spawnFn(file, args, options) {
        spawnCalls += 1;
        return spawn(file, args, options);
      },
    });

    assert.equal(result.approval, 'rejected');
    assert.equal(result.rejectionReason, 'cwd-outside-allowed-roots');
    assert.equal(spawnCalls, 0);
  });

  it('allows cwd nested under an allowed root', async () => {
    const root = makeTempDir('command-substrate-nested-');
    const cwd = path.join(root, 'nested');
    mkdirSync(cwd);

    const result = await runCommand({
      command: ['pwd'],
      cwd,
      allowedRoots: [root],
    });

    assert.equal(result.approval, 'approved');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), realpathSync(cwd));
  });

  it('rejects symlink escape via realpath resolution', async () => {
    const root = makeTempDir('command-substrate-symlink-root-');
    const outside = makeTempDir('command-substrate-symlink-outside-');
    const link = path.join(root, 'linked');
    symlinkSync(outside, link);

    const result = await runCommand({
      command: ['pwd'],
      cwd: link,
      allowedRoots: [root],
    });

    assert.equal(result.approval, 'rejected');
    assert.equal(result.rejectionReason, 'cwd-outside-allowed-roots');
  });
});

describe('env filtering', () => {
  it('does not leak unapproved parent env vars', async () => {
    const cwd = makeTempDir('command-substrate-env-');
    process.env[TEST_SECRET_KEY] = 'supersecret';

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      cwd,
      allowedRoots: [cwd],
    });

    const env = JSON.parse(result.stdout) as Record<string, string | undefined>;
    assert.equal(env[TEST_SECRET_KEY], undefined);
  });

  it('includes allowlisted env vars', async () => {
    const cwd = makeTempDir('command-substrate-env-allow-');
    process.env[TEST_SECRET_KEY] = 'supersecret';

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      cwd,
      allowedRoots: [cwd],
      allowedEnvKeys: [TEST_SECRET_KEY],
    });

    const env = JSON.parse(result.stdout) as Record<string, string | undefined>;
    assert.equal(env[TEST_SECRET_KEY], 'supersecret');
  });
});

describe('timeout handling', () => {
  it('times out long-running commands', async () => {
    const cwd = makeTempDir('command-substrate-timeout-');

    const result = await Promise.race([
      runCommand({
        command: ['node', '-e', 'setTimeout(() => {}, 5000)'],
        cwd,
        allowedRoots: [cwd],
        timeoutMs: 200,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout test hung')), 10_000);
      }),
    ]);

    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs >= 200);
    assert.ok(result.durationMs < 4000);
  });

  it('does not time out quick commands', async () => {
    const cwd = makeTempDir('command-substrate-fast-');

    const result = await runCommand({
      command: ['node', '-e', ''],
      cwd,
      allowedRoots: [cwd],
      timeoutMs: 1000,
    });

    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
  });
});

describe('output capping', () => {
  it('caps stdout and appends a truncation marker', async () => {
    const cwd = makeTempDir('command-substrate-stdout-cap-');

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write("x".repeat(100000))'],
      cwd,
      allowedRoots: [cwd],
      maxOutputBytes: 1000,
    });

    assert.equal(result.truncated, true);
    assert.ok(result.stdout.endsWith(TRUNCATION_MARKER));
    const body = result.stdout.slice(0, -TRUNCATION_MARKER.length).trimEnd();
    assert.ok(Buffer.byteLength(body, 'utf8') <= 1000);
  });

  it('preserves below-cap output verbatim', async () => {
    const cwd = makeTempDir('command-substrate-stdout-small-');

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write("hello")'],
      cwd,
      allowedRoots: [cwd],
      maxOutputBytes: 1000,
    });

    assert.equal(result.truncated, false);
    assert.equal(result.stdout, 'hello');
  });

  it('caps stderr independently of stdout', async () => {
    const cwd = makeTempDir('command-substrate-stderr-cap-');

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write("ok");process.stderr.write("e".repeat(100000))'],
      cwd,
      allowedRoots: [cwd],
      maxOutputBytes: 1000,
    });

    assert.equal(result.truncated, true);
    assert.equal(result.stdout, 'ok');
    assert.ok(result.stderr.endsWith(TRUNCATION_MARKER));
  });
});

describe('redaction', () => {
  it('redacts stdout secrets', async () => {
    const cwd = makeTempDir('command-substrate-redact-out-');

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write("token=supersecret")'],
      cwd,
      allowedRoots: [cwd],
      redactValues: ['supersecret'],
    });

    assert.equal(result.stdout, 'token=«redacted»');
    assert.ok(!result.stdout.includes('supersecret'));
  });

  it('ignores empty redaction entries', async () => {
    const cwd = makeTempDir('command-substrate-redact-empty-');

    const result = await runCommand({
      command: ['node', '-e', 'process.stdout.write("token=supersecret")'],
      cwd,
      allowedRoots: [cwd],
      redactValues: ['', 'supersecret'],
    });

    assert.equal(result.stdout, 'token=«redacted»');
  });

  it('redacts stderr secrets', async () => {
    const cwd = makeTempDir('command-substrate-redact-err-');

    const result = await runCommand({
      command: ['node', '-e', 'process.stderr.write("token=supersecret")'],
      cwd,
      allowedRoots: [cwd],
      redactValues: ['supersecret'],
    });

    assert.equal(result.stderr, 'token=«redacted»');
  });
});

describe('class and approval exposure', () => {
  it('returns command class and approval for approved commands', async () => {
    const cwd = makeTempDir('command-substrate-approved-fields-');

    const result = await runCommand({
      command: ['pwd'],
      cwd,
      allowedRoots: [cwd],
    });

    assert.equal(result.commandClass, 'safe');
    assert.equal(result.approval, 'approved');
  });

  it('returns command class and approval for rejected commands', async () => {
    const cwd = makeTempDir('command-substrate-rejected-fields-');

    const result = await runCommand({
      command: 'sudo ls',
      cwd,
      allowedRoots: [cwd],
    });

    assert.equal(result.commandClass, 'dangerous');
    assert.equal(result.approval, 'rejected');
  });
});

describe('transcript logging', () => {
  it('writes an approved command transcript event with metadata', async () => {
    const cwd = makeTempDir('command-substrate-transcript-approved-');
    const transcriptPath = path.join(cwd, 'native-transcript.jsonl');
    const writer = new TranscriptWriter({ ...TRANSCRIPT_BASE_OPTS, path: transcriptPath });

    await runCommand({
      command: ['node', '-e', 'process.stdout.write("hello")'],
      cwd,
      allowedRoots: [cwd],
      transcriptWriter: writer,
      toolName: 'test',
    });

    const parsed = parseTranscriptJsonl(readFileSync(transcriptPath, 'utf-8'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.type, 'command_result');
    if (parsed[0]?.type !== 'command_result') {
      throw new Error('expected command_result transcript event');
    }
    assert.equal(parsed[0].toolName, 'test');
    assert.equal(parsed[0].approval, 'approved');
    assert.equal(parsed[0].cwd, realpathSync(cwd));
    assert.equal(parsed[0].exitCode, 0);
    assert.equal(parsed[0].stdout, 'hello');
    assert.equal(parsed[0].truncation.stdout.truncated, false);
  });

  it('writes a rejected command transcript event without spawning', async () => {
    const cwd = makeTempDir('command-substrate-transcript-rejected-');
    const transcriptPath = path.join(cwd, 'native-transcript.jsonl');
    const writer = new TranscriptWriter({ ...TRANSCRIPT_BASE_OPTS, path: transcriptPath });

    await runCommand({
      command: 'sudo ls',
      cwd,
      allowedRoots: [cwd],
      transcriptWriter: writer,
      toolName: 'git',
    });

    const parsed = parseTranscriptJsonl(readFileSync(transcriptPath, 'utf-8'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.type, 'command_result');
    if (parsed[0]?.type !== 'command_result') {
      throw new Error('expected command_result transcript event');
    }
    assert.equal(parsed[0].toolName, 'git');
    assert.equal(parsed[0].approval, 'rejected');
    assert.equal(parsed[0].exitCode, null);
    assert.equal(parsed[0].rejectionReason, 'dangerous-command-pattern');
  });

  it('does not persist allowlisted env secrets or output secrets in transcript content', async () => {
    const cwd = makeTempDir('command-substrate-transcript-redaction-');
    const transcriptPath = path.join(cwd, 'native-transcript.jsonl');
    const writer = new TranscriptWriter({ ...TRANSCRIPT_BASE_OPTS, path: transcriptPath });
    process.env[TEST_SECRET_KEY] = 'supersecret';

    await runCommand({
      command: ['node', '-e', `process.stdout.write(process.env.${TEST_SECRET_KEY} ?? "")`],
      cwd,
      allowedRoots: [cwd],
      allowedEnvKeys: [TEST_SECRET_KEY],
      redactValues: ['supersecret'],
      transcriptWriter: writer,
      toolName: 'command',
    });

    const rawTranscript = readFileSync(transcriptPath, 'utf-8');
    assert.ok(!rawTranscript.includes('supersecret'));
    assert.ok(rawTranscript.includes('«redacted»'));
  });
});
