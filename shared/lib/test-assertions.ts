import assert from 'node:assert/strict';

type Containable = string | readonly unknown[];

function contains(actual: Containable, expected: unknown): boolean {
  return typeof actual === 'string'
    ? actual.includes(String(expected))
    : actual.includes(expected);
}

/**
 * Small Node-assertion adapter for legacy tests while they use the repository's
 * node:test runner. Keep this intentionally limited to the assertions already
 * used by those tests rather than introducing another test framework.
 */
export function expect(actual: unknown) {
  const assertions = {
    toBe(expected: unknown) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepStrictEqual(actual, expected);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toContain(expected: unknown) {
      assert.ok(
        (typeof actual === 'string' || Array.isArray(actual)) && contains(actual, expected),
        `Expected ${String(actual)} to contain ${String(expected)}`,
      );
    },
    toHaveLength(expected: number) {
      assert.ok(actual !== null && actual !== undefined && 'length' in Object(actual));
      assert.strictEqual((actual as { length: number }).length, expected);
    },
    toHaveProperty(expected: string) {
      assert.ok(actual !== null && actual !== undefined && expected in Object(actual));
    },
    toBeGreaterThan(expected: number) {
      assert.ok(typeof actual === 'number' && actual > expected);
    },
    toBeLessThan(expected: number) {
      assert.ok(typeof actual === 'number' && actual < expected);
    },
    toBeLessThanOrEqual(expected: number) {
      assert.ok(typeof actual === 'number' && actual <= expected);
    },
    toThrow() {
      assert.ok(typeof actual === 'function');
      assert.throws(actual);
    },
  };

  return {
    ...assertions,
    not: {
      toBe(expected: unknown) {
        assert.notStrictEqual(actual, expected);
      },
      toBeNull() {
        assert.notStrictEqual(actual, null);
      },
      toContain(expected: unknown) {
        assert.ok(
          (typeof actual === 'string' || Array.isArray(actual)) && !contains(actual, expected),
          `Expected ${String(actual)} not to contain ${String(expected)}`,
        );
      },
    },
    resolves: {
      async toBe(expected: unknown) {
        assert.strictEqual(await actual, expected);
      },
    },
  };
}
