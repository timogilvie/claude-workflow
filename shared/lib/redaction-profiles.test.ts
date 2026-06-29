import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  redact,
  redactWithStats,
  redactValue,
  buildProfileFromConfig,
  defaultProfile,
} from './redaction-profiles.ts';

// ---------------------------------------------------------------------------
// Pattern coverage — one positive case per category
// ---------------------------------------------------------------------------

describe('redaction-profiles: pattern coverage', () => {
  it('redacts OpenAI-style sk- tokens', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const result = redact(`The key is ${secret} and nothing else`);
    assert.ok(!result.includes(secret), 'secret must be removed');
    assert.ok(result.includes('[REDACTED:openai_key]'), 'placeholder must appear');
  });

  it('redacts AWS access key IDs', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const result = redact(`aws_access_key_id = ${secret}`);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:aws_access_key]'));
  });

  it('redacts Bearer token values', () => {
    const secret = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const result = redact(`Authorization: Bearer ${secret}`);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:bearer_token]'));
  });

  it('redacts PEM private key blocks', () => {
    const pemKey = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA2a2rwplBQLzF29amygykEMmYz0+Kcj3bKBp29kJPKlZGFK\n-----END RSA PRIVATE KEY-----`;
    const result = redact(`Here is the key:\n${pemKey}\nEnd.`);
    assert.ok(!result.includes('BEGIN RSA PRIVATE KEY'), 'PEM block must be removed');
    assert.ok(result.includes('[REDACTED:pem_private_key]'));
  });

  it('redacts GitHub classic PAT tokens (ghp_ format)', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const result = redact(`github token: ${secret}`);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:github_pat]'));
  });

  it('redacts GitHub fine-grained PAT tokens (github_pat_ format)', () => {
    // github_pat_ + 82 chars minimum
    const secret = 'github_pat_' + 'A'.repeat(82);
    const result = redact(`token: ${secret}`);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:github_pat]'));
  });

  it('redacts Slack bot tokens (xoxb-)', () => {
    const secret = ['xox', 'b-1234567890-1234567890-abcdefghijklmnop'].join('');
    const result = redact(`slack token = ${secret}`);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:slack_token]'));
  });

  it('redacts Slack app tokens (xoxa-)', () => {
    const secret = ['xox', 'a-9876543210-abcde12345678'].join('');
    const result = redact(`token: ${secret}`);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:slack_token]'));
  });

  it('redacts generic api_key assignments', () => {
    const result = redact('api_key=SUPERSECRETAPIKEY1234567890');
    assert.ok(!result.includes('SUPERSECRETAPIKEY1234567890'));
    assert.ok(result.includes('[REDACTED:generic_api_key]'));
  });

  it('redacts generic apikey: assignments', () => {
    const result = redact('apikey: MySecretApiKey1234567890abcdef');
    assert.ok(!result.includes('MySecretApiKey1234567890abcdef'));
    assert.ok(result.includes('[REDACTED:generic_api_key]'));
  });
});

// ---------------------------------------------------------------------------
// redactWithStats — returns stats
// ---------------------------------------------------------------------------

describe('redaction-profiles: redactWithStats', () => {
  it('returns categories and matchCount', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const r = redactWithStats(`token: ${secret}`);
    assert.equal(r.redacted, true);
    assert.equal(r.matchCount, 1);
    assert.ok(r.categories.includes('github_pat'));
  });

  it('returns redacted=false for clean text', () => {
    const r = redactWithStats('Hello, world!');
    assert.equal(r.redacted, false);
    assert.equal(r.matchCount, 0);
    assert.deepEqual(r.categories, []);
  });
});

// ---------------------------------------------------------------------------
// Env-var-sourced secrets
// ---------------------------------------------------------------------------

describe('redaction-profiles: buildProfileFromConfig', () => {
  it('masks configured env-var value when present', () => {
    const profile = buildProfileFromConfig(
      () => ['MY_SECRET'],
      { MY_SECRET: 'supersecretruntimevalue' },
    );
    const result = redact('some text with supersecretruntimevalue inside', profile);
    assert.ok(!result.includes('supersecretruntimevalue'));
    assert.ok(result.includes('[REDACTED:configured_secret]'));
  });

  it('does not alter text when env var is undefined', () => {
    const profile = buildProfileFromConfig(
      () => ['MISSING_VAR'],
      {},
    );
    const result = redact('nothing to redact here', profile);
    assert.equal(result, 'nothing to redact here');
  });

  it('does not alter text when env var is empty string', () => {
    const profile = buildProfileFromConfig(
      () => ['EMPTY_VAR'],
      { EMPTY_VAR: '' },
    );
    const result = redact('nothing to redact here', profile);
    assert.equal(result, 'nothing to redact here');
  });

  it('masks secret values with regex metacharacters safely', () => {
    const profile = buildProfileFromConfig(
      () => ['TRICKY_SECRET'],
      { TRICKY_SECRET: 'a.b*c+d' },
    );
    const result = redact('the value is a.b*c+d right here', profile);
    assert.ok(!result.includes('a.b*c+d'));
    assert.ok(result.includes('[REDACTED:configured_secret]'));
  });

  it('uses default profile rules when no secret names configured', () => {
    const profile = buildProfileFromConfig(() => [], {});
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const result = redact(`key = ${secret}`, profile);
    assert.ok(!result.includes(secret));
    assert.ok(result.includes('[REDACTED:aws_access_key]'));
  });
});

// ---------------------------------------------------------------------------
// False-positive boundaries
// ---------------------------------------------------------------------------

describe('redaction-profiles: false-positive boundaries', () => {
  it('"github_pattern_matching is fun" is not redacted', () => {
    const text = 'github_pattern_matching is fun';
    assert.equal(redact(text), text);
  });

  it('"sketch-of-a-plan" (sk- short) is not redacted', () => {
    const text = 'sketch-of-a-plan';
    assert.equal(redact(text), text);
  });

  it('36-char lowercase prose fragment is not redacted', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz1234567890';
    assert.equal(redact(text), text);
  });

  it('"AKIASHORT" (too short) is not redacted', () => {
    assert.equal(redact('AKIASHORT'), 'AKIASHORT');
  });

  it('"Bearer hi" (too short value) is not redacted', () => {
    assert.equal(redact('Bearer hi'), 'Bearer hi');
  });

  it('"xoxo-hello-world" (wrong role char) is not redacted', () => {
    assert.equal(redact('xoxo-hello-world'), 'xoxo-hello-world');
  });

  it('"xoxz-longvalue123456789" (unknown role char) is not redacted', () => {
    assert.equal(redact('xoxz-longvalue123456789'), 'xoxz-longvalue123456789');
  });

  it('"api_key=short" (value too short) is not redacted', () => {
    const text = 'api_key=short';
    assert.equal(redact(text), text);
  });
});

// ---------------------------------------------------------------------------
// Determinism and idempotency
// ---------------------------------------------------------------------------

describe('redaction-profiles: determinism and idempotency', () => {
  it('same input produces byte-identical output on repeated calls', () => {
    const input = 'key: sk-testFAKEKEY12345678901234567890 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const r1 = redact(input);
    const r2 = redact(input);
    assert.equal(r1, r2);
  });

  it('same secret appearing twice receives the same placeholder both times', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const result = redact(`first=${secret} second=${secret}`);
    assert.ok(!result.includes(secret));
    assert.equal(result.split('[REDACTED:aws_access_key]').length - 1, 2);
  });

  it('snapshot-style: fixed expected literal for github_pat redaction', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const result = redact(`token: ${secret}`);
    assert.equal(result, 'token: [REDACTED:github_pat]');
  });

  it('idempotency: redacting already-redacted text is a no-op', () => {
    const input = 'key: sk-testFAKEKEY12345678901234567890';
    const once = redact(input);
    const twice = redact(once);
    assert.equal(once, twice);
  });
});

// ---------------------------------------------------------------------------
// Provider URL edge case
// ---------------------------------------------------------------------------

describe('redaction-profiles: provider URL edge case', () => {
  it('redacts ghp_ token embedded in URL user-info while preserving URL structure', () => {
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const url = `https://x:${token}@github.com/org/repo.git`;
    const result = redact(url);
    assert.ok(!result.includes(token), 'token must be removed');
    assert.ok(result.includes('https://'), 'URL scheme preserved');
    assert.ok(result.includes('github.com'), 'URL host preserved');
  });
});

// ---------------------------------------------------------------------------
// redactValue — recursive value tree
// ---------------------------------------------------------------------------

describe('redaction-profiles: redactValue', () => {
  it('redacts string values in objects', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const r = redactValue({ content: `key is ${secret}`, ok: true });
    const v = r.value as Record<string, unknown>;
    assert.ok(!(v.content as string).includes(secret));
    assert.ok((v.content as string).includes('[REDACTED:openai_key]'));
    assert.equal(v.ok, true);
    assert.equal(r.redacted, true);
  });

  it('masks values under secret key names', () => {
    const r = redactValue({ authorization: 'Bearer tok123', status: 200 });
    const v = r.value as Record<string, unknown>;
    assert.equal(v.authorization, '[REDACTED]');
    assert.equal(v.status, 200);
    assert.equal(r.redacted, true);
  });

  it('traverses arrays', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const r = redactValue([`key=${secret}`, 'normal']);
    const v = r.value as string[];
    assert.ok(!v[0].includes(secret));
    assert.equal(v[1], 'normal');
  });
});

// ---------------------------------------------------------------------------
// Performance smoke
// ---------------------------------------------------------------------------

describe('redaction-profiles: performance smoke', () => {
  it('1 MB blob with one secret completes under 1 s', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const filler = 'x'.repeat(500_000);
    const blob = `${filler}${secret}${filler}`;
    const start = performance.now();
    const result = redact(blob);
    const elapsed = performance.now() - start;
    assert.ok(!result.includes(secret), 'secret must be redacted');
    assert.ok(elapsed < 1000, `Expected < 1000 ms, got ${elapsed.toFixed(1)} ms`);
  });
});
