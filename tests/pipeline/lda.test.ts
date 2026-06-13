import { describe, it, expect } from 'vitest';
import { filtfiltChannels } from '../../src/pipeline/filter.ts';
import { epochSignal } from '../../src/pipeline/epoch.ts';
import { fitCsp, cspLogVar } from '../../src/pipeline/csp.ts';
import { fitLda } from '../../src/pipeline/lda.ts';
import { LDA_WEIGHT_MAX } from '../../src/validation/tolerances.ts';
import { HAS_DATA, loadConcatenated, loadFixtures } from './_data.ts';

const d = HAS_DATA ? describe : describe.skip;

d('Stage 4 — LDA matches the oracle (lda_weights)', () => {
  it('reproduces per-fold LDA coef/intercept within LDA_WEIGHT_MAX', async () => {
    const { signals } = await loadConcatenated();
    const f = await loadFixtures();
    const filtered = filtfiltChannels(f.params.filter.taps, signals);
    const { epochs } = epochSignal(
      filtered,
      f.epochs.event_samples,
      f.epochs.start_offset_samples,
      f.params.epoch.n_times,
    );
    const labels = f.epochs.labels;

    let maxDiff = 0;
    for (let fold = 0; fold < f.foldIndices.folds.length; fold++) {
      const train = f.foldIndices.folds[fold]!.train;
      const trainEpochs = train.map((i) => epochs[i]!);
      const trainLabels = train.map((i) => labels[i]!);

      const csp = fitCsp(trainEpochs, trainLabels, f.params.csp.n_components, f.params.csp.reg);
      const feats = cspLogVar(csp, trainEpochs);
      const lda = fitLda(feats, trainLabels, f.params.lda.shrinkage);

      const ref = f.ldaWeights.per_fold[fold]!;
      // Oracle stores binary-collapsed coef as [[...]] and intercept as [scalar].
      const refCoef = ref.coef[0]!;
      for (let j = 0; j < lda.coef.length; j++) {
        maxDiff = Math.max(maxDiff, Math.abs(lda.coef[j]! - refCoef[j]!));
      }
      maxDiff = Math.max(maxDiff, Math.abs(lda.intercept - ref.intercept[0]!));
    }

    // eslint-disable-next-line no-console
    console.log(`Stage 4 LDA: max |weight/bias diff| vs oracle = ${maxDiff}`);
    expect(maxDiff).toBeLessThan(LDA_WEIGHT_MAX);
  });
});
