import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerificationDrift } from './pre-pr-verification-drift-validator.ts';

describe('pre-pr-verification-drift-validator', () => {
  it('warns on unmapped checks by default', () => {
    const result = validateVerificationDrift({
      repository: 'acme/widgets',
      discovery: {
        checks: ['Security Scan'],
        source: 'ruleset',
        timestamp: '2026-08-04T12:00:00Z',
      },
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: ['npm run lint'] },
      },
    });

    assert.equal(result.passed, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 1);
  });

  it('blocks unmapped checks when configured to block', () => {
    const result = validateVerificationDrift({
      repository: 'acme/widgets',
      discovery: {
        checks: ['Security Scan'],
        source: 'ruleset',
        timestamp: '2026-08-04T12:00:00Z',
      },
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: ['npm run lint'] },
        driftValidation: {
          enabled: true,
          blockOnUnmapped: true,
        },
      },
    });

    assert.equal(result.passed, false);
    assert.equal(result.errors.length, 1);
  });

  it('does not warn for acknowledged remote-only checks', () => {
    const result = validateVerificationDrift({
      repository: 'acme/widgets',
      discovery: {
        checks: ['Security Scan'],
        source: 'ruleset',
        timestamp: '2026-08-04T12:00:00Z',
      },
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: ['npm run lint'] },
        remoteOnlyExceptions: [
          {
            checkName: 'Security Scan',
            reason: 'Requires org secrets unavailable locally',
          },
        ],
      },
    });

    assert.equal(result.passed, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
  });
});
