/**
 * Statistical utilities for logistic regression, correlation, and AUC computation.
 * Used by task-packet-signal-analyzer for adjusting packet features with confounding controls.
 *
 * @module stats-utils
 */

export interface ProportionInterval {
  p: number | null;
  lo: number | null;
  hi: number | null;
}

export function wilsonInterval(successes: number, n: number, z = 1.96): ProportionInterval {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || successes < 0 || n < 0 || successes > n) {
    throw new Error(`Invalid Wilson interval inputs: successes=${successes}, n=${n}`);
  }
  if (n === 0) {
    return { p: null, lo: null, hi: null };
  }

  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    p,
    lo: Math.max(0, (centre - margin) / denominator),
    hi: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * Standard normal cumulative distribution function (Φ).
 * Approximation via error function (Abramowitz & Stegun 7.1.26).
 */
export function normalCdf(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);

  const t = 1.0 / (1.0 + p * absZ);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(absZ * absZ));

  return 0.5 * (1.0 + sign * y);
}

export interface LogisticRegressionResult {
  /** Coefficients on standardized features */
  coefficients: number[];
  /** Intercept (on original scale) */
  intercept: number;
  /** Standardization parameters for inverse transform */
  standardization: {
    means: number[];
    stds: number[];
  };
  /** Wald standard errors for each coefficient */
  standardErrors: number[];
  /** Wald z-scores */
  zScores: number[];
  /** Two-tailed p-values for each coefficient */
  pValues: number[];
  /** Negative log-likelihood at convergence */
  logLikelihood: number;
  /** Whether the fit converged */
  converged: boolean;
  /** Number of iterations used */
  iterations: number;
}

/**
 * Fit a logistic regression model via Iteratively Reweighted Least Squares (Newton-Raphson).
 *
 * Standardizes features internally and returns coefficients on the standardized scale,
 * plus means/stds for replay. Adds small L2 ridge for numerical stability on small n.
 *
 * @param X Feature matrix (n × p)
 * @param y Binary labels (0/1), length n
 * @param opts Ridge penalty and convergence options
 */
export function fitLogisticRegression(
  X: number[][],
  y: number[],
  opts?: { l2?: number; maxIter?: number },
): LogisticRegressionResult {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const maxIter = opts?.maxIter ?? 100;
  const l2 = opts?.l2 ?? 0.01;

  if (n === 0 || p === 0) {
    throw new Error('X must be non-empty matrix');
  }
  if (y.length !== n) {
    throw new Error('y must match X row count');
  }

  // Standardize features
  const means = new Array<number>(p);
  const stds = new Array<number>(p);
  const X_std = X.map((row) =>
    row.map((val, j) => {
      if (means[j] === undefined) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          sum += X[i]![j]!;
        }
        means[j] = sum / n;
      }
      return val - means[j]!;
    }),
  );

  for (let j = 0; j < p; j++) {
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      sumSq += X_std[i]![j]! * X_std[i]![j]!;
    }
    stds[j] = Math.sqrt(sumSq / n);
    if (stds[j]! < 1e-10) stds[j] = 1;
    for (let i = 0; i < n; i++) {
      X_std[i]![j]! /= stds[j]!;
    }
  }

  // Gradient descent / Newton-Raphson
  let beta = new Array(p).fill(0);
  let intercept = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // Compute predictions
    const pred = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let eta = intercept;
      for (let j = 0; j < p; j++) {
        eta += X_std[i]![j]! * beta[j]!;
      }
      pred[i] = 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, eta))));
    }

    // Gradient
    const grad = new Array(p).fill(0);
    let gradIntercept = 0;
    let ll = 0;
    for (let i = 0; i < n; i++) {
      const residual = y[i]! - pred[i]!;
      gradIntercept += residual;
      for (let j = 0; j < p; j++) {
        grad[j]! += residual * X_std[i]![j]!;
      }
      ll += y[i]! * Math.log(Math.max(1e-10, pred[i]!)) + (1 - y[i]!) * Math.log(Math.max(1e-10, 1 - pred[i]!));
    }

    // Add L2 penalty to gradient
    for (let j = 0; j < p; j++) {
      grad[j]! -= l2 * beta[j]!;
    }

    // Hessian (diagonal approximation for speed)
    const hess = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const w = pred[i]! * (1 - pred[i]!);
      for (let j = 0; j < p; j++) {
        hess[j]! += w * X_std[i]![j]! * X_std[i]![j]!;
      }
    }

    // Newton step
    const step = 0.1; // line search
    const betaNew = beta.map((b, j) => b + (step * grad[j]!) / Math.max(1e-10, hess[j]! + l2));
    const interceptNew = intercept + (step * gradIntercept) / n;

    // Check convergence (more lenient)
    let maxGrad = Math.max(Math.abs(gradIntercept) / n, ...grad.map((g, j) => Math.abs(g) / Math.max(1e-10, hess[j]! + l2)));
    if (maxGrad < 0.1 && iter > 2) {
      beta = betaNew;
      intercept = interceptNew;
      return buildResult(beta, intercept, means, stds, X_std, y, l2, true, iter + 1);
    }

    beta = betaNew;
    intercept = interceptNew;
  }

  return buildResult(beta, intercept, means, stds, X_std, y, l2, false, maxIter);
}

function buildResult(
  beta: number[],
  intercept: number,
  means: number[],
  stds: number[],
  X_std: number[][],
  y: number[],
  l2: number,
  converged: boolean,
  iterations: number,
): LogisticRegressionResult {
  const n = X_std.length;
  const p = beta.length;

  // Compute predictions for Hessian
  let hessian = new Array(p).fill(0);
  let ll = 0;
  for (let i = 0; i < n; i++) {
    let eta = intercept;
    for (let j = 0; j < p; j++) {
      eta += X_std[i]![j]! * beta[j]!;
    }
    const pred = 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, eta))));
    const w = pred * (1 - pred);
    for (let j = 0; j < p; j++) {
      hessian[j]! += w * X_std[i]![j]! * X_std[i]![j]!;
    }
    ll += y[i]! * Math.log(Math.max(1e-10, pred)) + (1 - y[i]!) * Math.log(Math.max(1e-10, 1 - pred));
  }

  // Standard errors from inverse Hessian diagonal
  const standardErrors = hessian.map((h) => Math.sqrt(Math.max(1e-10, 1 / (h + l2))));
  const zScores = beta.map((b, j) => b / standardErrors[j]!);
  const pValues = zScores.map((z) => 2 * (1 - normalCdf(Math.abs(z))));

  return {
    coefficients: beta,
    intercept,
    standardization: { means, stds },
    standardErrors,
    zScores,
    pValues,
    logLikelihood: ll,
    converged,
    iterations,
  };
}

export interface WelchTTestResult {
  t: number;
  df: number;
  p: number;
}

/**
 * Welch's t-test for unequal variances. Two-tailed.
 */
export function welchTTest(a: number[], b: number[]): WelchTTestResult {
  const n1 = a.length;
  const n2 = b.length;

  if (n1 === 0 || n2 === 0) {
    return { t: 0, df: 0, p: 1 };
  }

  const mean1 = a.reduce((s, x) => s + x, 0) / n1;
  const mean2 = b.reduce((s, x) => s + x, 0) / n2;

  const var1 = a.reduce((s, x) => s + (x - mean1) * (x - mean1), 0) / (n1 - 1 || 1);
  const var2 = b.reduce((s, x) => s + (x - mean2) * (x - mean2), 0) / (n2 - 1 || 1);

  const se = Math.sqrt(var1 / n1 + var2 / n2);
  if (se === 0) {
    return { t: 0, df: 0, p: 1 };
  }

  const t = (mean1 - mean2) / se;

  // Welch-Satterthwaite equation for degrees of freedom
  const num = (var1 / n1 + var2 / n2) * (var1 / n1 + var2 / n2);
  const denom = (var1 / n1) * (var1 / n1) / (n1 - 1 || 1) + (var2 / n2) * (var2 / n2) / (n2 - 1 || 1);
  const df = denom > 0 ? num / denom : Math.max(n1, n2) - 1;

  // Approximate p-value using normal CDF (good for df > 30)
  const p = 2 * (1 - normalCdf(Math.abs(t)));

  return { t, df, p };
}

export interface PearsonResult {
  r: number;
  t: number;
  p: number;
}

/**
 * Pearson correlation coefficient and test. Two-tailed.
 */
export function pearson(x: number[], y: number[]): PearsonResult {
  const n = x.length;
  if (n < 3 || y.length !== n) {
    return { r: 0, t: 0, p: 1 };
  }

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let cov = 0,
    varX = 0,
    varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) {
    return { r: 0, t: 0, p: 1 };
  }

  const r = cov / Math.sqrt(varX * varY);
  const t = (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r + 1e-10);
  const p = 2 * (1 - normalCdf(Math.abs(t)));

  return { r, t, p };
}

/**
 * Compute area under ROC curve from scores and labels.
 * Higher score = higher predicted positive probability.
 *
 * Uses the Mann-Whitney U interpretation: AUC = P(score_pos > score_neg).
 */
export function auc(scores: number[], labels: number[]): number {
  const n = scores.length;
  if (n === 0) return 0.5;

  // Count positive and negative labels
  let nPos = 0,
    nNeg = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) nPos++;
    else nNeg++;
  }

  if (nPos === 0 || nNeg === 0) return 0.5;

  // Count concordant pairs: score_i > score_j where label_i=1, label_j=0
  let concordant = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) {
      for (let j = 0; j < n; j++) {
        if (labels[j] === 0) {
          if (scores[i]! > scores[j]!) {
            concordant++;
          }
        }
      }
    }
  }

  return concordant / (nPos * nNeg);
}

/**
 * Compute precision and recall at a fixed flag rate (threshold).
 */
export function precisionRecallAtThreshold(
  scores: number[],
  labels: number[],
  flagRate: number,
): {
  threshold: number;
  precision: number;
  recall: number;
} {
  const n = scores.length;
  if (n === 0) return { threshold: 0.5, precision: 0, recall: 0 };

  const pairs = scores.map((s, i) => ({ score: s, label: labels[i] })).sort((a, b) => b.score - a.score);

  const flagCount = Math.max(1, Math.ceil(n * flagRate));
  const threshold = pairs[flagCount - 1]?.score ?? 0;

  let tp = 0,
    fp = 0;
  for (let i = 0; i < flagCount; i++) {
    if (pairs[i]!.label === 1) tp++;
    else fp++;
  }

  let allPos = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) allPos++;
  }

  const precision = flagCount > 0 ? tp / flagCount : 0;
  const recall = allPos > 0 ? tp / allPos : 0;

  return { threshold, precision, recall };
}
