import { describe, it, expect } from 'vitest';
import { filtfiltChannels } from '../../src/pipeline/filter.ts';
import { epochSignal, extractT12Events } from '../../src/pipeline/epoch.ts';
import { pearsonR } from '../../src/validation/metrics.ts';
import { HAS_DATA, loadConcatenated, loadFixtures } from './_data.ts';

const d = HAS_DATA ? describe : describe.skip;

d('Stage 2 — epoching matches the oracle', () => {
  it('produces 45 epochs (23 left / 22 right) aligned to the fixture epochs', async () => {
    const { signals, runLengths, runAnnotations, sampleRateHz } = await loadConcatenated();
    const f = await loadFixtures();
    const taps = f.params.filter.taps;
    const off = f.epochs.start_offset_samples;
    const nTimes = f.params.epoch.n_times;

    const filtered = filtfiltChannels(taps, signals);
    const { epochs } = epochSignal(filtered, f.epochs.event_samples, off, nTimes);

    // Counts + labels.
    expect(epochs.length).toBe(f.params.n_epochs); // 45
    const labels = f.epochs.labels;
    expect(labels.filter((l) => l === 1).length).toBe(23);
    expect(labels.filter((l) => l === 2).length).toBe(22);
    expect(epochs[0]!.length).toBe(f.params.n_channels);
    expect(epochs[0]![0]!.length).toBe(nTimes);

    // Parser-derived events match the dumped event_samples (validates parser→event path).
    const derived = extractT12Events(runAnnotations, runLengths, sampleRateHz);
    expect(derived.length).toBe(f.epochs.event_samples.length);
    expect(derived.map((e) => e.sample)).toEqual(f.epochs.event_samples);
    expect(derived.map((e) => e.label)).toEqual(labels);

    // The two fixture-dumped epochs match sample-for-sample.
    let minR = 1;
    const chIdx = f.filteredSubset.channel_indices;
    for (let e = 0; e < f.filteredSubset.data.length; e++) {
      const epIdx = f.filteredSubset.epoch_indices[e]!;
      for (let j = 0; j < chIdx.length; j++) {
        minR = Math.min(minR, pearsonR(epochs[epIdx]![chIdx[j]!]!, f.filteredSubset.data[e]![j]!));
      }
    }
    expect(minR).toBeGreaterThan(0.999);
  });
});
