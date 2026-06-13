import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../src/pipeline/runPipeline.ts';
import { frobeniusNormDiff, pairedTTest } from '../../src/validation/metrics.ts';
import { CSP_FROBENIUS_MAX, TTEST_P_MIN } from '../../src/validation/tolerances.ts';
import { HAS_DATA, loadConcatenated, loadFixtures } from './_data.ts';

const d = HAS_DATA ? describe : describe.skip;

d('End-to-end — full TS pipeline reproduces the oracle', () => {
  it('runs filter→epoch→CSP→LDA→CV and matches the oracle CV accuracy', async () => {
    const { signals } = await loadConcatenated();
    const f = await loadFixtures();

    const progress: string[] = [];
    const result = await runPipeline(
      {
        signals,
        taps: f.params.filter.taps,
        startOffset: f.epochs.start_offset_samples,
        nTimes: f.params.epoch.n_times,
        eventSamples: f.epochs.event_samples,
        labels: f.epochs.labels,
        nComponents: f.params.csp.n_components,
        reg: f.params.csp.reg,
        shrinkage: f.params.lda.shrinkage,
        folds: f.foldIndices.folds,
      },
      (stage) => progress.push(stage),
    );

    expect(result.nEpochs).toBe(f.params.n_epochs);
    expect(frobeniusNormDiff(f.cspFilters.full, result.cspFilters)).toBeLessThan(CSP_FROBENIUS_MAX);
    expect(result.meanAcc).toBeCloseTo(f.cvAccuracy.mean, 10);
    expect(pairedTTest(result.perFoldAcc, f.cvAccuracy.per_fold).p).toBeGreaterThan(TTEST_P_MIN);
    // Async chunking emitted progress callbacks across stages.
    expect(progress).toContain('filter');
    expect(progress).toContain('cv');

    // eslint-disable-next-line no-console
    console.log(`E2E: meanAcc=${result.meanAcc} (oracle ${f.cvAccuracy.mean}), nEpochs=${result.nEpochs}`);
  });
});
