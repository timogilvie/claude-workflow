import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getReviewProvider, printTroubleshooting } from './check-review-setup.ts';

afterEach(() => {
  delete process.env.WAVEMILL_REVIEW_MODEL;
  delete process.env.WAVEMILL_HEADLESS_MODEL;
});

describe('getReviewProvider', () => {
  it('returns codex by default (gpt-5.5 model)', () => {
    assert.equal(getReviewProvider(), 'codex');
  });

  it('returns claude when WAVEMILL_REVIEW_MODEL is a claude model', () => {
    process.env.WAVEMILL_REVIEW_MODEL = 'claude-sonnet-4-6';
    assert.equal(getReviewProvider(), 'claude');
  });

  it('returns claude when WAVEMILL_HEADLESS_MODEL is a claude model', () => {
    process.env.WAVEMILL_HEADLESS_MODEL = 'claude-haiku-4-5-20251001';
    assert.equal(getReviewProvider(), 'claude');
  });

  it('WAVEMILL_REVIEW_MODEL takes precedence over WAVEMILL_HEADLESS_MODEL', () => {
    process.env.WAVEMILL_REVIEW_MODEL = 'gpt-5.5';
    process.env.WAVEMILL_HEADLESS_MODEL = 'claude-sonnet-4-6';
    assert.equal(getReviewProvider(), 'codex');
  });

  it('returns codex for gpt-4o override', () => {
    process.env.WAVEMILL_REVIEW_MODEL = 'gpt-4o';
    assert.equal(getReviewProvider(), 'codex');
  });
});

describe('printTroubleshooting', () => {
  function captureOutput(fn: () => void): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines.join('\n');
  }

  const codexFailed = [
    { name: 'Git', passed: true, message: 'ok' },
    { name: 'Git Repository', passed: true, message: 'ok' },
    { name: 'Codex CLI', passed: false, message: 'Not available' },
  ];

  const claudeFailed = [
    { name: 'Git', passed: true, message: 'ok' },
    { name: 'Git Repository', passed: true, message: 'ok' },
    { name: 'Claude CLI', passed: false, message: 'Not available' },
    { name: 'Network Connectivity', passed: false, message: 'Cannot reach' },
  ];

  it('codex provider shows Codex install/auth/test/PATH guidance', () => {
    const output = captureOutput(() => printTroubleshooting(codexFailed, 'codex'));
    assert.match(output, /brew install codex/);
    assert.match(output, /codex login/);
    assert.match(output, /codex exec --json --sandbox read-only/);
    assert.match(output, /which codex/);
  });

  it('codex provider does not mention api.anthropic.com', () => {
    const output = captureOutput(() => printTroubleshooting(codexFailed, 'codex'));
    assert.doesNotMatch(output, /api\.anthropic\.com/);
  });

  it('codex provider does not show claude -p guidance', () => {
    const output = captureOutput(() => printTroubleshooting(codexFailed, 'codex'));
    assert.doesNotMatch(output, /claude -p/);
  });

  it('claude provider shows Claude install/auth/test/PATH guidance', () => {
    const output = captureOutput(() => printTroubleshooting(claudeFailed, 'claude'));
    assert.match(output, /@anthropic-ai\/claude-cli/);
    assert.match(output, /claude login/);
    assert.match(output, /claude -p/);
    assert.match(output, /which claude/);
  });

  it('claude provider includes Anthropic network guidance on network failure', () => {
    const output = captureOutput(() => printTroubleshooting(claudeFailed, 'claude'));
    assert.match(output, /api\.anthropic\.com/);
  });

  it('prints nothing when all checks pass', () => {
    const allPassed = [
      { name: 'Git', passed: true, message: 'ok' },
      { name: 'Git Repository', passed: true, message: 'ok' },
      { name: 'Codex CLI', passed: true, message: 'ok' },
    ];
    const output = captureOutput(() => printTroubleshooting(allPassed, 'codex'));
    assert.equal(output.trim(), '');
  });

  it('shows git guidance regardless of provider when git fails', () => {
    const gitFailed = [
      { name: 'Git', passed: false, message: 'not found' },
      { name: 'Git Repository', passed: true, message: 'ok' },
      { name: 'Codex CLI', passed: true, message: 'ok' },
    ];
    const output = captureOutput(() => printTroubleshooting(gitFailed, 'codex'));
    assert.match(output, /git-scm\.com/);
  });
});
