/**
 * Stage 5 — cross-validation using the oracle's DUMPED fold indices (no re-splitting).
 * Per fold: fit CSP + LDA on train, score on test, exactly as the oracle did.
 */
import type { Epoch } from './epoch.ts';
import { fitCsp, cspLogVar } from './csp.ts';
import { fitLda, ldaPredict } from './lda.ts';

export interface CvParams {
  nComponents: number;
  reg: number;
  shrinkage: number;
}

export interface CvResult {
  perFoldAcc: number[];
  meanAcc: number;
}

/** A single fold: fit CSP+LDA on train epochs, return test accuracy. */
export function scoreFold(
  epochs: Epoch[],
  labels: number[],
  train: number[],
  test: number[],
  p: CvParams,
): number {
  const trainEpochs = train.map((i) => epochs[i]!);
  const trainLabels = train.map((i) => labels[i]!);
  const csp = fitCsp(trainEpochs, trainLabels, p.nComponents, p.reg);
  const lda = fitLda(cspLogVar(csp, trainEpochs), trainLabels, p.shrinkage);

  let correct = 0;
  for (const i of test) {
    const [feat] = cspLogVar(csp, [epochs[i]!]);
    if (ldaPredict(lda, feat!) === labels[i]) correct++;
  }
  return correct / test.length;
}

export function runCv(
  epochs: Epoch[],
  labels: number[],
  folds: { train: number[]; test: number[] }[],
  p: CvParams,
): CvResult {
  const perFoldAcc = folds.map((f) => scoreFold(epochs, labels, f.train, f.test, p));
  const meanAcc = perFoldAcc.reduce((s, a) => s + a, 0) / perFoldAcc.length;
  return { perFoldAcc, meanAcc };
}
