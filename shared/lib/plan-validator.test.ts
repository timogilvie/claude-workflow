/**
 * Tests for plan-validator.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlanOutput,
  priorityToNumber,
  type PlanOutput,
} from './plan-validator.ts';

describe('validatePlanOutput', () => {
  test('validates a complete valid plan', () => {
    const validPlan: PlanOutput = {
      epic_summary: 'Implement authentication system',
      milestones: [
        {
          name: 'Foundation',
          issues: [
            {
              title: 'Setup auth database',
              user_story: 'As a user, I want secure storage for credentials',
              description: 'Create users table with bcrypt hashing',
              dependencies: [],
              priority: 'P0',
            },
          ],
        },
      ],
    };

    assert.equal(validatePlanOutput(validPlan), true);
  });

  test('rejects null or undefined', () => {
    assert.equal(validatePlanOutput(null), false);
    assert.equal(validatePlanOutput(undefined), false);
  });

  test('rejects non-object', () => {
    assert.equal(validatePlanOutput('string'), false);
    assert.equal(validatePlanOutput(123), false);
    assert.equal(validatePlanOutput([]), false);
  });

  test('rejects missing epic_summary', () => {
    const plan = {
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects non-string epic_summary', () => {
    const plan = {
      epic_summary: 123,
      milestones: [],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects missing milestones', () => {
    const plan = {
      epic_summary: 'Summary',
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects empty milestones array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects milestone without name', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects milestone without issues', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects milestone with empty issues array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects issue without title', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects issue without description', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('rejects issue without dependencies array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), false);
  });

  test('accepts empty dependencies array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), true);
  });

  test('accepts multiple milestones and issues', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
            {
              title: 'T2',
              description: 'D2',
              dependencies: [0],
            },
          ],
        },
        {
          name: 'M2',
          issues: [
            {
              title: 'T3',
              description: 'D3',
              dependencies: [0, 1],
            },
          ],
        },
      ],
    };
    assert.equal(validatePlanOutput(plan), true);
  });
});

describe('priorityToNumber', () => {
  test('converts P0 to 1 (Urgent)', () => {
    assert.equal(priorityToNumber('P0'), 1);
  });

  test('converts P1 to 2 (High)', () => {
    assert.equal(priorityToNumber('P1'), 2);
  });

  test('converts P2 to 3 (Normal)', () => {
    assert.equal(priorityToNumber('P2'), 3);
  });

  test('converts P3 to 4 (Low)', () => {
    assert.equal(priorityToNumber('P3'), 4);
  });

  test('defaults unknown priority to 3 (Normal)', () => {
    assert.equal(priorityToNumber('P4'), 3);
    assert.equal(priorityToNumber('Unknown'), 3);
    assert.equal(priorityToNumber(''), 3);
  });

  test('is case-sensitive', () => {
    assert.equal(priorityToNumber('p0'), 3); // lowercase not recognized, defaults to Normal
  });
});
