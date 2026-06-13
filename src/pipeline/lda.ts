/**
 * Stage 4 — LDA, replicating sklearn LinearDiscriminantAnalysis(solver='lsqr', shrinkage=0.1).
 *
 * For each class: cov_k = shrunk(empirical_covariance(X_k)), where empirical_covariance
 * centers per class and divides by n_k (biased MLE); shrunk(emp) = (1−s)·emp + s·(tr/F)·I.
 * Pooled covariance = Σ prior_k · cov_k. Then coef_k = cov⁻¹·mean_k,
 * intercept_k = −0.5·mean_kᵀ·coef_k + log(prior_k). Binary collapse: coef = coef_1 − coef_0,
 * intercept = intercept_1 − intercept_0 (classes sorted ascending: [1=left, 2=right]).
 * decision = coef·x + intercept; decision > 0 ⇒ class 2 (right), else class 1 (left).
 */
import { Matrix, solve } from 'ml-matrix';

export interface LdaModel {
  /** Binary-collapsed weight vector (length n_features). */
  coef: number[];
  /** Binary-collapsed bias. */
  intercept: number;
}

const CLASSES = [1, 2] as const;

export function fitLda(features: number[][], labels: number[], shrinkage: number): LdaModel {
  const nFeat = features[0]!.length;
  const n = features.length;

  const coefByClass: number[][] = [];
  const interceptByClass: number[] = [];
  const means: number[][] = [];
  const priors: number[] = [];

  // Pooled shrinkage covariance Σ prior_k · cov_k.
  const cov = Matrix.zeros(nFeat, nFeat);
  for (const cls of CLASSES) {
    const rows = features.filter((_, i) => labels[i] === cls);
    const nk = rows.length;
    const mean = new Array<number>(nFeat).fill(0);
    for (const r of rows) for (let j = 0; j < nFeat; j++) mean[j]! += r[j]!;
    for (let j = 0; j < nFeat; j++) mean[j]! /= nk;
    means.push(mean);
    priors.push(nk / n);

    // empirical_covariance: center then Xcᵀ·Xc / nk.
    const emp = Matrix.zeros(nFeat, nFeat);
    for (const r of rows) {
      for (let a = 0; a < nFeat; a++) {
        const da = r[a]! - mean[a]!;
        for (let b = 0; b < nFeat; b++) emp.set(a, b, emp.get(a, b) + da * (r[b]! - mean[b]!));
      }
    }
    emp.div(nk);
    // shrink: (1−s)·emp + s·(trace/F)·I.
    let trace = 0;
    for (let i = 0; i < nFeat; i++) trace += emp.get(i, i);
    const mu = trace / nFeat;
    for (let a = 0; a < nFeat; a++) {
      for (let b = 0; b < nFeat; b++) {
        let v = (1 - shrinkage) * emp.get(a, b);
        if (a === b) v += shrinkage * mu;
        cov.set(a, b, cov.get(a, b) + priors[priors.length - 1]! * v);
      }
    }
  }

  // coef_k = cov⁻¹·mean_k  (solve cov · coef = mean_k).
  for (let k = 0; k < CLASSES.length; k++) {
    const meanCol = Matrix.columnVector(means[k]!);
    const coefCol = solve(cov, meanCol).to1DArray();
    coefByClass.push(coefCol);
    let quad = 0;
    for (let j = 0; j < nFeat; j++) quad += means[k]![j]! * coefCol[j]!;
    interceptByClass.push(-0.5 * quad + Math.log(priors[k]!));
  }

  const coef = coefByClass[1]!.map((v, j) => v - coefByClass[0]![j]!);
  const intercept = interceptByClass[1]! - interceptByClass[0]!;
  return { coef, intercept };
}

/** Decision value coef·x + intercept. */
export function ldaDecision(model: LdaModel, x: number[]): number {
  let s = model.intercept;
  for (let j = 0; j < x.length; j++) s += model.coef[j]! * x[j]!;
  return s;
}

/** Predicted class label (1 or 2). */
export function ldaPredict(model: LdaModel, x: number[]): number {
  return ldaDecision(model, x) > 0 ? 2 : 1;
}
