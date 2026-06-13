import { describe, it, expect } from 'vitest';
import { filtfiltChannels } from '../../src/pipeline/filter.ts';
import { pearsonR } from '../../src/validation/metrics.ts';
import { PEARSON_R_MIN } from '../../src/validation/tolerances.ts';
import { HAS_DATA, loadConcatenated, loadFixtures } from './_data.ts';

const d = HAS_DATA ? describe : describe.skip;

d('Stage 1 — filtfilt matches the MNE oracle (filtered_subset)', () => {
  it('reproduces the dumped filtered epochs to machine precision', async () => {
    const { signals } = await loadConcatenated();
    const f = await loadFixtures();
    const taps = f.params.filter.taps;
    const off = f.epochs.start_offset_samples;
    const nTimes = f.params.epoch.n_times;

    // Filter the full continuous signal, then slice the same epochs the fixture dumped.
    const filtered = filtfiltChannels(taps, signals);

    let minR = 1;
    let maxAbs = 0;
    const subset = f.filteredSubset.data; // [n_epochs][n_subset_ch][n_times]
    const chIdx = f.filteredSubset.channel_indices;
    for (let e = 0; e < subset.length; e++) {
      const start = f.epochs.event_samples[f.filteredSubset.epoch_indices[e]!]! + off;
      for (let j = 0; j < chIdx.length; j++) {
        const ref = subset[e]![j]!;
        const ts = filtered[chIdx[j]!]!.subarray(start, start + nTimes);
        minR = Math.min(minR, pearsonR(ts, ref));
        for (let t = 0; t < nTimes; t++) maxAbs = Math.max(maxAbs, Math.abs(ts[t]! - ref[t]!));
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Stage 1 filter: min pearsonR=${minR}, max abs diff=${maxAbs} µV`);
    expect(minR).toBeGreaterThan(PEARSON_R_MIN);
    expect(minR).toBeGreaterThan(0.99999);
    // Absolute check: CSP later is scale-sensitive, so units must match, not just shape.
    expect(maxAbs).toBeLessThan(1e-6);
  });
});
