import { describe, it, expect } from 'vitest';
import { filtfiltChannels } from '../../src/pipeline/filter.ts';
import { epochSignal } from '../../src/pipeline/epoch.ts';
import { runCv } from '../../src/pipeline/cv.ts';
import { pairedTTest } from '../../src/validation/metrics.ts';
import { TTEST_P_MIN } from '../../src/validation/tolerances.ts';
import { HAS_DATA, loadConcatenated, loadFixtures } from './_data.ts';

const d = HAS_DATA ? describe : describe.skip;

d('Stage 5 — cross-validation reproduces the oracle accuracies', () => {
  it('matches per-fold + mean accuracy using the dumped folds', async () => {
    const { signals } = await loadConcatenated();
    const f = await loadFixtures();
    const filtered = filtfiltChannels(f.params.filter.taps, signals);
    const { epochs } = epochSignal(
      filtered,
      f.epochs.event_samples,
      f.epochs.start_offset_samples,
      f.params.epoch.n_times,
    );

    const result = runCv(epochs, f.epochs.labels, f.foldIndices.folds, {
      nComponents: f.params.csp.n_components,
      reg: f.params.csp.reg,
      shrinkage: f.params.lda.shrinkage,
    });

    // eslint-disable-next-line no-console
    console.log(
      `Stage 5 CV: ts per-fold=${JSON.stringify(result.perFoldAcc)} mean=${result.meanAcc} | ` +
        `oracle per-fold=${JSON.stringify(f.cvAccuracy.per_fold)} mean=${f.cvAccuracy.mean}`,
    );

    // Exact per-fold match (same folds + same deterministic algorithm).
    for (let i = 0; i < f.cvAccuracy.per_fold.length; i++) {
      expect(result.perFoldAcc[i]!).toBeCloseTo(f.cvAccuracy.per_fold[i]!, 10);
    }
    expect(result.meanAcc).toBeCloseTo(f.cvAccuracy.mean, 10);

    // Statistical equivalence (p > 0.05). Identical vectors ⇒ p = 1.
    const { p } = pairedTTest(result.perFoldAcc, f.cvAccuracy.per_fold);
    expect(p).toBeGreaterThan(TTEST_P_MIN);
  });
});
