import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
} from './arm-failure-taxonomy.ts';

test('classifies the incident failure kinds into the intended fault classes', () => {
  assert.equal(classifyArmFault({
    failureKind: 'context-window-exceeded',
    detail: "400 maximum context length is 131072 tokens; you requested about 131182",
  }), 'harness-fault');

  assert.equal(classifyArmFault({
    failureKind: 'tool-use-unsupported',
    detail: '404 No endpoints found that support tool use',
  }), 'selection-fault');

  assert.equal(classifyArmFault({
    failureKind: 'native-provider-error',
    detail: 'Stream ended without finish_reason',
  }), 'model-fault');
});

test('classifies provider and ambiguous failures conservatively', () => {
  assert.equal(classifyArmFault({ failureKind: 'provider-rate-limited' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'provider-quota-exhausted' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'native-provider-error', detail: '502 Bad Gateway' }), 'provider-fault');
  assert.equal(classifyArmFault({ failureKind: 'native-provider-error', detail: 'something else' }), 'unknown-fault');
  assert.equal(classifyArmFault({ failureKind: 'invalid-model-id' }), 'harness-fault');
});

test('parses abort failure kinds and quality eligibility', () => {
  assert.equal(parseAbortFailureKind('terminal_stage_failure:tool-use-unsupported'), 'tool-use-unsupported');
  assert.equal(parseAbortFailureKind('terminal_launch_failure:context-window-exceeded'), 'context-window-exceeded');
  assert.equal(parseAbortFailureKind('varied_model_unresolvable'), 'varied_model_unresolvable');
  assert.equal(parseAbortFailureKind('other'), null);

  assert.equal(isModelQualitySignal('model-fault'), true);
  assert.equal(isModelQualitySignal('provider-fault'), true);
  assert.equal(isModelQualitySignal('harness-fault'), false);
  assert.equal(isModelQualitySignal('selection-fault'), false);
  assert.equal(isModelQualitySignal('unknown-fault'), false);
});
