import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLinearDependencies } from './linear-dependency-resolver.ts';
import type { LinearIssue } from './linear.ts';

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'HOK-1',
    title: 'Test issue',
    state: { name: 'In Progress' },
    labels: { nodes: [] },
    team: { id: 't1', name: 'Hokusai', key: 'HOK' },
    ...overrides,
  };
}

function blockerNode(
  identifier: string,
  opts: { completedAt?: string | null; canceledAt?: string | null; type?: string } = {},
) {
  return {
    type: opts.type ?? 'blocks',
    issue: {
      id: `id-${identifier}`,
      identifier,
      completedAt: opts.completedAt ?? null,
      canceledAt: opts.canceledAt ?? null,
    },
  };
}

describe('resolveLinearDependencies', () => {
  it('resolves blocker to PR when resolvePr returns a number', async () => {
    const issue = makeIssue({
      inverseRelations: { nodes: [blockerNode('HOK-100')] },
    });

    const result = await resolveLinearDependencies(issue, () => 123);

    assert.deepEqual(result.dependsOn, ['PR#123']);
    assert.deepEqual(result.dependsOnLinear, []);
  });

  it('falls back to dependsOnLinear when resolvePr returns null', async () => {
    const issue = makeIssue({
      inverseRelations: { nodes: [blockerNode('HOK-100')] },
    });

    const result = await resolveLinearDependencies(issue, () => null);

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, ['HOK-100']);
  });

  it('excludes blockers with completedAt set', async () => {
    const issue = makeIssue({
      inverseRelations: {
        nodes: [blockerNode('HOK-100', { completedAt: '2026-01-01T00:00:00Z' })],
      },
    });

    const result = await resolveLinearDependencies(issue, () => 123);

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, []);
  });

  it('excludes blockers with canceledAt set', async () => {
    const issue = makeIssue({
      inverseRelations: {
        nodes: [blockerNode('HOK-100', { canceledAt: '2026-01-01T00:00:00Z' })],
      },
    });

    const result = await resolveLinearDependencies(issue, () => 123);

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, []);
  });

  it('handles mixed: resolved, unresolved, and canceled blockers', async () => {
    const issue = makeIssue({
      inverseRelations: {
        nodes: [
          blockerNode('HOK-200'),
          blockerNode('HOK-201'),
          blockerNode('HOK-202', { canceledAt: '2026-01-01T00:00:00Z' }),
        ],
      },
    });

    const resolvePr = (id: string) => (id === 'HOK-200' ? 42 : null);
    const result = await resolveLinearDependencies(issue, resolvePr);

    assert.deepEqual(result.dependsOn, ['PR#42']);
    assert.deepEqual(result.dependsOnLinear, ['HOK-201']);
  });

  it('returns empty arrays when no relations exist', async () => {
    const issue = makeIssue();

    const result = await resolveLinearDependencies(issue, () => 123);

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, []);
  });

  it('returns empty arrays when inverseRelations is empty', async () => {
    const issue = makeIssue({ inverseRelations: { nodes: [] } });

    const result = await resolveLinearDependencies(issue, () => 123);

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, []);
  });

  it('falls back to dependsOnLinear when resolvePr throws', async () => {
    const issue = makeIssue({
      inverseRelations: { nodes: [blockerNode('HOK-100')] },
    });

    const result = await resolveLinearDependencies(issue, () => {
      throw new Error('network error');
    });

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, ['HOK-100']);
  });

  it('deduplicates identical identifiers', async () => {
    const issue = makeIssue({
      inverseRelations: {
        nodes: [blockerNode('HOK-100'), blockerNode('HOK-100')],
      },
    });

    const result = await resolveLinearDependencies(issue, () => 42);

    assert.deepEqual(result.dependsOn, ['PR#42']);
    assert.deepEqual(result.dependsOnLinear, []);
  });

  it('ignores non-blocks relation types', async () => {
    const issue = makeIssue({
      inverseRelations: {
        nodes: [
          blockerNode('HOK-100', { type: 'duplicate' }),
          blockerNode('HOK-101', { type: 'related' }),
        ],
      },
    });

    const result = await resolveLinearDependencies(issue, () => 123);

    assert.deepEqual(result.dependsOn, []);
    assert.deepEqual(result.dependsOnLinear, []);
  });
});
