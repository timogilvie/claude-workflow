import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCommandTranscript,
  COMMAND_TRANSCRIPT_REDACTION_MARKER,
} from './command-transcript.ts';

describe('buildCommandTranscript', () => {
  it('redacts configured secrets before truncating persisted output', () => {
    const secret = 'supersecret';
    const built = buildCommandTranscript({
      command: `echo ${secret}`,
      commandClass: 'safe',
      approval: 'approved',
      cwd: '/tmp/project',
      env: { PATH: '/usr/bin', CUSTOM_SECRET: secret },
      redactValues: [secret],
      durationMs: 12,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `token=${secret}`.repeat(20),
      stderr: '',
      maxOutputBytes: 32,
    });

    assert.equal(built.event.command, `echo ${COMMAND_TRANSCRIPT_REDACTION_MARKER}`);
    assert.equal(built.event.env.CUSTOM_SECRET, COMMAND_TRANSCRIPT_REDACTION_MARKER);
    assert.ok(!built.stdout.includes(secret));
    assert.equal(built.event.truncation.stdout.truncated, true);
    assert.ok(built.stdout.endsWith('[output truncated]'));
  });

  it('redacts secret-looking allowlisted env values even without explicit redactValues', () => {
    const built = buildCommandTranscript({
      command: ['env'],
      commandClass: 'safe',
      approval: 'approved',
      cwd: '/tmp/project',
      env: {
        PATH: '/usr/bin',
        WAVEMILL_TEST_SECRET: 'very-secret',
        OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz1234',
      },
      durationMs: 5,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      maxOutputBytes: 1024,
    });

    assert.equal(built.event.env.WAVEMILL_TEST_SECRET, COMMAND_TRANSCRIPT_REDACTION_MARKER);
    assert.equal(built.event.env.OPENAI_API_KEY, COMMAND_TRANSCRIPT_REDACTION_MARKER);
    assert.equal(built.event.redaction.env, true);
  });

  it('captures rejected command events with empty outputs and metadata', () => {
    const built = buildCommandTranscript({
      toolName: 'git',
      command: 'sudo rm -rf /',
      commandClass: 'dangerous',
      approval: 'rejected',
      cwd: '/tmp/project',
      env: {},
      durationMs: 2,
      exitCode: null,
      signal: null,
      timedOut: false,
      rejectionReason: 'dangerous-command-pattern',
      stdout: '',
      stderr: '',
      maxOutputBytes: 128,
    });

    assert.equal(built.event.type, 'command_result');
    assert.equal(built.event.toolName, 'git');
    assert.equal(built.event.approval, 'rejected');
    assert.equal(built.event.exitCode, null);
    assert.equal(built.event.rejectionReason, 'dangerous-command-pattern');
    assert.equal(built.event.stdout, '');
    assert.equal(built.event.stderr, '');
  });
});
