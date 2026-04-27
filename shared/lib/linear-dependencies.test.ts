import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderPrMetadata } from './pr-metadata.ts';
import { resolveDependencies } from './linear-dependencies.ts';
import type { LinearRelation } from './linear.ts';

function inverseBlock(identifier: string, overrides: Partial<NonNullable<LinearRelation['issue']>> = {}): LinearRelation {
  return {
    type: 'blocks',
    issue: {
      id: `${identifier}-id`,
      identifier,
      completedAt: null,
      canceledAt: null,
      ...overrides,
    },
  };
}

describe('resolveDependencies', () => {
  it('returns empty dependency arrays for issues without blockers', () => {
    assert.deepEqual(
      resolveDependencies({
        resolvePrForIssue: () => null,
      }),
      { depends_on: [], depends_on_linear: [] },
    );
  });

  it('maps unresolved blockers without matching PRs to depends_on_linear', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: { nodes: [inverseBlock('HOK-1000')] },
        resolvePrForIssue: () => null,
      }),
      { depends_on: [], depends_on_linear: ['HOK-1000'] },
    );
  });

  it('ignores completed blockers', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: {
          nodes: [inverseBlock('HOK-1000', { completedAt: '2024-01-01T00:00:00Z' })],
        },
        resolvePrForIssue: () => null,
      }),
      { depends_on: [], depends_on_linear: [] },
    );
  });

  it('ignores canceled blockers', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: {
          nodes: [inverseBlock('HOK-1000', { canceledAt: '2024-01-01T00:00:00Z' })],
        },
        resolvePrForIssue: () => null,
      }),
      { depends_on: [], depends_on_linear: [] },
    );
  });

  it('resolves matching PRs into depends_on', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: { nodes: [inverseBlock('HOK-1432')] },
        resolvePrForIssue: (identifier) => (identifier === 'HOK-1432' ? 400 : null),
      }),
      { depends_on: ['PR#400'], depends_on_linear: [] },
    );
  });

  it('supports mixed PR-backed and linear-only blockers', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: { nodes: [inverseBlock('HOK-1432'), inverseBlock('HOK-1500')] },
        resolvePrForIssue: (identifier) => (identifier === 'HOK-1432' ? 400 : null),
      }),
      { depends_on: ['PR#400'], depends_on_linear: ['HOK-1500'] },
    );
  });

  it('deduplicates repeated blockers', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: { nodes: [inverseBlock('HOK-1432'), inverseBlock('HOK-1432')] },
        resolvePrForIssue: () => null,
      }),
      { depends_on: [], depends_on_linear: ['HOK-1432'] },
    );
  });

  it('ignores non-blocking relation types', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: {
          nodes: [{ type: 'related', issue: { id: '1', identifier: 'HOK-1432', completedAt: null, canceledAt: null } }],
        },
        resolvePrForIssue: () => null,
      }),
      { depends_on: [], depends_on_linear: [] },
    );
  });

  it('sorts PR and Linear dependencies deterministically', () => {
    assert.deepEqual(
      resolveDependencies({
        inverseRelations: {
          nodes: [
            inverseBlock('HOK-2000'),
            inverseBlock('HOK-1432'),
            inverseBlock('HOK-1999'),
          ],
        },
        resolvePrForIssue: (identifier) => {
          if (identifier === 'HOK-1432') {
            return 400;
          }
          if (identifier === 'HOK-2000') {
            return 12;
          }
          return null;
        },
      }),
      { depends_on: ['PR#12', 'PR#400'], depends_on_linear: ['HOK-1999'] },
    );
  });

  it('returns metadata fields that render directly into PR metadata', () => {
    const rendered = renderPrMetadata(
      resolveDependencies({
        inverseRelations: { nodes: [inverseBlock('HOK-1432')] },
        resolvePrForIssue: () => 400,
      }),
    );

    assert.equal(
      rendered,
      ['<!-- wavemill-meta', 'depends_on: ["PR#400"]', 'depends_on_linear: []', '-->'].join('\n'),
    );
  });
});
