import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startHeartbeat } from './progress-heartbeat.ts';

function createMockStream(isTTY: boolean): { lines: string[]; stream: NodeJS.WriteStream } {
  const lines: string[] = [];

  return {
    lines,
    stream: {
      isTTY,
      write(chunk: string, callback?: (error?: Error | null) => void) {
        lines.push(chunk);
        callback?.(null);
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
}

describe('progress-heartbeat', () => {
  it('writes the initial message immediately', () => {
    const { lines, stream } = createMockStream(false);

    const stopHeartbeat = startHeartbeat({
      label: 'plan-decomposer',
      stream,
      initialMessage: 'This typically takes 1-3 minutes.',
      intervalMs: 10,
    });
    stopHeartbeat();

    assert.equal(lines[0], 'This typically takes 1-3 minutes.\n');
  });

  it('emits ticks on the configured interval', async () => {
    const { lines, stream } = createMockStream(false);

    const stopHeartbeat = startHeartbeat({
      label: 'plan-decomposer',
      stream,
      intervalMs: 10,
    });

    await delay(25);
    stopHeartbeat();

    assert.ok(lines.some((line) => line.includes('elapsed')));
  });

  it('formats tty ticks using carriage returns', async () => {
    const { lines, stream } = createMockStream(true);

    const stopHeartbeat = startHeartbeat({
      label: 'plan-decomposer',
      stream,
      intervalMs: 10,
    });

    await delay(15);
    stopHeartbeat();

    assert.match(lines[0], /^\r⏳ Still working\.\.\. \(\d+s elapsed\)  $/);
    assert.equal(lines.at(-1), '\n');
  });

  it('formats non-tty ticks with timestamps and newlines', async () => {
    const { lines, stream } = createMockStream(false);

    const stopHeartbeat = startHeartbeat({
      label: 'plan-decomposer',
      stream,
      intervalMs: 10,
    });

    await delay(15);
    stopHeartbeat();

    assert.match(lines[0], /^\d{2}:\d{2}:\d{2} ⏳ Still working\.\.\. \(\d+s elapsed\)\n$/);
  });

  it('allows stop to be called multiple times', () => {
    const { stream } = createMockStream(false);

    const stopHeartbeat = startHeartbeat({
      label: 'plan-decomposer',
      stream,
      intervalMs: 10,
    });

    stopHeartbeat();
    stopHeartbeat();
  });

  it('throws when intervalMs is zero or negative', () => {
    assert.throws(
      () => startHeartbeat({ label: 'plan-decomposer', intervalMs: 0 }),
      RangeError
    );
    assert.throws(
      () => startHeartbeat({ label: 'plan-decomposer', intervalMs: -1 }),
      RangeError
    );
  });

  it('does not write an initial message when omitted', async () => {
    const { lines, stream } = createMockStream(false);

    const stopHeartbeat = startHeartbeat({
      label: 'plan-decomposer',
      stream,
      intervalMs: 10,
    });

    assert.equal(lines.length, 0);
    await delay(15);
    stopHeartbeat();

    assert.ok(lines.every((line) => line.includes('Still working...')));
  });
});
