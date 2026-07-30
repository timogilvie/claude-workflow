/**
 * Tests for shell-utils.ts
 *
 * Verifies that escapeShellArg properly escapes all shell metacharacters
 * and that execShellCommand executes safely.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { escapeShellArg, execShellCommand, execFileCommand, _setExecFileCommandForTest } from './shell-utils.ts';

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

describe('execFileCommand', () => {
  // Invoke `node -e <script>` to print process.argv as JSON, then parse the
  // stdout back in the test. This proves argv entries reach the child process
  // verbatim — no shell parsing, no quote stripping, no glob expansion. We use
  // fs.writeSync(1, ...) for a synchronous, guaranteed-flushed write to the pipe.
  const ARGV_SCRIPT = "require('fs').writeSync(1, JSON.stringify(process.argv.slice(1)))";
  function runNodeWithArgs(extraArgs: string[]): string[] {
    // The `--` separator tells Node to stop parsing options, so leading-dash
    // arguments are treated as program arguments rather than Node flags. Node
    // consumes the `--` itself, so it does not appear in process.argv.
    const output = execFileCommand(process.execPath, ['-e', ARGV_SCRIPT, '--', ...extraArgs], {
      encoding: 'utf-8',
    });
    return JSON.parse(String(output));
  }

  it('runs node --version', () => {
    const output = execFileCommand(process.execPath, ['--version'], { encoding: 'utf-8' });
    assert.match(String(output), /^v\d+/);
  });

  it('passes a path with parentheses as a single argv element', () => {
    const arg = 'app/(auth)/dashboard/page.tsx';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes a path with a space as a single argv element', () => {
    const arg = 'app/has space/page.tsx';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes a path with a double quote as a single argv element', () => {
    const arg = 'app/quote"dir/page.tsx';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes a path with square brackets as a single argv element', () => {
    const arg = 'app/[team]/page.tsx';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes a path with glob metacharacters as a single argv element', () => {
    const arg = 'app/glob*literal/page.tsx';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes a leading-dash filename as a single argv element', () => {
    const arg = '--leading-dash.ts';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes a string with shell metacharacters verbatim', () => {
    const arg = 'semi;pipe|dollar$backtick`';
    const argv = runNodeWithArgs([arg]);
    assert.deepEqual(argv, [arg]);
  });

  it('passes multiple special paths as separate argv elements', () => {
    const args = [
      'app/(auth)/dashboard/page.tsx',
      'app/has space/page.tsx',
      'app/quote"dir/page.tsx',
      'app/[team]/page.tsx',
      'app/glob*literal/page.tsx',
      '--leading-dash.ts',
    ];
    const argv = runNodeWithArgs(args);
    assert.deepEqual(argv, args);
  });

  it('throws on non-zero exit, matching execShellCommand semantics', () => {
    assert.throws(() => {
      execFileCommand(process.execPath, ['-e', 'process.exit(1)'], { encoding: 'utf-8' });
    });
  });

  it('respects cwd option', () => {
    const output = execFileCommand(
      process.execPath,
      ['-e', "require('fs').writeSync(1, process.cwd())"],
      { encoding: 'utf-8', cwd: '/tmp' }
    );
    // On macOS /tmp is a symlink to /private/tmp.
    const cwd = String(output);
    assert.ok(cwd === '/tmp' || cwd === '/private/tmp', `Expected /tmp or /private/tmp, got ${cwd}`);
  });

  it('test seam can override the implementation and is restorable', () => {
    let captured: { file: string; args: readonly string[] } | null = null;
    _setExecFileCommandForTest((file, args) => {
      captured = { file, args };
      return 'captured';
    });
    try {
      const result = execFileCommand('grep', ['--help', 'path/with (parens)'], { encoding: 'utf-8' });
      assert.equal(result, 'captured');
      assert.ok(captured !== null);
      assert.equal(captured!.file, 'grep');
      assert.deepEqual(captured!.args, ['--help', 'path/with (parens)']);
    } finally {
      _setExecFileCommandForTest(null);
    }

    // After restoring, the helper spawns a real process again. A failing node
    // command should throw, proving the default implementation is back in place.
    assert.throws(() => {
      execFileCommand(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf-8' });
    });
  });
});
