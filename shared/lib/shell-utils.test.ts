/**
 * Tests for shell-utils.ts
 *
 * Verifies that escapeShellArg properly escapes all shell metacharacters
 * and that execShellCommand executes safely.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

describe('escapeShellArg', () => {
  it('should escape simple strings without special characters', () => {
    assert.equal(escapeShellArg('hello'), "'hello'");
    assert.equal(escapeShellArg('test123'), "'test123'");
  });

  it('should escape empty strings', () => {
    assert.equal(escapeShellArg(''), "''");
  });

  it('should escape strings with spaces', () => {
    assert.equal(escapeShellArg('hello world'), "'hello world'");
    assert.equal(escapeShellArg('  spaces  '), "'  spaces  '");
  });

  it('should escape strings with single quotes', () => {
    assert.equal(escapeShellArg("user's file"), "'user'\\''s file'");
    assert.equal(escapeShellArg("it's a test"), "'it'\\''s a test'");
    assert.equal(escapeShellArg("'quoted'"), "''\\''quoted'\\'''");
  });

  it('should escape strings with shell metacharacters', () => {
    assert.equal(escapeShellArg('a;b'), "'a;b'");
    assert.equal(escapeShellArg('a|b'), "'a|b'");
    assert.equal(escapeShellArg('a&b'), "'a&b'");
    assert.equal(escapeShellArg('a>b'), "'a>b'");
    assert.equal(escapeShellArg('a<b'), "'a<b'");
    assert.equal(escapeShellArg('a`b'), "'a`b'");
    assert.equal(escapeShellArg('a$b'), "'a$b'");
    assert.equal(escapeShellArg('a(b)'), "'a(b)'");
  });

  it('should escape strings with newlines and tabs', () => {
    assert.equal(escapeShellArg('line1\nline2'), "'line1\nline2'");
    assert.equal(escapeShellArg('tab\there'), "'tab\there'");
  });

  it('should escape strings with backslashes', () => {
    assert.equal(escapeShellArg('path\\to\\file'), "'path\\to\\file'");
  });

  it('should escape strings with wildcards', () => {
    assert.equal(escapeShellArg('*.txt'), "'*.txt'");
    assert.equal(escapeShellArg('file?.md'), "'file?.md'");
  });

  it('should escape complex real-world examples', () => {
    // File path with spaces and quotes
    assert.equal(
      escapeShellArg("/path/to/user's file (1).txt"),
      "'/path/to/user'\\''s file (1).txt'"
    );

    // Issue ID (should be simple but verify)
    assert.equal(escapeShellArg('HOK-123'), "'HOK-123'");

    // PR number
    assert.equal(escapeShellArg('456'), "'456'");
  });
});

describe('execShellCommand', () => {
  it('should execute simple commands', () => {
    const result = execShellCommand('echo "hello"', { encoding: 'utf-8' });
    assert.equal(result.trim(), 'hello');
  });

  it('should execute commands with escaped arguments', () => {
    const arg = "test's file";
    const result = execShellCommand(
      `echo ${escapeShellArg(arg)}`,
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), "test's file");
  });

  it('should handle pipes and redirections', () => {
    const result = execShellCommand(
      'echo "hello world" | grep hello',
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), 'hello world');
  });

  it('should handle stderr redirection', () => {
    const result = execShellCommand(
      'echo "test" 2>/dev/null',
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), 'test');
  });

  it('should preserve special characters when escaped', () => {
    const special = 'a;b|c&d';
    const result = execShellCommand(
      `echo ${escapeShellArg(special)}`,
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), special);
  });

  it('should throw on command failure', () => {
    assert.throws(() => {
      execShellCommand('exit 1', { encoding: 'utf-8' });
    });
  });

  it('should respect cwd option', () => {
    const result = execShellCommand(
      'pwd',
      { encoding: 'utf-8', cwd: '/tmp' }
    );
    // On macOS, /tmp is a symlink to /private/tmp, so check for both
    const pwd = result.trim();
    assert.ok(pwd === '/tmp' || pwd === '/private/tmp', `Expected /tmp or /private/tmp, got ${pwd}`);
  });
});

describe('Integration: escapeShellArg + execShellCommand', () => {
  it('should prevent command injection', () => {
    // Attempt to inject commands via semicolon
    const malicious = 'file.txt; rm -rf /';
    const result = execShellCommand(
      `echo ${escapeShellArg(malicious)}`,
      { encoding: 'utf-8' }
    );
    // Should echo the literal string, not execute the rm command
    assert.equal(result.trim(), malicious);
  });

  it('should prevent command injection via pipe', () => {
    const malicious = 'file.txt | cat /etc/passwd';
    const result = execShellCommand(
      `echo ${escapeShellArg(malicious)}`,
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), malicious);
  });

  it('should prevent command injection via command substitution', () => {
    const malicious = 'file.txt$(whoami)';
    const result = execShellCommand(
      `echo ${escapeShellArg(malicious)}`,
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), malicious);
  });

  it('should prevent command injection via backticks', () => {
    const malicious = 'file.txt`whoami`';
    const result = execShellCommand(
      `echo ${escapeShellArg(malicious)}`,
      { encoding: 'utf-8' }
    );
    assert.equal(result.trim(), malicious);
  });
});
