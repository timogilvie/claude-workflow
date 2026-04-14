import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactText } from './text-redaction.ts';

describe('text-redaction', () => {
  it('replaces email addresses', () => {
    assert.equal(
      redactText('Contact user@example.com for details'),
      'Contact [EMAIL] for details',
    );
  });

  it('replaces URLs', () => {
    assert.equal(
      redactText('See https://github.com/org/repo/pull/42 for context'),
      'See [URL] for context',
    );
  });

  it('replaces absolute file paths', () => {
    assert.equal(
      redactText('Open /Users/tim/project/src/index.ts and patch it'),
      'Open [PATH] and patch it',
    );
  });

  it('replaces usernames and owner repo names', () => {
    assert.equal(
      redactText('Ask @alice to check acme/private-repo before merging'),
      'Ask [USERNAME] to check [REPO] before merging',
    );
  });

  it('handles multiple patterns in one string', () => {
    const result = redactText(
      'Email joe@test.com, inspect https://example.com/x, patch /src/lib/file.ts, then ping @joe in org/repo.',
    );

    assert.match(result, /\[EMAIL\]/);
    assert.match(result, /\[URL\]/);
    assert.match(result, /\[PATH\]|\[REPO\]/);
    assert.match(result, /\[USERNAME\]/);
    assert.match(result, /\[REPO\]/);
    assert.doesNotMatch(result, /joe@test\.com|https:\/\/example\.com|@joe|org\/repo/);
  });

  it('preserves surrounding unicode text', () => {
    assert.equal(
      redactText('Привет from user@example.com about acme/secret-repo near café'),
      'Привет from [EMAIL] about [REPO] near café',
    );
  });

  it('returns empty strings unchanged', () => {
    assert.equal(redactText(''), '');
  });
});
