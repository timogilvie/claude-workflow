import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectFirstWave, type QueuePlan } from './plan-queue-utils.ts';

const basePlan: QueuePlan = {
  availableNow: ['HOK-4', 'HOK-2', 'HOK-3', 'HOK-1'],
  queuedAfterDependencies: [],
  avoidRunningTogether: [['HOK-2', 'HOK-3']],
  needsTriage: [],
};

describe('selectFirstWave', () => {
  it('packs the first wave by score while enforcing shared-surface exclusions', () => {
    const result = selectFirstWave(
      basePlan,
      [
        { id: 'HOK-1', score: 40 },
        { id: 'HOK-2', score: 90 },
        { id: 'HOK-3', score: 85 },
        { id: 'HOK-4', score: 70 },
      ],
      { maxParallel: 3 },
    );

    assert.deepEqual(result, {
      wave: ['HOK-2', 'HOK-4', 'HOK-1'],
      deferred: ['HOK-3'],
    });
  });

  it('uses task id ordering to break equal-score ties deterministically', () => {
    const result = selectFirstWave(
      {
        ...basePlan,
        availableNow: ['HOK-10', 'HOK-2', 'HOK-1'],
        avoidRunningTogether: [],
      },
      [
        { id: 'HOK-10', score: 50 },
        { id: 'HOK-2', score: 50 },
        { id: 'HOK-1', score: 50 },
      ],
      { maxParallel: 2 },
    );

    assert.deepEqual(result, {
      wave: ['HOK-1', 'HOK-2'],
      deferred: ['HOK-10'],
    });
  });

  it('defaults missing scores to zero without overriding dependency-safe availability', () => {
    const result = selectFirstWave(
      {
        ...basePlan,
        availableNow: ['HOK-5', 'HOK-6'],
        avoidRunningTogether: [],
      },
      [{ id: 'HOK-6', score: 10 }],
      { maxParallel: 2 },
    );

    assert.deepEqual(result, {
      wave: ['HOK-6', 'HOK-5'],
      deferred: [],
    });
  });

  it('returns all available tasks as deferred when maxParallel is zero', () => {
    const result = selectFirstWave(basePlan, [], { maxParallel: 0 });
    assert.deepEqual(result, { wave: [], deferred: ['HOK-4', 'HOK-2', 'HOK-3', 'HOK-1'] });
  });

  it('rejects invalid queue plans and parallel limits', () => {
    assert.throws(
      () => selectFirstWave({ ...basePlan, availableNow: undefined as unknown as string[] }, [], { maxParallel: 1 }),
      /availableNow/,
    );
    assert.throws(() => selectFirstWave(basePlan, [], { maxParallel: -1 }), /maxParallel/);
  });
});
