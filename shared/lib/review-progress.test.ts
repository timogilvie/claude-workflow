import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewProgressReporter } from './review-progress.ts';

function createMockStream() {
  const lines: string[] = [];

  return {
    lines,
    stream: {
      write(chunk: string, callback?: (error?: Error | null) => void) {
        lines.push(chunk);
        callback?.(null);
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
}

describe('review-progress', () => {
  it('formats text progress events for stderr output', async () => {
    const { lines, stream } = createMockStream();
    const reporter = createReviewProgressReporter({ format: 'text', stream });

    await reporter.emit({
      event: 'llm_call_slow',
      message: 'Claude call is still running',
      level: 'warn',
      attempt: 1,
      maxAttempts: 2,
      provider: 'claude',
      model: 'claude-sonnet',
      elapsedMs: 31_000,
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[review\] WARN Claude call is still running/);
    assert.match(lines[0], /attempt=1\/2/);
    assert.match(lines[0], /provider=claude/);
    assert.match(lines[0], /elapsed=31.0s/);
  });

  it('formats structured events as newline-delimited json', async () => {
    const { lines, stream } = createMockStream();
    const reporter = createReviewProgressReporter({ format: 'json', stream });

    await reporter.emit({
      event: 'preflight_ok',
      message: 'Claude CLI is available',
      details: { command: 'claude' },
    });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'preflight_ok');
    assert.equal(parsed.message, 'Claude CLI is available');
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.details.command, 'claude');
    assert.ok(parsed.timestamp);
  });
});
