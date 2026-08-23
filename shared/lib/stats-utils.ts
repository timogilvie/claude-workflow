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
