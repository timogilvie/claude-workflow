import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactSecrets, redactSecretsInValue } from './tools/redaction.ts';

describe('native-agent redaction shim', () => {
  it('redacts every required secret class through the native-agent import path', () => {
    const cases = [
      {
        label: 'openai_key',
        text: 'OpenAI key: sk-testFAKEKEY12345678901234567890',
        placeholder: '[REDACTED:openai_key]',
        secret: 'sk-testFAKEKEY12345678901234567890',
      },
      {
        label: 'aws_access_key',
        text: 'aws_access_key_id=AKIAIOSFODNN7EXAMPLE',
        placeholder: '[REDACTED:aws_access_key]',
        secret: 'AKIAIOSFODNN7EXAMPLE',
      },
      {
        label: 'bearer_token',
        text: 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        placeholder: '[REDACTED:bearer_token]',
        secret: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      },
      {
        label: 'pem_private_key',
        text: [
          '-----BEGIN RSA PRIVATE KEY-----',
          'MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29',
          'kJPKlZGFKqFC',
          '-----END RSA PRIVATE KEY-----',
        ].join('\n'),
        placeholder: '[REDACTED:pem_private_key]',
        secret: 'BEGIN RSA PRIVATE KEY',
      },
      {
        label: 'github_pat',
        text: 'github token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
        placeholder: '[REDACTED:github_pat]',
        secret: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      },
      {
        label: 'slack_token',
        text: 'slack token: xoxb-1234567890-ABCDEFGHIJ-klmnopqrstuv',
        placeholder: '[REDACTED:slack_token]',
        secret: 'xoxb-1234567890-ABCDEFGHIJ-klmnopqrstuv',
      },
      {
        label: 'generic_api_key',
        text: 'api_key = "service_key_1234567890abcd"',
        placeholder: '[REDACTED:generic_api_key]',
        secret: 'service_key_1234567890abcd',
      },
    ] as const;

    for (const testCase of cases) {
      const result = redactSecrets(testCase.text);
      assert.equal(
        result.text.includes(testCase.secret),
        false,
        `[redaction-failure] ${testCase.label} leaked through native-agent redaction`,
      );
      assert.ok(
        result.text.includes(testCase.placeholder),
        `[redaction-failure] ${testCase.label} placeholder missing through native-agent redaction`,
      );
      assert.ok(
        result.categories.includes(testCase.label),
        `[redaction-failure] ${testCase.label} category missing through native-agent redaction`,
      );
    }
  });

  it('redacts repeated secrets while preserving surrounding non-secret text', () => {
    const secret = 'sk-testFAKEKEY12345678901234567890';
    const text = `prefix ${secret} middle ${secret} suffix`;
    const result = redactSecrets(text);

    assert.equal(
      result.text.includes(secret),
      false,
      '[redaction-failure] repeated OpenAI secrets leaked through native-agent redaction',
    );
    assert.equal(
      result.matchCount,
      2,
      '[redaction-failure] repeated OpenAI secrets should count both occurrences',
    );
    assert.ok(
      result.text.startsWith('prefix '),
      '[redaction-failure] native-agent redaction should preserve leading context',
    );
    assert.ok(
      result.text.endsWith(' suffix'),
      '[redaction-failure] native-agent redaction should preserve trailing context',
    );
  });

  it('leaves clean strings unchanged', () => {
    const clean = 'no credentials here; just a normal status line';
    const result = redactSecrets(clean);

    assert.equal(result.text, clean);
    assert.equal(result.redacted, false);
    assert.equal(result.matchCount, 0);
  });

  it('masks secret-key fields in object trees and preserves adjacent values', () => {
    const result = redactSecretsInValue({
      apiKey: 'sk-secret',
      nested: {
        authorization: 'Bearer top-secret-token-value',
        password: 'hunter2',
        note: 'keep me',
      },
      metadata: {
        path: '/repo/README.md',
      },
    });

    assert.deepEqual(result.value, {
      apiKey: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        password: '[REDACTED]',
        note: 'keep me',
      },
      metadata: {
        path: '/repo/README.md',
      },
    });
    assert.equal(result.redacted, true);
  });
});
