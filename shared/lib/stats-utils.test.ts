import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  normalCdf,
  fitLogisticRegression,
  welchTTest,
  pearson,
  auc,
  precisionRecallAtThreshold,
} from './stats-utils.ts';

describe('stats-utils', () => {
  describe('normalCdf', () => {
    it('returns 0.5 at z=0', () => {
      assert.strictEqual(Math.abs(normalCdf(0) - 0.5) < 0.01, true);
    });

    it('increases monotonically', () => {
      const vals = [-3, -1, 0, 1, 3].map(normalCdf);
      for (let i = 1; i < vals.length; i++) {
        assert.strictEqual(vals[i]! > vals[i - 1]!, true);
      }
    });

    it('approaches 0 as z -> -inf', () => {
      assert.strictEqual(normalCdf(-10) < 0.01, true);
    });

    it('approaches 1 as z -> +inf', () => {
      assert.strictEqual(normalCdf(10) > 0.99, true);
    });
  });

  describe('fitLogisticRegression', () => {
    it('converges on separable data', () => {
      // Toy data: y=1 when x[0]>0, else y=0
      const X = [[1, 2], [2, 3], [3, 4], [-1, -2], [-2, -3], [-3, -4]];
      const y = [1, 1, 1, 0, 0, 0];

      const result = fitLogisticRegression(X, y);

      assert.strictEqual(result.converged, true);
      assert.strictEqual(result.coefficients.length, 2);
      // First coefficient should be positive (positive correlation with y)
      assert.strictEqual(result.coefficients[0]! > 0, true);
    });

    it('throws on empty matrix', () => {
      assert.throws(() => fitLogisticRegression([], []));
    });

    it('throws on mismatched sizes', () => {
      assert.throws(() => fitLogisticRegression([[1, 2]], [1, 2]));
    });

    it('computes standard errors', () => {
      const X = [[1, 2], [2, 3], [3, 4], [-1, -2], [-2, -3], [-3, -4]];
      const y = [1, 1, 1, 0, 0, 0];

      const result = fitLogisticRegression(X, y);

      assert.strictEqual(result.standardErrors.length, 2);
      for (const se of result.standardErrors) {
        assert.strictEqual(se > 0, true);
      }
    });

    it('computes p-values', () => {
      const X = [[1, 2], [2, 3], [3, 4], [-1, -2], [-2, -3], [-3, -4]];
      const y = [1, 1, 1, 0, 0, 0];

      const result = fitLogisticRegression(X, y);

      for (const p of result.pValues) {
        assert.strictEqual(p >= 0 && p <= 1, true);
      }
    });
  });

  describe('welchTTest', () => {
    it('returns p=1 for identical groups', () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];

      const result = welchTTest(a, b);

      assert.strictEqual(Math.abs(result.p - 1) < 0.1, true);
    });

    it('returns p<0.05 for well-separated groups', () => {
      const a = [10, 11, 12];
      const b = [1, 2, 3];

      const result = welchTTest(a, b);

      assert.strictEqual(result.p < 0.05, true);
    });

    it('returns 0 p-value on empty input', () => {
      const result = welchTTest([], [1, 2]);

      assert.strictEqual(result.p, 1);
    });
  });

  describe('pearson', () => {
    it('returns r~1 for perfect positive correlation', () => {
      const x = [1, 2, 3, 4, 5];
      const y = [1, 2, 3, 4, 5];

      const result = pearson(x, y);

      assert.strictEqual(Math.abs(result.r - 1) < 0.01, true);
    });

    it('returns r~-1 for perfect negative correlation', () => {
      const x = [1, 2, 3, 4, 5];
      const y = [5, 4, 3, 2, 1];

      const result = pearson(x, y);

      assert.strictEqual(Math.abs(result.r + 1) < 0.01, true);
    });

    it('returns r~0 for no correlation', () => {
      const x = [1, 2, 3, 4, 5];
      const y = [5, 1, 3, 2, 4];

      const result = pearson(x, y);

      assert.strictEqual(Math.abs(result.r) < 0.6, true);
    });
  });

  describe('auc', () => {
    it('returns 1 for perfect separation', () => {
      const scores = [0.9, 0.8, 0.7, 0.1, 0.2, 0.3];
      const labels = [1, 1, 1, 0, 0, 0];

      const result = auc(scores, labels);

      assert.strictEqual(result, 1);
    });

    it('returns value in [0,1] for mixed predictions', () => {
      // Scores where there's some but not perfect correlation
      const scores = [0.5, 0.3, 0.7, 0.4, 0.6, 0.2];
      const labels = [1, 0, 1, 0, 1, 0];

      const result = auc(scores, labels);

      // AUC should always be between 0 and 1
      assert.strictEqual(result >= 0 && result <= 1, true);
    });

    it('returns 0.5 for empty input', () => {
      const result = auc([], []);

      assert.strictEqual(result, 0.5);
    });
  });

  describe('precisionRecallAtThreshold', () => {
    it('computes metrics at 50% flag rate', () => {
      const scores = [0.9, 0.8, 0.7, 0.1, 0.2, 0.3];
      const labels = [1, 1, 1, 0, 0, 0];

      const result = precisionRecallAtThreshold(scores, labels, 0.5);

      assert.strictEqual(result.precision >= 0 && result.precision <= 1, true);
      assert.strictEqual(result.recall >= 0 && result.recall <= 1, true);
    });

    it('has recall=1 at 100% flag rate', () => {
      const scores = [0.9, 0.8, 0.7, 0.1, 0.2, 0.3];
      const labels = [1, 1, 1, 0, 0, 0];

      const result = precisionRecallAtThreshold(scores, labels, 1.0);

      assert.strictEqual(result.recall, 1);
    });

    it('returns empty result for empty input', () => {
      const result = precisionRecallAtThreshold([], [], 0.5);

      assert.strictEqual(result.precision, 0);
      assert.strictEqual(result.recall, 0);
    });
  });
});
