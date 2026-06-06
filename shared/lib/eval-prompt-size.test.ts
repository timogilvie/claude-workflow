import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvalPromptSizeEnv,
  enforcePromptSizeLimit,
  measurePromptComponents,
  resolveEvalPromptSizeConfig,
} from './eval-prompt-size.ts';

describe('eval prompt size enforcement', () => {
  it('counts UTF-8 bytes instead of JavaScript characters', () => {
    const measured = measurePromptComponents({
      taskPrompt: 'abc',
      prReviewOutput: '漢字🙂',
    });

    assert.equal('漢字🙂'.length, 4);
    assert.equal(measured.perComponentBytes.prReviewOutput, Buffer.byteLength('漢字🙂', 'utf8'));
    assert.equal(measured.totalBytes, 3 + Buffer.byteLength('漢字🙂', 'utf8'));
  });

  it('returns zero totals for an empty component map', () => {
    const measured = measurePromptComponents({});

    assert.equal(measured.totalBytes, 0);
    assert.equal(measured.perComponentBytes.taskPrompt, 0);
    assert.equal(measured.perComponentBytes.templateScaffold, 0);
  });

  it('passes when total bytes exactly equal the limit', () => {
    const result = enforcePromptSizeLimit({
      components: { taskPrompt: 'x'.repeat(1024) },
      limitBytes: 1024,
      policy: 'fail',
    });

    assert.equal(result.action, 'pass');
    assert.equal(result.diagnostic.totalBytes, 1024);
  });

  it('rejects over-limit prompts without mutating components when policy is fail', () => {
    const components = { taskPrompt: 'a'.repeat(600), prReviewOutput: 'b'.repeat(500) };
    const result = enforcePromptSizeLimit({
      components,
      limitBytes: 1024,
      policy: 'fail',
    });

    assert.equal(result.action, 'rejected');
    assert.equal(result.components, components);
    assert.deepEqual(result.components, components);
    assert.equal(result.diagnostic.action, 'rejected');
  });

  it('truncates the first eligible large component until the prompt fits', () => {
    const result = enforcePromptSizeLimit({
      components: {
        taskPrompt: 'small',
        prReviewOutput: 'x'.repeat(1400),
        taskPacket: 'y'.repeat(100),
      },
      limitBytes: 1024,
      policy: 'truncate',
    });

    assert.equal(result.action, 'truncated');
    assert.ok(result.diagnostic.totalBytes <= 1024);
    assert.match(result.components.prReviewOutput ?? '', /TRUNCATED \d+ bytes from prReviewOutput/);
    assert.equal(result.diagnostic.truncatedComponents?.[0]?.name, 'prReviewOutput');
  });

  it('includes truncation marker bytes in the final measurement', () => {
    const result = enforcePromptSizeLimit({
      components: { prReviewOutput: 'x'.repeat(1200) },
      limitBytes: 1024,
      policy: 'truncate',
    });

    assert.equal(result.action, 'truncated');
    assert.equal(result.diagnostic.totalBytes, Buffer.byteLength(result.components.prReviewOutput ?? '', 'utf8'));
    assert.ok((result.components.prReviewOutput ?? '').includes('TRUNCATED'));
  });

  it('rejects when non-truncatable scaffold overhead alone exceeds the limit', () => {
    const result = enforcePromptSizeLimit({
      components: {
        templateScaffold: 's'.repeat(1200),
        prReviewOutput: 'x'.repeat(10),
      },
      limitBytes: 1024,
      policy: 'truncate',
    });

    assert.equal(result.action, 'rejected');
    assert.equal(result.diagnostic.action, 'rejected');
    assert.ok(result.diagnostic.totalBytes > 1024);
  });

  it('throws clear errors for invalid prompt size config', () => {
    assert.throws(
      () => resolveEvalPromptSizeConfig({ maxPromptBytes: 100 }),
      /Invalid eval\.maxPromptBytes/,
    );
    assert.throws(
      () => resolveEvalPromptSizeConfig({ oversizePolicy: 'compress' }),
      /Invalid eval\.oversizePolicy/,
    );
  });

  it('applies environment overrides before resolving prompt size config', () => {
    const config = applyEvalPromptSizeEnv(
      { maxPromptBytes: 9000, oversizePolicy: 'fail' },
      { EVAL_MAX_PROMPT_BYTES: '2048', EVAL_OVERSIZE_POLICY: 'truncate' },
    );

    assert.deepEqual(resolveEvalPromptSizeConfig(config), {
      limitBytes: 2048,
      policy: 'truncate',
    });
  });
});
