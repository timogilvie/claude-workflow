import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  byteLengthUtf8,
  checkPromptSize,
  measurePromptComponents,
  truncatePromptComponents,
  type PromptComponentId,
} from './eval-prompt-size.ts';

function makeComponents(
  overrides: Partial<Record<PromptComponentId, string>> = {},
): Record<PromptComponentId, string> {
  return {
    task_prompt: 'task',
    pr_review_output: 'review',
    intervention_metadata: 'interventions',
    task_packet: 'packet',
    plan_content: 'plan',
    self_review_summary: 'summary',
    template_static: 'static',
    ...overrides,
  };
}

describe('eval-prompt-size', () => {
  it('measures UTF-8 byte size for ASCII and multibyte text', () => {
    assert.equal(byteLengthUtf8('abc'), 3);
    assert.equal(byteLengthUtf8('é'), 2);
    assert.equal(byteLengthUtf8('🙂'), 4);
  });

  it('measures all prompt components and totals them', () => {
    const measurement = measurePromptComponents(
      makeComponents({
        task_prompt: 'abcd',
        pr_review_output: 'xy',
      }),
    );

    assert.equal(measurement.componentBytes.task_prompt, 4);
    assert.equal(measurement.componentBytes.pr_review_output, 2);
    assert.equal(
      measurement.totalBytes,
      Object.values(measurement.componentBytes).reduce((sum, value) => sum + value, 0),
    );
  });

  it('returns unchanged components when under the soft limit', () => {
    const components = makeComponents({
      pr_review_output: 'small review',
    });

    const result = truncatePromptComponents(components, {
      softLimitBytes: 1024,
      perComponentMaxBytes: 256,
    });

    assert.deepEqual(result.components, components);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.truncationSummary, {});
  });

  it('truncates the largest component first and includes a marker', () => {
    const components = makeComponents({
      pr_review_output: 'A'.repeat(200),
      task_packet: 'B'.repeat(80),
    });

    const result = truncatePromptComponents(components, {
      softLimitBytes: 180,
      perComponentMaxBytes: 90,
    });

    assert.equal(result.truncated, true);
    assert.match(
      result.components.pr_review_output,
      /\[TRUNCATED: \d+ bytes omitted from pr_review_output\]/,
    );
    assert.equal(result.components.task_packet, 'B'.repeat(80));
    assert.ok(result.measurement.totalBytes <= 180);
    assert.ok((result.truncationSummary.pr_review_output ?? 0) > 0);
  });

  it('never truncates template_static content', () => {
    const components = makeComponents({
      template_static: 'S'.repeat(300),
      pr_review_output: 'R'.repeat(200),
    });

    const result = truncatePromptComponents(components, {
      softLimitBytes: 420,
      perComponentMaxBytes: 80,
    });

    assert.equal(result.components.template_static, components.template_static);
    assert.ok(result.components.pr_review_output.includes('[TRUNCATED:'));
  });

  it('treats the hard limit boundary as inclusive', () => {
    assert.equal(checkPromptSize(100, 100), 'ok');
    assert.equal(checkPromptSize(101, 100), 'over_hard_limit');
  });
});
