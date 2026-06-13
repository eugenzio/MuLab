import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../src/pipeline/runPipeline.ts';
import { filtfiltChannels } from '../../src/pipeline/filter.ts';
import { epochSignal } from '../../src/pipeline/epoch.ts';
import { fitCsp, cspLogVar } from '../../src/pipeline/csp.ts';
import { fitLda } from '../../src/pipeline/lda.ts';
import { pearsonR, frobeniusNormDiff } from '../../src/validation/metrics.ts';
import {
  PEARSON_R_MIN,
  CSP_FROBENIUS_MAX,
  LDA_WEIGHT_MAX,
  TTEST_P_MIN,
} from '../../src/validation/tolerances.ts';
import { pairedTTest } from '../../src/validation/metrics.ts';
import { availableSubjects, loadConcatenated, loadFixtures } from './_data.ts';

/**
 * Part A — multi-subject validation. For every subject the oracle validated, assert the
 * browser pipeline reproduces that subject's MNE fixtures at the SAME machine-precision
 * tolerances (no per-subject tuning). The claim is numerical equality (browser == oracle),
 * NOT accuracy — low/chance accuracy on some subjects is expected and not "fixed".
 */
const subjects = availableSubjects();
const d = subjects.length > 0 ? describe : describe.skip;

interface Row {
  subject: string;
  nEpochs: number;
  filterR: number;
  cspFrob: number;
  ldaDiff: number;
  cvMean: number;
  pass: boolean;
}
const table: Row[] = [];

d('Part A — browser pipeline == MNE oracle, per subject', () => {
  for (const subject of subjects) {
    it(`${subject}`, async () => {
      const { signals } = await loadConcatenated(subject);
      const f = await loadFixtures(subject);
      const taps = f.params.filter.taps;
      const off = f.epochs.start_offset_samples;
      const nTimes = f.params.epoch.n_times;

      // Stage 1+2: filter + epoch (for the filter pearson-r and CSP/LDA checks).
      const filtered = filtfiltChannels(taps, signals);
      const { epochs } = epochSignal(filtered, f.epochs.event_samples, off, nTimes);

      // Filter agreement (over the fixture's channel subset).
      let filterR = 1;
      let maxAbs = 0;
      const chIdx = f.filteredSubset.channel_indices;
      for (let e = 0; e < f.filteredSubset.data.length; e++) {
        const start = f.epochs.event_samples[f.filteredSubset.epoch_indices[e]!]! + off;
        for (let j = 0; j < chIdx.length; j++) {
          const ref = f.filteredSubset.data[e]![j]!;
          const ts = filtered[chIdx[j]!]!.subarray(start, start + nTimes);
          filterR = Math.min(filterR, pearsonR(ts, ref));
          for (let t = 0; t < nTimes; t++) maxAbs = Math.max(maxAbs, Math.abs(ts[t]! - ref[t]!));
        }
      }

      // CSP (full-data) agreement.
      const csp = fitCsp(epochs, f.epochs.labels, f.params.csp.n_components, f.params.csp.reg);
      const cspFrob = frobeniusNormDiff(f.cspFilters.full, csp.filters);

      // LDA per-fold weight agreement.
      let ldaDiff = 0;
      for (let fold = 0; fold < f.foldIndices.folds.length; fold++) {
        const train = f.foldIndices.folds[fold]!.train;
        const tEp = train.map((i) => epochs[i]!);
        const tLab = train.map((i) => f.epochs.labels[i]!);
        const m = fitCsp(tEp, tLab, f.params.csp.n_components, f.params.csp.reg);
        const lda = fitLda(cspLogVar(m, tEp), tLab, f.params.lda.shrinkage);
        const ref = f.ldaWeights.per_fold[fold]!;
        for (let k = 0; k < lda.coef.length; k++) ldaDiff = Math.max(ldaDiff, Math.abs(lda.coef[k]! - ref.coef[0]![k]!));
        ldaDiff = Math.max(ldaDiff, Math.abs(lda.intercept - ref.intercept[0]!));
      }

      // CV via the full pipeline (uses dumped folds).
      const result = await runPipeline({
        signals,
        taps,
        startOffset: off,
        nTimes,
        eventSamples: f.epochs.event_samples,
        labels: f.epochs.labels,
        nComponents: f.params.csp.n_components,
        reg: f.params.csp.reg,
        shrinkage: f.params.lda.shrinkage,
        folds: f.foldIndices.folds,
      });

      // Assertions: browser == oracle at machine precision (same tolerances for all subjects).
      expect(filterR).toBeGreaterThan(PEARSON_R_MIN);
      expect(maxAbs).toBeLessThan(1e-6);
      expect(cspFrob).toBeLessThan(CSP_FROBENIUS_MAX);
      expect(ldaDiff).toBeLessThan(LDA_WEIGHT_MAX);
      expect(result.nEpochs).toBe(f.params.n_epochs);
      for (let i = 0; i < f.cvAccuracy.per_fold.length; i++) {
        expect(result.perFoldAcc[i]!).toBeCloseTo(f.cvAccuracy.per_fold[i]!, 10);
      }
      expect(result.meanAcc).toBeCloseTo(f.cvAccuracy.mean, 10);
      expect(pairedTTest(result.perFoldAcc, f.cvAccuracy.per_fold).p).toBeGreaterThan(TTEST_P_MIN);

      table.push({
        subject,
        nEpochs: result.nEpochs,
        filterR,
        cspFrob,
        ldaDiff,
        cvMean: result.meanAcc,
        pass: true,
      });
    });
  }

  it('prints the per-subject validation table', () => {
    // eslint-disable-next-line no-console
    console.log(`\nPart A multi-subject validation (${table.length}/${subjects.length} subjects):`);
    for (const r of table.sort((a, b) => a.subject.localeCompare(b.subject))) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.subject}: nEpochs=${r.nEpochs} filterR=${r.filterR.toFixed(12)} ` +
          `cspFrob=${r.cspFrob.toExponential(2)} ldaDiff=${r.ldaDiff.toExponential(2)} ` +
          `cvMean=${r.cvMean.toFixed(4)} -> browser==oracle: ${r.pass ? 'PASS' : 'FAIL'}`,
      );
    }
    expect(table.length).toBe(subjects.length);
  });
});
