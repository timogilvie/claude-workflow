import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fallbackLog, roleForTaskType, routerLog } from './router-log.ts';

function captureStderr(fn: () => void): string {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  try {
    fn();
    return output;
  } finally {
    process.stderr.write = originalWrite;
  }
}

afterEach(() => {
  delete process.env.DASHBOARD_VERBOSITY;
  delete process.env.WAVEMILL_LOG_LEVEL;
});

describe('router-log', () => {
  it('writes router messages to stderr with the router tag', () => {
    const output = captureStderr(() => {
      routerLog('constrained mode: claude-opus-4-7 quota is degrading');
    });

    assert.equal(output, '[router] constrained mode: claude-opus-4-7 quota is degrading\n');
  });

  it('formats fallback messages with a role tag', () => {
    const output = captureStderr(() => {
      fallbackLog({
        taskType: 'coding',
        failedModel: 'claude-opus-4-7',
        nextModel: 'claude-sonnet-4-6',
        reason: 'quota',
      });
    });

    assert.equal(
      output,
      '[coder] claude-opus-4-7 unavailable (quota); falling back to claude-sonnet-4-6\n',
    );
  });

  it('formats terminal fallback messages with the attempted chain', () => {
    const output = captureStderr(() => {
      fallbackLog({
        taskType: 'review',
        failedModel: 'claude-sonnet-4-6',
        nextModel: null,
        reason: 'quota',
        exhaustedChain: ['claude-opus-4-7', 'claude-sonnet-4-6'],
      });
    });

    assert.equal(
      output,
      '[reviewer] claude-sonnet-4-6 unavailable (quota); no remaining fallback candidates after: claude-opus-4-7 -> claude-sonnet-4-6\n',
    );
  });

  it('maps all registry task types to operator-facing role tags', () => {
    assert.equal(roleForTaskType('routing'), 'router');
    assert.equal(roleForTaskType('planning'), 'planner');
    assert.equal(roleForTaskType('coding'), 'coder');
    assert.equal(roleForTaskType('review'), 'reviewer');
    assert.equal(roleForTaskType('classify'), 'classifier');
    assert.equal(roleForTaskType(undefined), 'router');
  });

  it('respects DASHBOARD_VERBOSITY gating', () => {
    process.env.DASHBOARD_VERBOSITY = 'error';

    const output = captureStderr(() => {
      routerLog('hidden info line');
      routerLog('visible error line', 'error');
    });

    assert.equal(output, '[router] visible error line\n');
  });

  it('falls back to WAVEMILL_LOG_LEVEL when dashboard verbosity is unset', () => {
    process.env.WAVEMILL_LOG_LEVEL = 'status';

    const output = captureStderr(() => {
      routerLog('hidden info line');
      fallbackLog({
        taskType: 'classify',
        failedModel: 'model-a',
        nextModel: null,
        reason: 'quota',
        exhaustedChain: ['model-a'],
        level: 'status',
      });
    });

    assert.equal(
      output,
      '[classifier] model-a unavailable (quota); no remaining fallback candidates after: model-a\n',
    );
  });
});
