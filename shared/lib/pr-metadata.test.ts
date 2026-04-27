import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractMetadataBlock,
  parsePrMetadata,
  renderPrMetadata,
  updatePrMetadata,
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
        message: 'Expected non-empty string for task',
        rawValue: '',
      },
      {
        field: 'depends_on',
        message: 'Invalid JSON for depends_on',
        rawValue: 'not-json',
      },
      {
        field: 'depends_on_linear',
        message: 'Expected JSON string array for depends_on_linear',
        rawValue: '[1]',
      },
      {
        field: 'requires',
        message: 'Expected JSON string array for requires',
        rawValue: '["ok", 2]',
      },
      {
        field: 'risk',
        message: 'Expected one of low, medium, high for risk',
        rawValue: 'severe',
      },
      {
        field: 'challenge',
        message: 'Expected boolean true/false for challenge',
        rawValue: 'maybe',
      },
      {
        field: 'extra',
        message: 'Unknown wavemill-meta field: extra',
        rawValue: 'surprise',
      },
      {
        field: 'bad line',
        message: 'Malformed wavemill-meta line: bad line',
        rawValue: 'bad line',
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

describe('renderPrMetadata', () => {
  it('renders fields in deterministic order', () => {
    const rendered = renderPrMetadata({
      challenge: true,
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
        '-->',
      ].join('\n'),
    );
  });

  it('renders an empty block when no fields are set', () => {
    assert.equal(renderPrMetadata({}), '<!-- wavemill-meta\n-->');
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

  it('collapses multiple metadata blocks to one on update', () => {
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
      ['Intro', '', 'More', '', '<!-- wavemill-meta', 'task: HOK-1432', '-->'].join('\n'),
    );
  });
});
