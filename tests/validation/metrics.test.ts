import { describe, it, expect } from 'vitest';
import { pearsonR, alignCsp, frobeniusNormDiff, pairedTTest } from '../../src/validation/metrics.ts';

describe('pearsonR', () => {
  it('is 1 for identical arrays', () => {
    const a = [1, 2, 3, 4, 5];
    expect(pearsonR(a, a)).toBeCloseTo(1, 12);
  });

  it('is 1 under positive affine transform, -1 under negation', () => {
    const a = [1, 2, 3, 4, 5];
    const scaledShifted = a.map((v) => 3 * v + 7);
    expect(pearsonR(a, scaledShifted)).toBeCloseTo(1, 12);
    expect(pearsonR(a, a.map((v) => -v))).toBeCloseTo(-1, 12);
  });

  it('matches a hand-computed value', () => {
    // r for [1,2,3] vs [1,3,2] = 0.5
    expect(pearsonR([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 12);
  });

  it('throws on length mismatch', () => {
    expect(() => pearsonR([1, 2], [1, 2, 3])).toThrow();
  });
});

describe('frobeniusNormDiff / alignCsp (CSP sign + order ambiguity)', () => {
  const A = [
    [1, 0, 0],
    [0, 2, 0],
    [0, 0, 3],
  ];

  it('is 0 for identical matrices', () => {
    expect(frobeniusNormDiff(A, A)).toBeCloseTo(0, 12);
  });

  it('is ~0 when components are permuted and sign-flipped', () => {
    // Reorder rows (2,0,1) and flip some signs — same CSP up to ambiguity.
    const B = [
      [0, 0, -3], // = -A[2]
      [1, 0, 0], //  =  A[0]
      [0, -2, 0], // = -A[1]
    ];
    const { permutation, signs } = alignCsp(A, B);
    expect(permutation).toEqual([1, 2, 0]);
    expect(signs).toEqual([1, -1, -1]);
    expect(frobeniusNormDiff(A, B)).toBeCloseTo(0, 12);
  });

  it('reflects a genuine magnitude difference', () => {
    const B = A.map((row) => row.map((v) => v + (v !== 0 ? 0.1 : 0)));
    // Three nonzero entries each off by 0.1 → sqrt(3*0.01) ≈ 0.17320508
    expect(frobeniusNormDiff(A, B)).toBeCloseTo(Math.sqrt(3 * 0.01), 10);
  });
});

describe('pairedTTest (two-tailed)', () => {
  it('identical accuracy vectors → t=0, p=1', () => {
    const acc = [0.7, 0.8, 0.9, 0.6, 0.75];
    const r = pairedTTest(acc, acc);
    expect(r.t).toBe(0);
    expect(r.df).toBe(4);
    expect(r.p).toBeCloseTo(1, 12);
  });

  it('large consistent difference → small p (not equivalent)', () => {
    const a = [0.9, 0.92, 0.88, 0.91, 0.89];
    const b = [0.5, 0.52, 0.48, 0.51, 0.49];
    const r = pairedTTest(a, b);
    expect(r.p).toBeLessThan(0.05);
  });

  it('tiny noise → large p (equivalent)', () => {
    const a = [0.7, 0.8, 0.9, 0.6, 0.75];
    const b = [0.701, 0.799, 0.9, 0.6, 0.7505];
    const r = pairedTTest(a, b);
    expect(r.p).toBeGreaterThan(0.05);
  });

  it('matches scipy for a known sample', () => {
    // scipy.stats.ttest_rel([1,2,3,4,5],[1,2,3,4,6]) → t=-1, p=0.37390096
    const r = pairedTTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 6]);
    expect(r.t).toBeCloseTo(-1, 6);
    expect(r.p).toBeCloseTo(0.37390096, 6);
  });
});
