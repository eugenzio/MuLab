/**
 * Validation metrics comparing a TS pipeline output against the MNE oracle fixtures.
 *
 * Phase 2 builds and unit-tests these functions; Phase 3 will feed real TS-pipeline
 * outputs through them. Pure (no I/O), so they run anywhere.
 */

/** Pearson correlation coefficient between two equal-length numeric sequences. */
export function pearsonR(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`pearsonR: length mismatch ${a.length} vs ${b.length}`);
  const n = a.length;
  if (n === 0) throw new Error('pearsonR: empty input');
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  if (den === 0) return da === 0 && db === 0 ? 1 : 0; // both constant ⇒ define r=1
  return num / den;
}

// --------------------------------------------------------------------------- //
// CSP matrix comparison — handles component sign + ordering ambiguity.
// --------------------------------------------------------------------------- //

function dot(u: number[], v: number[]): number {
  let s = 0;
  for (let i = 0; i < u.length; i++) s += u[i]! * v[i]!;
  return s;
}
function norm(u: number[]): number {
  return Math.sqrt(dot(u, u));
}

export interface CspAlignment {
  /** permutation[i] = index of the impl row matched to oracle row i. */
  permutation: number[];
  /** signs[i] ∈ {+1,-1}: sign applied to the matched impl row to align with oracle row i. */
  signs: number[];
}

/**
 * Align impl CSP rows to oracle CSP rows.
 *
 * CSP components carry an arbitrary sign (an eigenvector and its negation are both
 * valid) and their ordering can differ between implementations. Alignment rule
 * (documented in ASSUMPTIONS.md):
 *   1. Greedy one-to-one match: for each oracle row (in order), pick the still-unused
 *      impl row with the largest |cosine similarity|.
 *   2. Sign: flip the matched impl row by sign(cosine) so it points the same way.
 * Magnitude is NOT rescaled — generalized eigenvectors share a fixed scale, so a real
 * magnitude difference should surface in the Frobenius norm rather than be hidden.
 */
export function alignCsp(oracle: number[][], impl: number[][]): CspAlignment {
  if (oracle.length !== impl.length) {
    throw new Error(`alignCsp: row count mismatch ${oracle.length} vs ${impl.length}`);
  }
  const used = new Array<boolean>(impl.length).fill(false);
  const permutation: number[] = [];
  const signs: number[] = [];
  for (const oRow of oracle) {
    let bestJ = -1;
    let bestAbsCos = -1;
    let bestSign = 1;
    for (let j = 0; j < impl.length; j++) {
      if (used[j]) continue;
      const denom = norm(oRow) * norm(impl[j]!);
      const cos = denom === 0 ? 0 : dot(oRow, impl[j]!) / denom;
      if (Math.abs(cos) > bestAbsCos) {
        bestAbsCos = Math.abs(cos);
        bestJ = j;
        bestSign = cos < 0 ? -1 : 1;
      }
    }
    used[bestJ] = true;
    permutation.push(bestJ);
    signs.push(bestSign);
  }
  return { permutation, signs };
}

/**
 * Frobenius norm of (oracle − aligned impl) for CSP matrices, after sign+order
 * alignment. Rows are spatial filters; both matrices must be (n_components × n_channels).
 */
export function frobeniusNormDiff(oracle: number[][], impl: number[][]): number {
  const { permutation, signs } = alignCsp(oracle, impl);
  let sum = 0;
  for (let i = 0; i < oracle.length; i++) {
    const oRow = oracle[i]!;
    const iRow = impl[permutation[i]!]!;
    const s = signs[i]!;
    for (let k = 0; k < oRow.length; k++) {
      const d = oRow[k]! - s * iRow[k]!;
      sum += d * d;
    }
  }
  return Math.sqrt(sum);
}

// --------------------------------------------------------------------------- //
// Paired t-test (two-tailed) over per-fold accuracies.
// --------------------------------------------------------------------------- //

/** Lanczos approximation of ln Γ(x). */
function gammaln(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export interface PairedTTestResult {
  t: number;
  df: number;
  /** Two-tailed p-value. */
  p: number;
}

/**
 * Paired two-tailed t-test over per-fold accuracies. p > TTEST_P_MIN ⇒ the two
 * accuracy vectors are statistically equivalent. Identical inputs ⇒ t=0, p=1.
 */
export function pairedTTest(a: number[], b: number[]): PairedTTestResult {
  if (a.length !== b.length) throw new Error('pairedTTest: length mismatch');
  const n = a.length;
  if (n < 2) throw new Error('pairedTTest: need at least 2 paired samples');
  const diffs = a.map((v, i) => v - b[i]!);
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  let ss = 0;
  for (const d of diffs) ss += (d - mean) * (d - mean);
  const sd = Math.sqrt(ss / (n - 1)); // sample std (ddof=1)
  const df = n - 1;
  if (sd === 0) {
    // No variance in the differences.
    return mean === 0 ? { t: 0, df, p: 1 } : { t: Infinity, df, p: 0 };
  }
  const t = mean / (sd / Math.sqrt(n));
  const p = betai(df / 2, 0.5, df / (df + t * t)); // two-tailed
  return { t, df, p };
}
