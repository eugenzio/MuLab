/**
 * Stage 3 — CSP, replicating the oracle's EXPLICIT algorithm (params.notes), not a library CSP.
 *
 *   - Per-class shrinkage covariance on concatenated trials (assume_centered=True):
 *       emp = M·Mᵀ / n_samples;  cov = (1−reg)·emp + reg·(trace(emp)/n)·I
 *   - Generalized eigenproblem eigh(cov_left, cov_left+cov_right), reduced via Cholesky:
 *       C = L·Lᵀ;  M = L⁻¹·cov_left·L⁻ᵀ (symmetric);  EVD M = V·Λ·Vᵀ;  w = L⁻ᵀ·V
 *     → C-orthonormal generalized eigenvectors, matching scipy.linalg.eigh's normalization.
 *   - Ascending eigenvalues; select alternating from both ends [hi, lo, hi−1, lo+1, …].
 *   - Features = log mean-power of projected signals.
 */
import { Matrix, CholeskyDecomposition, EigenvalueDecomposition, inverse } from 'ml-matrix';
import type { Epoch } from './epoch.ts';

/** Concatenate a class's epochs along time → Matrix (n_channels × n_trials·n_times). */
function concatClass(epochs: Epoch[], indices: number[], nChannels: number, nTimes: number): Matrix {
  const cols = indices.length * nTimes;
  const out = new Matrix(nChannels, cols);
  let c = 0;
  for (const e of indices) {
    const epoch = epochs[e]!;
    for (let ch = 0; ch < nChannels; ch++) {
      const row = epoch[ch]!;
      for (let t = 0; t < nTimes; t++) out.set(ch, c + t, row[t]!);
    }
    c += nTimes;
  }
  return out;
}

/** Shrinkage covariance of M (n_ch × n_samples), assume_centered=True. */
export function shrunkCovariance(m: Matrix, reg: number): Matrix {
  const n = m.rows;
  const nSamples = m.columns;
  const emp = m.mmul(m.transpose()).div(nSamples); // n_ch × n_ch
  let trace = 0;
  for (let i = 0; i < n; i++) trace += emp.get(i, i);
  const mu = trace / n;
  const cov = emp.mul(1 - reg);
  for (let i = 0; i < n; i++) cov.set(i, i, cov.get(i, i) + reg * mu);
  return cov;
}

export interface CspModel {
  /** Spatial filters as rows: (n_components × n_channels). */
  filters: number[][];
}

/**
 * Fit explicit CSP. `epochs` indexed by `labels` (values 1 and 2). Returns n_components
 * spatial filters (rows), ordered alternating from both ends of the ascending spectrum.
 */
export function fitCsp(
  epochs: Epoch[],
  labels: number[],
  nComponents: number,
  reg: number,
): CspModel {
  const nChannels = epochs[0]!.length;
  const nTimes = epochs[0]![0]!.length;
  const idxLeft: number[] = [];
  const idxRight: number[] = [];
  for (let i = 0; i < labels.length; i++) (labels[i] === 1 ? idxLeft : idxRight).push(i);

  const covL = shrunkCovariance(concatClass(epochs, idxLeft, nChannels, nTimes), reg);
  const covR = shrunkCovariance(concatClass(epochs, idxRight, nChannels, nTimes), reg);
  const composite = Matrix.add(covL, covR);

  // Cholesky reduction of the generalized problem eigh(covL, composite).
  const L = new CholeskyDecomposition(composite).lowerTriangularMatrix; // L·Lᵀ = composite
  const Linv = inverse(L);
  let M = Linv.mmul(covL).mmul(Linv.transpose());
  M = M.add(M.transpose()).div(2); // symmetrize against round-off

  const evd = new EigenvalueDecomposition(M, { assumeSymmetric: true });
  const eigvals = evd.realEigenvalues;
  const V = evd.eigenvectorMatrix; // columns are eigenvectors

  // Sort columns by ascending eigenvalue.
  const order = eigvals.map((_, i) => i).sort((a, b) => eigvals[a]! - eigvals[b]!);
  // Generalized eigenvectors W = L⁻ᵀ·V (columns), reordered ascending.
  const W = Linv.transpose().mmul(V);

  // Alternate selection from both ends: [hi, lo, hi−1, lo+1, …].
  const n = order.length;
  const picks: number[] = [];
  let lo = 0;
  let hi = n - 1;
  while (picks.length < n) {
    picks.push(order[hi]!);
    hi--;
    if (picks.length < n) {
      picks.push(order[lo]!);
      lo++;
    }
  }
  const selected = picks.slice(0, nComponents);
  const filters = selected.map((col) => W.getColumn(col));
  return { filters };
}

/** Log mean-power CSP features: per epoch, log(mean_t((filters·X)²)). → (n_epochs × n_components). */
export function cspLogVar(model: CspModel, epochs: Epoch[]): number[][] {
  const filters = model.filters;
  const nComp = filters.length;
  const out: number[][] = [];
  for (const epoch of epochs) {
    const nTimes = epoch[0]!.length;
    const feat = new Array<number>(nComp);
    for (let k = 0; k < nComp; k++) {
      const f = filters[k]!;
      let sumSq = 0;
      for (let t = 0; t < nTimes; t++) {
        let p = 0;
        for (let ch = 0; ch < f.length; ch++) p += f[ch]! * epoch[ch]![t]!;
        sumSq += p * p;
      }
      feat[k] = Math.log(sumSq / nTimes);
    }
    out.push(feat);
  }
  return out;
}
