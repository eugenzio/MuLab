/**
 * Full pipeline orchestrator: filter → epoch → CSP → LDA → CV.
 *
 * Pure and environment-agnostic (no DOM/Worker imports) so vitest can run it directly in
 * Node; the Web Worker (pipeline.worker.ts) is a thin wrapper. Heavy loops yield to the
 * event loop via async chunking so the worker thread stays responsive.
 */
import { filtfilt } from './filter.ts';
import { epochSignal } from './epoch.ts';
import { fitCsp, cspLogVar } from './csp.ts';
import { fitLda, type LdaModel } from './lda.ts';
import { runCv } from './cv.ts';

export interface PipelineInput {
  /** Concatenated continuous signal, one Float64Array per channel (µV). */
  signals: Float64Array[];
  taps: number[];
  startOffset: number;
  nTimes: number;
  eventSamples: number[];
  labels: number[];
  nComponents: number;
  reg: number;
  shrinkage: number;
  folds: { train: number[]; test: number[] }[];
}

export interface PipelineResult {
  nEpochs: number;
  /** Full-data CSP filters (n_components × n_channels). */
  cspFilters: number[][];
  /** Full-data LDA model. */
  lda: LdaModel;
  perFoldAcc: number[];
  meanAcc: number;
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export interface ProgressFn {
  (stage: string, fraction: number): void;
}

export async function runPipeline(
  input: PipelineInput,
  onProgress: ProgressFn = () => {},
): Promise<PipelineResult> {
  const { signals, taps, startOffset, nTimes, eventSamples, labels } = input;

  // Stage 1 — filter (chunked over channels to keep the worker responsive).
  const filtered: Float64Array[] = new Array(signals.length);
  const CHUNK = 8;
  for (let c = 0; c < signals.length; c++) {
    filtered[c] = filtfilt(taps, signals[c]!);
    if (c % CHUNK === CHUNK - 1) {
      onProgress('filter', (c + 1) / signals.length);
      await yieldToLoop();
    }
  }

  // Stage 2 — epoch.
  const { epochs } = epochSignal(filtered, eventSamples, startOffset, nTimes);
  onProgress('epoch', 1);
  await yieldToLoop();

  // Full-data CSP + LDA (for reporting the fitted model).
  const csp = fitCsp(epochs, labels, input.nComponents, input.reg);
  const lda = fitLda(cspLogVar(csp, epochs), labels, input.shrinkage);
  onProgress('csp+lda', 1);
  await yieldToLoop();

  // Stage 5 — CV over the dumped folds (chunked).
  const perFoldAcc: number[] = [];
  const cvParams = { nComponents: input.nComponents, reg: input.reg, shrinkage: input.shrinkage };
  for (let i = 0; i < input.folds.length; i++) {
    const { perFoldAcc: acc } = runCv(epochs, labels, [input.folds[i]!], cvParams);
    perFoldAcc.push(acc[0]!);
    onProgress('cv', (i + 1) / input.folds.length);
    await yieldToLoop();
  }
  const meanAcc = perFoldAcc.reduce((s, a) => s + a, 0) / perFoldAcc.length;

  return { nEpochs: epochs.length, cspFilters: csp.filters, lda, perFoldAcc, meanAcc };
}
