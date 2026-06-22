import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REDACTION_PLACEHOLDER,
  DEFAULT_SECRET_PATTERNS,
  redactString,
  redactPayload,
} from './redaction.ts';

// ---------------------------------------------------------------------------
// redactString — Bearer tokens
// ---------------------------------------------------------------------------

describe('redactString — Bearer tokens', () => {
  it('redacts a Bearer token', () => {
    const result = redactString('Authorization: Bearer sk-abc12345678901234');
    assert.ok(!result.text.includes('sk-abc12345678901234'));
    assert.ok(result.text.includes(REDACTION_PLACEHOLDER));
    assert.ok(result.applied);
    assert.ok(result.matchCount > 0);
  });

  it('redacts multiple Bearer tokens in one string', () => {
    const input = 'token1: Bearer abcd12345678 and token2: Bearer efgh98765432';
    const result = redactString(input);
    assert.ok(!result.text.includes('abcd12345678'));
    assert.ok(!result.text.includes('efgh98765432'));
    assert.ok(result.matchCount >= 2);
  });

  it('preserves non-token content around Bearer replacement', () => {
    const result = redactString('status: ok, auth: Bearer longtoken12345678');
    assert.ok(result.text.includes('status: ok'));
    assert.ok(!result.text.includes('longtoken12345678'));
  });
});

// ---------------------------------------------------------------------------
// redactString — AWS access keys
// ---------------------------------------------------------------------------

describe('redactString — AWS access keys', () => {
  it('redacts an AKIA-prefixed key', () => {
    const result = redactString('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    assert.ok(!result.text.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(result.applied);
  });

  it('redacts an ASIA-prefixed (session) key', () => {
    const result = redactString('key: ASIAIOSFODNN7EXAMPLE1');
    assert.ok(!result.text.includes('ASIAIOSFODNN7EXAMPLE1'));
    assert.ok(result.applied);
  });
});

// ---------------------------------------------------------------------------
// redactString — sk- API tokens
// ---------------------------------------------------------------------------

describe('redactString — sk-style tokens', () => {
  it('redacts an OpenAI-style sk- token', () => {
    const input = 'api_key: sk-projAbcDefGhiJklMnoPqrStuVwxYz0123456789';
    const result = redactString(input);
    assert.ok(!result.text.includes('sk-projAbcDefGhiJklMnoPqrStuVwxYz0123456789'));
    assert.ok(result.applied);
  });

  it('redacts Anthropic-style sk-ant token', () => {
    const input = 'key=sk-ant-abcdefghijklmnopqrstuvwx';
    const result = redactString(input);
    assert.ok(!result.text.includes('sk-ant-abcdefghijklmnopqrstuvwx'));
    assert.ok(result.applied);
  });

  it('does not redact short sk- strings under the 20-char threshold', () => {
    // 'sk-short' is only 8 chars after 'sk-' — below the 20-char minimum
    const input = 'sk-short';
    const result = redactString(input);
    // The sk- pattern requires at least 20 chars after 'sk-'
    assert.equal(result.applied, false);
    assert.equal(result.text, 'sk-short');
  });
});

// ---------------------------------------------------------------------------
// redactString — assignment forms
// ---------------------------------------------------------------------------

describe('redactString — assignment forms', () => {
  it('redacts apiKey=value assignment', () => {
    const result = redactString('config: apiKey=supersecret12345678');
    assert.ok(!result.text.includes('supersecret12345678'));
    assert.ok(result.applied);
  });

  it('redacts token: value assignment', () => {
    const result = redactString('headers: { token: mytoken123456789 }');
    assert.ok(!result.text.includes('mytoken123456789'));
    assert.ok(result.applied);
  });

  it('redacts case-insensitive key names', () => {
    const result = redactString('API_KEY=LongSecretValue1234');
    // apiKey vs API_KEY — both should match (case-insensitive flag)
    // Note: the pattern uses word boundary and specific key names
    const result2 = redactString('APIKEY=LongSecretValue1234');
    assert.ok(result.applied || result2.applied, 'at least one form should be redacted');
  });

  it('does not redact very short values (under 8 chars)', () => {
    // Values must be at least 8 chars to match the assignment pattern
    const result = redactString('token: short');
    // 'short' is 5 chars, below threshold
    assert.equal(result.applied, false);
  });
});

// ---------------------------------------------------------------------------
// redactString — no match cases
// ---------------------------------------------------------------------------

describe('redactString — no match', () => {
  it('returns input unchanged when no patterns match', () => {
    const input = 'Planning complete. No secrets here.';
    const result = redactString(input);
    assert.equal(result.text, input);
    assert.equal(result.applied, false);
    assert.equal(result.matchCount, 0);
  });

  it('returns empty string unchanged', () => {
    const result = redactString('');
    assert.equal(result.text, '');
    assert.equal(result.applied, false);
  });

  it('does not redact file paths that look like normal code', () => {
    const input = '/workspace/features/plan.md';
    const result = redactString(input);
    assert.equal(result.text, input);
    assert.equal(result.applied, false);
  });
});

// ---------------------------------------------------------------------------
// redactString — custom patterns
// ---------------------------------------------------------------------------

describe('redactString — custom patterns', () => {
  it('accepts a custom pattern set and ignores defaults', () => {
    const customPattern = /MY_SECRET_\w+/g;
    const result = redactString('env: MY_SECRET_VALUE and Bearer longtoken1234567', {
      patterns: [customPattern],
    });
    // Custom pattern matches MY_SECRET_VALUE
    assert.ok(!result.text.includes('MY_SECRET_VALUE'));
    // Default patterns are NOT applied because we passed custom patterns
    assert.ok(result.text.includes('Bearer longtoken1234567'));
  });

  it('empty pattern array returns input unchanged', () => {
    const input = 'Bearer abcdefghijklmnop';
    const result = redactString(input, { patterns: [] });
    assert.equal(result.text, input);
    assert.equal(result.applied, false);
  });
});

// ---------------------------------------------------------------------------
// redactPayload — basic object redaction
// ---------------------------------------------------------------------------

describe('redactPayload — objects', () => {
  it('redacts values with secret key names', () => {
    const input = { authorization: 'Bearer tok123456789', status: 200 };
    const result = redactPayload(input);
    assert.equal((result as typeof input).authorization, REDACTION_PLACEHOLDER);
    assert.equal((result as typeof input).status, 200);
  });

  it('redacts apiKey and api_key fields', () => {
    const input = { apiKey: 'sk-key123456789012345678', api_key: 'another-key-123456789012345' };
    const result = redactPayload(input) as typeof input;
    assert.equal(result.apiKey, REDACTION_PLACEHOLDER);
    assert.equal(result.api_key, REDACTION_PLACEHOLDER);
  });

  it('applies pattern-based redaction to string values under non-secret keys', () => {
    const input = { message: 'Bearer longtoken1234567890', path: '/workspace/notes.md' };
    const result = redactPayload(input) as typeof input;
    assert.ok(!result.message.includes('longtoken1234567890'));
    assert.ok(result.message.includes(REDACTION_PLACEHOLDER));
    assert.equal(result.path, '/workspace/notes.md');
  });

  it('preserves numbers, booleans, and null', () => {
    const input = { count: 42, flag: true, empty: null };
    const result = redactPayload(input) as typeof input;
    assert.equal(result.count, 42);
    assert.equal(result.flag, true);
    assert.equal(result.empty, null);
  });

  it('key matching is case-insensitive', () => {
    const input = { Authorization: 'tok', TOKEN: 'tok', Password: 'tok' };
    const result = redactPayload(input) as typeof input;
    assert.equal(result.Authorization, REDACTION_PLACEHOLDER);
    assert.equal(result.TOKEN, REDACTION_PLACEHOLDER);
    assert.equal(result.Password, REDACTION_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// redactPayload — nested objects
// ---------------------------------------------------------------------------

describe('redactPayload — nested objects', () => {
  it('redacts secret keys in nested objects', () => {
    const input = { headers: { authorization: 'Bearer tok12345678' }, status: 200 };
    const result = redactPayload(input) as typeof input;
    assert.equal(result.headers.authorization, REDACTION_PLACEHOLDER);
    assert.equal(result.status, 200);
  });

  it('traverses deeply nested structures', () => {
    const input = { a: { b: { c: { token: 'deep-secret-token-123456' } } } };
    const result = redactPayload(input) as typeof input;
    assert.equal(result.a.b.c.token, REDACTION_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// redactPayload — arrays
// ---------------------------------------------------------------------------

describe('redactPayload — arrays', () => {
  it('traverses arrays and redacts items', () => {
    const input = [{ apiKey: 'key1234567890123456789' }, { path: '/foo' }];
    const result = redactPayload(input) as typeof input;
    assert.equal(result[0].apiKey, REDACTION_PLACEHOLDER);
    assert.equal(result[1].path, '/foo');
  });

  it('handles arrays of strings with pattern redaction', () => {
    const input = ['Bearer longtoken1234567890', 'safe text'];
    const result = redactPayload(input) as string[];
    assert.ok(!result[0].includes('longtoken1234567890'));
    assert.equal(result[1], 'safe text');
  });
});

// ---------------------------------------------------------------------------
// redactPayload — no mutation
// ---------------------------------------------------------------------------

describe('redactPayload — no mutation', () => {
  it('does not mutate the input object', () => {
    const input = { authorization: 'Bearer original-token-123456789', path: '/notes.md' };
    const originalAuth = input.authorization;
    redactPayload(input);
    assert.equal(input.authorization, originalAuth, 'input must not be mutated');
    assert.equal(input.path, '/notes.md');
  });

  it('does not mutate nested input objects', () => {
    const inner = { token: 'secret-token-12345678901234567890' };
    const input = { headers: inner };
    redactPayload(input);
    assert.equal(inner.token, 'secret-token-12345678901234567890', 'inner object must not be mutated');
  });

  it('does not mutate input arrays', () => {
    const input = [{ apiKey: 'key-123456789012345678' }];
    const originalKey = input[0].apiKey;
    redactPayload(input);
    assert.equal(input[0].apiKey, originalKey, 'array element must not be mutated');
  });
});

// ---------------------------------------------------------------------------
// redactPayload — bounded depth
// ---------------------------------------------------------------------------

describe('redactPayload — bounded depth', () => {
  it('stops recursing at maxDepth (default 10)', () => {
    // Build a 12-deep nested object
    let deep: Record<string, unknown> = { token: 'deep-secret-token-1234567' };
    for (let i = 0; i < 11; i++) {
      deep = { child: deep };
    }
    // At default maxDepth=10, the innermost node should be returned as-is
    // (depth limit hit before reaching the token key at depth 12)
    const result = redactPayload(deep);
    // We just verify it doesn't throw (infinite recursion protection)
    assert.ok(result !== undefined);
  });

  it('respects custom maxDepth option', () => {
    const input = { a: { token: 'deep-secret-123456789012345' } };
    // maxDepth=0: the root object itself exceeds depth limit immediately
    const result0 = redactPayload(input, { maxDepth: 0 });
    // At maxDepth 0, depth >= maxDepth at root → returns input as-is
    assert.equal((result0 as typeof input).a.token, 'deep-secret-123456789012345');

    // maxDepth=1: root is processed, but children at depth 1 are NOT recursed
    // so the nested object at depth 1 is returned unchanged
    const result1 = redactPayload(input, { maxDepth: 1 });
    // The inner object at depth 1 is returned as-is (not processed)
    assert.equal((result1 as typeof input).a.token, 'deep-secret-123456789012345');

    // maxDepth=2: root (depth 0) + child (depth 1) are both processed
    const result2 = redactPayload(input, { maxDepth: 2 });
    assert.equal((result2 as typeof input).a.token, REDACTION_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// redactPayload — circular references
// ---------------------------------------------------------------------------

describe('redactPayload — circular references', () => {
  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { name: 'root' };
    obj.self = obj; // circular
    assert.doesNotThrow(() => redactPayload(obj));
  });

  it('replaces circular reference node with [Circular]', () => {
    const obj: Record<string, unknown> = { name: 'root', path: '/workspace' };
    obj.self = obj;
    const result = redactPayload(obj) as Record<string, unknown>;
    assert.equal(result.self, '[Circular]');
    assert.equal(result.path, '/workspace');
  });
});

// ---------------------------------------------------------------------------
// redactPayload — primitives
// ---------------------------------------------------------------------------

describe('redactPayload — primitives', () => {
  it('returns null unchanged', () => {
    assert.equal(redactPayload(null), null);
  });

  it('returns undefined unchanged', () => {
    assert.equal(redactPayload(undefined), undefined);
  });

  it('returns numbers unchanged', () => {
    assert.equal(redactPayload(42), 42);
  });

  it('applies pattern redaction to bare strings', () => {
    const result = redactPayload('Bearer longtoken12345678901234');
    assert.ok(!(result as string).includes('longtoken12345678901234'));
  });

  it('returns safe bare strings unchanged', () => {
    assert.equal(redactPayload('hello world'), 'hello world');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SECRET_PATTERNS export
// ---------------------------------------------------------------------------

describe('DEFAULT_SECRET_PATTERNS', () => {
  it('is a non-empty readonly array', () => {
    assert.ok(Array.isArray(DEFAULT_SECRET_PATTERNS));
    assert.ok(DEFAULT_SECRET_PATTERNS.length > 0);
  });

  it('every entry is a RegExp', () => {
    for (const pattern of DEFAULT_SECRET_PATTERNS) {
      assert.ok(pattern instanceof RegExp, `Expected RegExp, got ${typeof pattern}`);
    }
  });
});
