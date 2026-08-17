import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCommandArgv } from './command-argv.ts';

describe('parseCommandArgv', () => {
  it('splits spaces and tabs', () => {
    assert.deepEqual(parseCommandArgv('npm   test\t--silent'), {
      ok: true,
      argv: ['npm', 'test', '--silent'],
    });
  });

  it('groups and strips double quotes', () => {
    assert.deepEqual(parseCommandArgv(`node -e "process.stdout.write('x')"`), {
      ok: true,
      argv: ['node', '-e', "process.stdout.write('x')"],
    });
  });

  it('keeps single-quoted content literal', () => {
    assert.deepEqual(parseCommandArgv(`cmd '$HOME \\" x'`), {
      ok: true,
      argv: ['cmd', '$HOME \\" x'],
    });
  });

  it('handles backslash escaping', () => {
    assert.deepEqual(parseCommandArgv(`cmd a\\ b "q\\" \\\\ \\n"`), {
      ok: true,
      argv: ['cmd', 'a b', 'q" \\ \\n'],
    });
  });

  it('concatenates quoted segments and preserves empty quoted words', () => {
    assert.deepEqual(parseCommandArgv(`cmd --grep="a b"c x '' y`), {
      ok: true,
      argv: ['cmd', '--grep=a bc', 'x', '', 'y'],
    });
  });

  for (const [command, detail] of [
    ['touch x && echo created', '&&'],
    ['a || b', '||'],
    ['ls | cat', '|'],
    ['sleep 1; echo done', ';'],
    ['sleep 1 &', '&'],
    ['echo x > out', '>'],
    ['echo x >> out', '>>'],
    ['cat < in', '<'],
    ['node x 2>&1', '2>&1'],
    ['node x &> out', '&>'],
    ['echo a\n echo b', 'newline'],
  ] as const) {
    it(`rejects unsupported shell syntax ${detail}`, () => {
      const parsed = parseCommandArgv(command);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.detail, detail);
      }
    });
  }

  it('allows quoted operators as data', () => {
    assert.deepEqual(parseCommandArgv(`cmd --grep "a && b"`), {
      ok: true,
      argv: ['cmd', '--grep', 'a && b'],
    });
  });

  for (const command of ['$HOME', 'echo $(pwd)', '`pwd`', `echo "$HOME"`]) {
    it(`rejects expansions in ${command}`, () => {
      const parsed = parseCommandArgv(command);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.match(parsed.detail, /\$|`/);
      }
    });
  }

  it('allows single-quoted dollars literally', () => {
    assert.deepEqual(parseCommandArgv(`echo '$HOME'`), {
      ok: true,
      argv: ['echo', '$HOME'],
    });
  });

  it('rejects unterminated quotes', () => {
    for (const command of [`"abc`, `'abc`]) {
      const parsed = parseCommandArgv(command);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.detail, 'unterminated quote');
      }
    }
  });

  it('rejects leading environment assignments only', () => {
    assert.equal(parseCommandArgv('CI=1 npm test').ok, false);
    assert.deepEqual(parseCommandArgv('npm test --foo=bar cmd A=b'), {
      ok: true,
      argv: ['npm', 'test', '--foo=bar', 'cmd', 'A=b'],
    });
  });

  it('passes documented non-shell metacharacters literally', () => {
    assert.deepEqual(parseCommandArgv('node -e process.exit(0)'), {
      ok: true,
      argv: ['node', '-e', 'process.exit(0)'],
    });
    assert.deepEqual(parseCommandArgv('vitest run src/**/*.test.ts'), {
      ok: true,
      argv: ['vitest', 'run', 'src/**/*.test.ts'],
    });
  });

  it('rejects the junk-file repro', () => {
    const parsed = parseCommandArgv('touch /tmp/x && echo created');
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.detail, '&&');
    }
  });
});
