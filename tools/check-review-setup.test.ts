import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { printTroubleshooting, type CheckResult } from './check-review-setup.ts';

function captureTroubleshooting(results: CheckResult[]): string {
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });

  try {
    printTroubleshooting(results);
  } finally {
    log.mock.restore();
  }

  return lines.join('\n');
}

describe('check-review-setup troubleshooting', () => {
  it('prints Codex readiness guidance when the Codex CLI check fails', () => {
    const output = captureTroubleshooting([
      { name: 'Codex CLI', passed: false, message: 'not found' },
    ]);

    assert.match(output, /Codex CLI is not available:/);
    assert.match(output, /brew install codex \(or npm install -g @openai\/codex\)/);
    assert.match(output, /codex login/);
    assert.match(output, /echo "hello" \| codex exec --json --sandbox read-only/);
    assert.match(output, /which codex/);
    assert.doesNotMatch(output, /Claude CLI is not available:/);
  });

  it('prints Claude guidance independently from Codex guidance', () => {
    const output = captureTroubleshooting([
      { name: 'Claude CLI', passed: false, message: 'not found' },
    ]);

    assert.match(output, /Claude CLI is not available:/);
    assert.match(output, /npm install -g @anthropic-ai\/claude-cli/);
    assert.match(output, /claude login/);
    assert.match(output, /echo "hello" \| claude -p --model claude-haiku-4-5-20251001/);
    assert.match(output, /which claude/);
    assert.doesNotMatch(output, /Codex CLI is not available:/);
  });

  it('keeps Anthropic network troubleshooting separate from Codex auth', () => {
    const output = captureTroubleshooting([
      { name: 'Anthropic API Connectivity', passed: false, message: 'HTTP 000' },
    ]);

    assert.match(output, /Anthropic API connectivity issues:/);
    assert.match(output, /curl -I https:\/\/api\.anthropic\.com/);
    assert.match(output, /https:\/\/status\.anthropic\.com/);
    assert.doesNotMatch(output, /codex login/);
  });
});
