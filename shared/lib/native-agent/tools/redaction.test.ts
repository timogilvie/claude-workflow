import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets, redactSecretsInValue } from './redaction.ts';

// ---------------------------------------------------------------------------
// redactSecrets — string-level pattern matching
// ---------------------------------------------------------------------------

describe('redactSecrets — no-match passthrough', () => {
  it('returns unchanged text when no patterns match', () => {
    const r = redactSecrets('Hello, world!');
    assert.equal(r.text, 'Hello, world!');
    assert.equal(r.redacted, false);
    assert.equal(r.matchCount, 0);
    assert.deepEqual(r.categories, []);
  });

  it('handles empty string', () => {
    const r = redactSecrets('');
    assert.equal(r.text, '');
    assert.equal(r.redacted, false);
  });

  it('handles null gracefully', () => {
    const r = redactSecrets(null);
    assert.equal(r.text, '');
    assert.equal(r.redacted, false);
  });

  it('handles undefined gracefully', () => {
    const r = redactSecrets(undefined);
    assert.equal(r.text, '');
    assert.equal(r.redacted, false);
  });

  it('converts non-string non-null values to string without redacting', () => {
    const r = redactSecrets(42);
    assert.equal(r.text, '42');
    assert.equal(r.redacted, false);
  });
});

describe('redactSecrets — default patterns', () => {
  it('redacts OpenAI-style sk- tokens', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecrets(`The key is ${secret} and nothing else`);
    assert.ok(!r.text.includes(secret), 'secret must be removed');
    assert.ok(r.text.includes('[REDACTED:openai_key]'), 'placeholder must appear');
    assert.equal(r.redacted, true);
    assert.equal(r.matchCount, 1);
    assert.ok(r.categories.includes('openai_key'));
  });

  it('redacts AWS access key IDs', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const r = redactSecrets(`aws_access_key_id = ${secret}`);
    assert.ok(!r.text.includes(secret));
    assert.ok(r.text.includes('[REDACTED:aws_access_key]'));
    assert.ok(r.categories.includes('aws_access_key'));
  });

  it('redacts Bearer token values', () => {
    const secret = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const r = redactSecrets(`Authorization: Bearer ${secret}`);
    assert.ok(!r.text.includes(secret));
    assert.ok(r.categories.includes('bearer_token'));
  });

  it('redacts PEM private key blocks', () => {
    const pemKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29
kJPKlZGFKqFC
-----END RSA PRIVATE KEY-----`;
    const r = redactSecrets(`Here is the key:\n${pemKey}\nEnd.`);
    assert.ok(!r.text.includes('BEGIN RSA PRIVATE KEY'), 'PEM block must be removed');
    assert.ok(r.categories.includes('pem_private_key'));
    assert.equal(r.redacted, true);
  });

  it('redacts GitHub PAT tokens (ghp_ format)', () => {
    // ghp_ + exactly 36 alphanumeric chars (GitHub classic PAT format)
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const r = redactSecrets(`github token: ${secret}`);
    assert.ok(!r.text.includes(secret));
    assert.ok(r.categories.includes('github_pat'));
  });

  it('handles multiple matches and multiple categories in one string', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const openaiKey = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecrets(`aws=${awsKey} openai=${openaiKey}`);
    assert.ok(!r.text.includes(awsKey));
    assert.ok(!r.text.includes(openaiKey));
    assert.ok(r.matchCount >= 2);
    assert.ok(r.categories.includes('aws_access_key'));
    assert.ok(r.categories.includes('openai_key'));
  });

  it('handles repeated matches of the same pattern', () => {
    const key = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecrets(`first=${key} second=${key}`);
    assert.ok(!r.text.includes(key));
    assert.equal(r.matchCount, 2);
  });
});

describe('redactSecrets — extra patterns', () => {
  it('supports injecting extra RegExp patterns', () => {
    const r = redactSecrets('password: TESTSECRETVALUE', {
      extraPatterns: [/TESTSECRETVALUE/g],
    });
    assert.ok(!r.text.includes('TESTSECRETVALUE'));
    assert.equal(r.redacted, true);
    assert.ok(r.categories.includes('custom'));
  });

  it('supports injecting extra SecretPattern objects', () => {
    const r = redactSecrets('my_token: MY-INTERNAL-SECRET-123', {
      extraPatterns: [{ category: 'internal_secret', regex: /MY-INTERNAL-SECRET-\d+/g }],
    });
    assert.ok(!r.text.includes('MY-INTERNAL-SECRET-123'));
    assert.ok(r.categories.includes('internal_secret'));
  });

  it('extra patterns without g flag are made global automatically', () => {
    const r = redactSecrets('SEED SEED SEED', {
      extraPatterns: [{ category: 'seed', regex: /SEED/ }],
    });
    assert.ok(!r.text.includes('SEED'));
    assert.equal(r.matchCount, 3);
  });
});

describe('redactSecrets — custom placeholder', () => {
  it('uses string placeholder when provided', () => {
    const key = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecrets(key, { placeholder: '***' });
    assert.equal(r.text, '***');
  });

  it('uses function placeholder that receives the category', () => {
    const key = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecrets(key, { placeholder: (cat) => `<${cat.toUpperCase()}>` });
    assert.equal(r.text, '<OPENAI_KEY>');
  });
});

// ---------------------------------------------------------------------------
// redactSecretsInValue — object/array tree redaction
// ---------------------------------------------------------------------------

describe('redactSecretsInValue — key-name masking', () => {
  it('masks value under authorization key', () => {
    const r = redactSecretsInValue({ authorization: 'Bearer tok123', status: 200 });
    const v = r.value as Record<string, unknown>;
    assert.equal(v.authorization, '[REDACTED]');
    assert.equal(v.status, 200);
    assert.equal(r.redacted, true);
  });

  it('masks all standard secret keys (case-insensitive match)', () => {
    const input = {
      apiKey: 'sk-secret',
      api_key: 'another',
      token: 'tok-xyz',
      secret: 'my-secret',
      password: 'hunter2',
      key: 'some-key',
    };
    const r = redactSecretsInValue(input);
    const v = r.value as Record<string, unknown>;
    for (const k of Object.keys(input)) {
      assert.equal(v[k], '[REDACTED]', `Expected ${k} to be redacted`);
    }
  });

  it('preserves non-secret keys', () => {
    const r = redactSecretsInValue({ path: '/workspace/notes.md', bytes: 18 });
    assert.deepEqual(r.value, { path: '/workspace/notes.md', bytes: 18 });
    assert.equal(r.redacted, false);
  });

  it('masks nested secret keys', () => {
    const r = redactSecretsInValue({ headers: { authorization: 'Bearer tok' }, status: 200 });
    const v = r.value as { headers: { authorization: string }; status: number };
    assert.equal(v.headers.authorization, '[REDACTED]');
    assert.equal(v.status, 200);
  });

  it('traverses arrays', () => {
    const r = redactSecretsInValue([{ apiKey: 'secret' }, { path: '/foo' }]);
    const v = r.value as Array<Record<string, unknown>>;
    assert.equal(v[0].apiKey, '[REDACTED]');
    assert.equal(v[1].path, '/foo');
  });
});

describe('redactSecretsInValue — pattern redaction of string leaves', () => {
  it('pattern-redacts string values not under secret keys', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecretsInValue({ content: `key is ${secret}`, ok: true });
    const v = r.value as Record<string, unknown>;
    assert.ok(!(v.content as string).includes(secret));
    assert.ok((v.content as string).includes('[REDACTED:openai_key]'));
    assert.equal(v.ok, true);
    assert.equal(r.redacted, true);
  });

  it('pattern-redacts string values in arrays', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const r = redactSecretsInValue(['normal', `key=${secret}`]);
    const v = r.value as string[];
    assert.equal(v[0], 'normal');
    assert.ok(!v[1].includes(secret));
  });

  it('pattern-redacts git diff content containing a secret', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const diff = `@@ -1,3 +1,4 @@\n const X = '${secret}';\n+// new\n`;
    const r = redactSecretsInValue({ diff, truncated: false });
    const v = r.value as Record<string, unknown>;
    assert.ok(!(v.diff as string).includes(secret));
    assert.ok((v.diff as string).includes('[REDACTED:openai_key]'));
    assert.equal(v.truncated, false);
  });
});

describe('redactSecretsInValue — primitives and edge cases', () => {
  it('returns string unchanged when no patterns match', () => {
    const r = redactSecretsInValue('hello world');
    assert.equal(r.value, 'hello world');
    assert.equal(r.redacted, false);
  });

  it('returns numbers unchanged', () => {
    const r = redactSecretsInValue(42);
    assert.equal(r.value, 42);
    assert.equal(r.redacted, false);
  });

  it('returns null unchanged', () => {
    const r = redactSecretsInValue(null);
    assert.equal(r.value, null);
    assert.equal(r.redacted, false);
  });

  it('returns undefined unchanged', () => {
    const r = redactSecretsInValue(undefined);
    assert.equal(r.value, undefined);
    assert.equal(r.redacted, false);
  });

  it('respects depth limit and stops recursing at depth 10', () => {
    // Build a deeply nested object at depth 12
    let obj: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 12; i++) {
      obj = { nested: obj };
    }
    // Should not throw, even at excessive depth
    assert.doesNotThrow(() => redactSecretsInValue(obj));
  });
});
