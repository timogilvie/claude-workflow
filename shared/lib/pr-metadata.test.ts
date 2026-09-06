import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractMetadataBlock,
  parsePrMetadata,
  renderPrMetadata,
  updatePrMetadata,
  validatePrMetadata,
  type PrMetadata,
} from './pr-metadata.ts';

describe('extractMetadataBlock', () => {
  it('returns the original body when no block is present', () => {
    const body = '## Summary\n\nPlain PR body.';
    assert.deepEqual(extractMetadataBlock(body), {
      block: null,
      bodyWithoutBlock: body,
    });
  });

  it('uses the last metadata block and removes all metadata blocks from the body', () => {
    const body = [
      'Before',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
      '',
      'Middle',
      '',
      '<!-- wavemill-meta',
      'task: HOK-2',
      '-->',
      '',
      'After',
    ].join('\n');

    assert.deepEqual(extractMetadataBlock(body), {
      block: 'task: HOK-2',
      bodyWithoutBlock: ['Before', '', 'Middle', '', 'After'].join('\n'),
    });
  });
});

describe('parsePrMetadata', () => {
  it('returns empty metadata for bodies without a metadata block', () => {
    for (const body of ['', '   ', '## Summary\n\nNo hidden metadata here.']) {
      assert.deepEqual(parsePrMetadata(body), {
        ok: true,
        metadata: {},
        bodyWithoutBlock: body,
      });
    }
  });

  it('round-trips all supported fields', () => {
    const metadata: PrMetadata = {
      task: 'HOK-1432',
      stack: 'integration',
      depends_on: ['HOK-1431'],
      depends_on_linear: ['LIN-42'],
      requires: ['ci-green', 'approval'],
      risk: 'medium',
      challenge: false,
      challengePairId: 'pair-1',
    };

    const parsed = parsePrMetadata(renderPrMetadata(metadata));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, metadata);
    assert.equal(parsed.bodyWithoutBlock, '');
  });

  it('preserves non-metadata PR body content', () => {
    const body = [
      '# Title',
      '',
      'Summary paragraph.',
      '',
      '<!-- keep-me -->',
      '',
      '```ts',
      'console.log("hello");',
      '```',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1432',
      'risk: low',
      '-->',
    ].join('\n');

    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, { task: 'HOK-1432', risk: 'low' });
    assert.equal(
      parsed.bodyWithoutBlock,
      [
        '# Title',
        '',
        'Summary paragraph.',
        '',
        '<!-- keep-me -->',
        '',
        '```ts',
        'console.log("hello");',
        '```',
      ].join('\n'),
    );
  });

  it('reports invalid metadata clearly without throwing', () => {
    const body = [
      '<!-- wavemill-meta',
      'task:   ',
      'depends_on: not-json',
      'depends_on_linear: [1]',
      'requires: ["ok", 2]',
      'risk: severe',
      'challenge: maybe',
      'extra: surprise',
      'bad line',
      '-->',
    ].join('\n');

    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.errors, [
      {
        field: 'task',
        code: 'empty-string',
        message: 'Expected non-empty string for task',
      },
      {
        field: 'depends_on',
        code: 'invalid-json',
        message: 'Invalid JSON for depends_on',
      },
      {
        field: 'depends_on_linear',
        code: 'wrong-type',
        message: 'Expected JSON string array for depends_on_linear',
      },
      {
        field: 'requires',
        code: 'wrong-type',
        message: 'Expected JSON string array for requires',
      },
      {
        field: 'risk',
        code: 'invalid-enum',
        message: 'Expected one of low, medium, high for risk',
      },
      {
        field: 'challenge',
        code: 'invalid-boolean',
        message: 'Expected boolean true/false for challenge',
      },
      {
        field: 'extra',
        code: 'unknown-field',
        message: 'Unknown wavemill-meta field: extra',
      },
      {
        field: 'line',
        code: 'malformed-line',
        message: 'Malformed wavemill-meta line',
      },
    ]);
    assert.equal(parsed.bodyWithoutBlock, '');
  });

  it('parses the last metadata block when multiple exist', () => {
    const body = [
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
      '',
      'Summary',
      '',
      '<!-- wavemill-meta',
      'task: HOK-2',
      'challenge: true',
      '-->',
    ].join('\n');

    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, { task: 'HOK-2', challenge: true });
    assert.equal(parsed.bodyWithoutBlock, 'Summary');
  });
});

describe('validatePrMetadata', () => {
  it('distinguishes absent, valid, and invalid metadata blocks', () => {
    assert.deepEqual(validatePrMetadata('No metadata.'), {
      status: 'absent',
      bodyWithoutBlock: 'No metadata.',
    });

    assert.deepEqual(validatePrMetadata(['<!-- wavemill-meta', 'task: HOK-1432', '-->'].join('\n')), {
      status: 'valid',
      metadata: { task: 'HOK-1432' },
      bodyWithoutBlock: '',
    });

    assert.deepEqual(validatePrMetadata([
      '<!-- wavemill-meta',
      'task: HOK-2929',
      'review-infrastructure-note: native-context-window-exceeded',
      '-->',
    ].join('\n')), {
      status: 'invalid',
      errors: [{
        field: 'review-infrastructure-note',
        code: 'unknown-field',
        message: 'Unknown wavemill-meta field: review-infrastructure-note',
      }],
      bodyWithoutBlock: '',
    });
  });

  it('reports malformed, wrong-type, and future-version fields without raw values', () => {
    const parsed = validatePrMetadata([
      '<!-- wavemill-meta',
      'depends_on: [1]',
      'wm-schema-version: 999',
      'bad line with secret-value',
      '-->',
    ].join('\n'));

    assert.equal(parsed.status, 'invalid');
    if (parsed.status !== 'invalid') {
      return;
    }

    assert.deepEqual(parsed.errors, [
      {
        field: 'depends_on',
        code: 'wrong-type',
        message: 'Expected JSON string array for depends_on',
      },
      {
        field: 'wm-schema-version',
        code: 'unknown-field',
        message: 'Unknown wavemill-meta field: wm-schema-version',
      },
      {
        field: 'line',
        code: 'malformed-line',
        message: 'Malformed wavemill-meta line',
      },
    ]);
    assert.equal(JSON.stringify(parsed.errors).includes('secret-value'), false);
  });
});

describe('renderPrMetadata', () => {
  it('renders fields in deterministic order', () => {
    const rendered = renderPrMetadata({
      challenge: true,
      challengePairId: 'pair-9',
      risk: 'high',
      requires: ['qa'],
      task: 'HOK-1432',
      depends_on_linear: ['LIN-9'],
      stack: 'integration',
      depends_on: ['HOK-1431'],
    });

    assert.equal(
      rendered,
      [
        '<!-- wavemill-meta',
        'task: HOK-1432',
        'stack: integration',
        'depends_on: ["HOK-1431"]',
        'depends_on_linear: ["LIN-9"]',
        'requires: ["qa"]',
        'risk: high',
        'challenge: true',
        'challengePairId: pair-9',
        '-->',
      ].join('\n'),
    );
  });

  it('renders an empty block when no fields are set', () => {
    assert.equal(renderPrMetadata({}), '<!-- wavemill-meta\n\n-->');
  });

  it('rejects unregistered producer fields', () => {
    assert.throws(
      () => renderPrMetadata({ task: 'HOK-1432', reviewNote: 'nope' } as unknown as PrMetadata),
      /Unknown wavemill-meta field: reviewNote/,
    );
  });
});

describe('updatePrMetadata', () => {
  it('is idempotent across representative bodies', () => {
    const metadata: PrMetadata = {
      task: 'HOK-1432',
      depends_on: ['HOK-1431'],
      risk: 'medium',
      challenge: false,
    };

    for (const body of [
      '',
      '   ',
      'Summary',
      'Summary\n',
      ['# Title', '', 'Body', '', '<!-- wavemill-meta', 'task: OLD', '-->'].join('\n'),
    ]) {
      const once = updatePrMetadata(body, metadata);
      const twice = updatePrMetadata(once, metadata);
      assert.equal(twice, once);
    }
  });

  it('appends the rendered block after preserved body content', () => {
    const body = [
      '# Summary',
      '',
      '- [x] tests',
      '',
      '<!-- keep -->',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
    ].join('\n');

    assert.equal(
      updatePrMetadata(body, { task: 'HOK-1432', stack: 'integration' }),
      [
        '# Summary',
        '',
        '- [x] tests',
        '',
        '<!-- keep -->',
        '',
        '<!-- wavemill-meta',
        'task: HOK-1432',
        'stack: integration',
        '-->',
      ].join('\n'),
    );
  });

  it('returns only the metadata block for empty bodies', () => {
    assert.equal(
      updatePrMetadata('', { task: 'HOK-1432' }),
      ['<!-- wavemill-meta', 'task: HOK-1432', '-->'].join('\n'),
    );
  });

  it('removes duplicate metadata blocks without normalizing surrounding markdown', () => {
    const body = [
      'Intro',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
      '',
      'More',
      '',
      '<!-- wavemill-meta',
      'task: HOK-2',
      '-->',
    ].join('\n');

    assert.equal(
      updatePrMetadata(body, { task: 'HOK-1432' }),
      ['Intro', '', '', '', 'More', '', '<!-- wavemill-meta', 'task: HOK-1432', '-->'].join('\n'),
    );
  });

  it('preserves non-managed PR body bytes when replacing metadata', () => {
    const body = [
      '# Title',
      '',
      'Body with two spaces.  ',
      '',
      '<!-- wavemill-meta',
      'task: OLD',
      '-->',
      '',
      'Trailing section.',
      '',
    ].join('\n');

    assert.equal(
      updatePrMetadata(body, { task: 'HOK-1432' }),
      [
        '# Title',
        '',
        'Body with two spaces.  ',
        '',
        '<!-- wavemill-meta',
        'task: HOK-1432',
        '-->',
        '',
        'Trailing section.',
        '',
      ].join('\n'),
    );
  });
});
