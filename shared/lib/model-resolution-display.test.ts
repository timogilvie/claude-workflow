import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatAllSubagentModelDisplayText,
  formatSubagentModelDisplayText,
  formatSubagentModelResolution,
} from './model-resolution-display.ts';

test('formats alias selectors without fallback', () => {
  const display = formatSubagentModelResolution({
    role: 'planner',
    requested: 'opus',
    resolved: 'claude-opus-4-7',
  });

  assert.deepEqual(display, {
    role: 'planner',
    requested: 'opus',
    resolved: 'claude-opus-4-7',
    hasFallback: false,
    fallback: undefined,
    fallbackReason: undefined,
    inheritedFrom: undefined,
    channel: undefined,
  });
  assert.equal(
    formatSubagentModelDisplayText(display),
    'planner: requested=opus → resolved=claude-opus-4-7',
  );
});

test('formats pinned selectors from requestedSelector', () => {
  const display = formatSubagentModelResolution({
    role: 'coder',
    requestedSelector: { kind: 'pinned', modelId: 'gpt-5.5' },
    resolvedModelId: 'gpt-5.5',
  });

  assert.equal(display.requested, 'gpt-5.5');
  assert.equal(display.resolved, 'gpt-5.5');
  assert.equal(display.hasFallback, false);
});

test('formats inherit selectors with parent context', () => {
  const display = formatSubagentModelResolution({
    role: 'reviewer',
    requested: 'inherit',
    resolved: 'claude-opus-4-7',
    inheritedFrom: 'planner',
  });

  assert.equal(display.inheritedFrom, 'planner');
  assert.equal(
    formatSubagentModelDisplayText(display),
    'reviewer: requested=inherit (from planner) → resolved=claude-opus-4-7',
  );
});

test('formats inherit selectors without parent context as unknown', () => {
  const text = formatSubagentModelDisplayText(formatSubagentModelResolution({
    role: 'reviewer',
    requestedSelector: { kind: 'inherit' },
    resolvedModelId: 'claude-opus-4-7',
  }));

  assert.equal(text, 'reviewer: requested=inherit (from unknown) → resolved=claude-opus-4-7');
});

test('formats quota fallback as a second line', () => {
  const text = formatSubagentModelDisplayText(formatSubagentModelResolution({
    role: 'planner',
    requested: 'opus',
    resolved: 'claude-opus-4-7',
    fallback: 'claude-sonnet-4-6',
    fallbackReason: 'quota-exhausted',
  }));

  assert.equal(
    text,
    'planner: requested=opus → resolved=claude-opus-4-7\n'
      + '         fallback=claude-sonnet-4-6 (reason: quota-exhausted)',
  );
});

test('formats disabled-by-policy fallback reason verbatim', () => {
  const display = formatSubagentModelResolution({
    role: 'planner',
    requested: 'opus',
    resolved: 'claude-opus-4-7',
    fallback: 'claude-sonnet-4-6',
    fallbackReason: 'disabled-by-policy',
  });

  assert.equal(display.fallbackReason, 'disabled-by-policy');
  assert.equal(display.hasFallback, true);
});

test('fills in unspecified fallback reason when missing', () => {
  const text = formatSubagentModelDisplayText(formatSubagentModelResolution({
    role: 'planner',
    requested: 'opus',
    resolved: 'claude-opus-4-7',
    fallback: 'claude-sonnet-4-6',
  }));

  assert.match(text, /reason: unspecified/);
});

test('shows non-stable channels from explicit channel metadata', () => {
  const text = formatSubagentModelDisplayText(formatSubagentModelResolution({
    role: 'planner',
    requested: 'opus',
    resolved: 'claude-opus-4-7-preview',
    channel: 'preview',
  }));

  assert.equal(
    text,
    'planner: requested=opus [channel=preview] → resolved=claude-opus-4-7-preview',
  );
});

test('omits stable channel metadata', () => {
  const text = formatSubagentModelDisplayText(formatSubagentModelResolution({
    role: 'planner',
    requestedSelector: { kind: 'alias', family: 'opus', channel: 'stable' },
    resolvedModelId: 'claude-opus-4-7',
  }));

  assert.equal(text, 'planner: requested=opus → resolved=claude-opus-4-7');
});

test('marks null records unavailable', () => {
  assert.equal(
    formatSubagentModelDisplayText(formatSubagentModelResolution(null)),
    'subagent: model resolution unavailable',
  );
});

test('marks empty objects unavailable', () => {
  assert.equal(
    formatSubagentModelDisplayText(formatSubagentModelResolution({ role: 'coder' })),
    'coder: model resolution unavailable',
  );
});

test('marks missing resolved values unavailable', () => {
  assert.equal(
    formatSubagentModelDisplayText(formatSubagentModelResolution({
      role: 'coder',
      requested: 'opus',
    })),
    'coder: model resolution unavailable',
  );
});

test('marks non-object records unavailable', () => {
  assert.equal(
    formatSubagentModelDisplayText(formatSubagentModelResolution('opus')),
    'subagent: model resolution unavailable',
  );
});

test('formats empty record arrays as empty text', () => {
  assert.equal(formatAllSubagentModelDisplayText([]), '');
});

test('echoes provided resolved ids without re-resolving', () => {
  const text = formatSubagentModelDisplayText(formatSubagentModelResolution({
    role: 'planner',
    requestedSelector: { kind: 'alias', family: 'opus' },
    resolvedModelId: 'claude-haiku-4-5',
    fallbackReason: 'quota-exhausted',
  }));

  assert.equal(
    text,
    'planner: requested=opus → resolved=claude-haiku-4-5\n'
      + '         fallback=claude-haiku-4-5 (reason: quota-exhausted)',
  );
});
